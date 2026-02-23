#!/usr/bin/env node

/**
 * CLI for the podcast listener system.
 * Provides commands for syncing, searching, and querying the podcast knowledge base.
 */

import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDbPath, loadPodcastConfig } from "../config.js";
import { PodcastDatabase } from "../storage/database.js";
import { QueryEngine } from "../agent/query-engine.js";
import { syncAll, syncPodcast, type SyncOptions } from "../sync.js";
import { requestAndPollTranscripts } from "../request-transcripts.js";
import type { PodcastConfig } from "../types/index.js";
import { formatSpeakerBlocks, formatWithTimestamps } from "../utils/format-transcript.js";

function parseIntArg(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`Expected a number, got "${value}"`);
  return n;
}

const program = new Command();

program
  .name("podscribe-listener")
  .description(
    "Podcast listener and knowledge base via Podscribe.\n" +
      "Syncs podcast feeds, fetches transcripts, and provides a searchable knowledge base."
  )
  .version("1.0.0");

// ---- sync ----
program
  .command("sync")
  .description("Sync podcast feeds and fetch transcripts")
  .option("-c, --config <path>", "Path to podcasts.json config file")
  .option("-p, --podcast <id>", "Sync only a specific podcast by ID")
  .option("--max-episodes <n>", "Max episodes per feed (default: all)", parseIntArg)
  .option("--max-transcripts <n>", "Max transcript fetches per podcast (default: all)", parseIntArg)
  .option("--no-transcripts", "Skip transcript fetching, only sync metadata")
  .option("--concurrency <n>", "Concurrent Podscribe API requests (default: 5)", parseIntArg)
  .option("--status-cooldown <hours>", "Hours before re-checking NotStarted episodes (default: 24)", parseIntArg)
  .option("--quiet", "Suppress verbose output")
  .action(async (opts) => {
    const podcasts = loadPodcastConfig(opts.config);
    const db = new PodcastDatabase(getDbPath());

    try {
      const syncOpts: SyncOptions = {
        fetchTranscripts: opts.transcripts !== false,
        verbose: !opts.quiet,
      };
      if (opts.maxEpisodes !== undefined) {
        syncOpts.maxEpisodesPerFeed = opts.maxEpisodes as number;
      }
      if (opts.maxTranscripts !== undefined) {
        syncOpts.maxTranscriptFetches = opts.maxTranscripts as number;
      }
      if (opts.concurrency !== undefined) {
        syncOpts.concurrency = opts.concurrency as number;
      }
      if (opts.statusCooldown !== undefined) {
        syncOpts.statusCooldownMs = (opts.statusCooldown as number) * 60 * 60 * 1000;
      }

      if (opts.podcast) {
        const target = podcasts.find((p) => p.id === opts.podcast);
        if (!target) {
          console.error(`Podcast "${opts.podcast}" not found in config.`);
          console.error(
            `Available: ${podcasts.map((p) => p.id).join(", ")}`
          );
          process.exit(1);
        }
        await syncPodcast(target, db, syncOpts);
      } else {
        console.log(`Syncing ${podcasts.length} podcast(s)...\n`);
        const results = await syncAll(podcasts, db, syncOpts);

        console.log("\n=== Sync Summary ===");
        let totalNew = 0;
        let totalTranscripts = 0;
        let totalErrors = 0;
        for (const r of results) {
          totalNew += r.newEpisodes;
          totalTranscripts += r.newTranscripts;
          totalErrors += r.errors.length;
        }
        console.log(`New episodes:    ${totalNew}`);
        console.log(`New transcripts: ${totalTranscripts}`);
        console.log(`Errors:          ${totalErrors}`);
      }
    } finally {
      db.close();
    }
  });

// ---- search ----
program
  .command("search <query>")
  .description("Search across all podcast transcripts and metadata")
  .option("-p, --podcast <ids>", "Filter by podcast IDs (comma-separated)")
  .option("-t, --tag <tags>", "Filter by tags (comma-separated)")
  .option("--after <date>", "Only episodes after this date (YYYY-MM-DD)")
  .option("--before <date>", "Only episodes before this date (YYYY-MM-DD)")
  .option("-n, --limit <n>", "Max results", parseIntArg, 10)
  .option("--json", "Output as JSON")
  .action((query: string, opts) => {
    const db = new PodcastDatabase(getDbPath());

    try {
      const engine = new QueryEngine(db);
      const result = engine.search({
        query,
        podcastIds: opts.podcast?.split(","),
        tags: opts.tag?.split(","),
        after: opts.after,
        before: opts.before,
        limit: opts.limit as number,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.answer);
      console.log();

      for (const [i, source] of result.sources.entries()) {
        const date = source.publishedAt.split("T")[0];
        console.log(`${i + 1}. [${source.podcastName}] "${source.episodeTitle}" (${date})`);
        const snippet = source.snippet
          .replace(/>>>>/g, "\x1b[1m")
          .replace(/<<<</, "\x1b[0m");
        console.log(`   ${snippet}`);
        if (source.episodeUrl) {
          console.log(`   ${source.episodeUrl}`);
        }
        console.log();
      }
    } finally {
      db.close();
    }
  });

// ---- context ----
program
  .command("context <topic>")
  .description(
    "Get formatted context about a topic for injection into an LLM prompt"
  )
  .option("-n, --limit <n>", "Max sources", parseIntArg, 5)
  .action((topic: string, opts) => {
    const db = new PodcastDatabase(getDbPath());

    try {
      const engine = new QueryEngine(db);
      console.log(engine.getContextForTopic(topic, opts.limit as number));
    } finally {
      db.close();
    }
  });

// ---- stats ----
program
  .command("stats")
  .description("Show knowledge base statistics")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = new PodcastDatabase(getDbPath());

    try {
      const engine = new QueryEngine(db);

      if (opts.json) {
        console.log(JSON.stringify(engine.getStats(), null, 2));
        return;
      }

      console.log(engine.getKnowledgeBaseSummary());
    } finally {
      db.close();
    }
  });

// ---- episodes ----
program
  .command("episodes <podcast-id>")
  .description("List episodes for a podcast")
  .option("-n, --limit <n>", "Max episodes to show", parseIntArg, 20)
  .option("--transcripts-only", "Only show episodes with transcripts")
  .option("--json", "Output as JSON")
  .action((podcastId: string, opts) => {
    const db = new PodcastDatabase(getDbPath());

    try {
      const engine = new QueryEngine(db);
      const episodes = engine.getRecentEpisodes(podcastId, opts.limit as number);

      if (opts.json) {
        console.log(JSON.stringify(episodes, null, 2));
        return;
      }

      if (episodes.length === 0) {
        console.log(
          `No episodes found for "${podcastId}". Run 'sync' first.`
        );
        return;
      }

      console.log(`Episodes for ${podcastId}:\n`);
      for (const ep of episodes) {
        const date = ep.publishedAt.split("T")[0];
        const marker = ep.hasTranscript ? "[T]" : "[ ]";
        console.log(`  ${marker} ${date} - ${ep.title}`);
      }
      console.log(`\n[T] = has transcript, [ ] = no transcript`);
    } finally {
      db.close();
    }
  });

// ---- transcript ----
program
  .command("transcript <episode-id>")
  .description("Print the full transcript for an episode (by database ID)")
  .option("--structured", "Output structured word-level data as JSON")
  .option("--speakers", "Format with speaker labels and time ranges")
  .option("--timestamps", "Format with periodic timestamp markers")
  .action((episodeId: string, opts: { structured?: boolean; speakers?: boolean; timestamps?: boolean }) => {
    const db = new PodcastDatabase(getDbPath());

    try {
      const engine = new QueryEngine(db);
      const id = parseInt(episodeId, 10);

      if (opts.structured || opts.speakers || opts.timestamps) {
        const words = engine.getStructuredTranscript(id);
        if (!words) {
          console.error(`No structured transcript data for episode ID ${episodeId}`);
          process.exit(1);
        }
        if (opts.structured) {
          console.log(JSON.stringify(words, null, 2));
        } else if (opts.speakers) {
          console.log(formatSpeakerBlocks(words));
        } else {
          console.log(formatWithTimestamps(words));
        }
        return;
      }

      const transcript = engine.getTranscript(id);
      if (!transcript) {
        console.error(`No transcript found for episode ID ${episodeId}`);
        process.exit(1);
      }
      console.log(transcript);
    } finally {
      db.close();
    }
  });

// ---- podscribe-set ----
program
  .command("podscribe-set <podcast-id> <series-id>")
  .description(
    "Set the Podscribe series ID for a podcast.\n" +
      "Find the series ID on app.podscribe.com — it's the number in the URL.\n" +
      "Example: podscribe-set lex-fridman 123"
  )
  .option("-c, --config <path>", "Path to podcasts.json config file")
  .action((podcastId: string, seriesId: string, opts) => {
    const configPath = resolve(opts.config ?? "podcasts.json");
    const podcasts = loadPodcastConfig(opts.config);

    const target = podcasts.find((p) => p.id === podcastId);
    if (!target) {
      console.error(`Podcast "${podcastId}" not found in config.`);
      console.error(
        `Available: ${podcasts.map((p) => p.id).join(", ")}`
      );
      process.exit(1);
    }

    target.podscribeSeriesId = seriesId;
    writeFileSync(configPath, JSON.stringify(podcasts, null, 2));
    console.log(`✓ Set podscribeSeriesId="${seriesId}" for ${target.name} (${podcastId})`);
    console.log(`  Config saved to ${configPath}`);
  });

// ---- request-transcripts ----
program
  .command("request-transcripts")
  .description(
    "Request Podscribe transcripts for episodes that need them.\n" +
      "Uses a queue-based system: requests are rate-limited, then each episode\n" +
      "independently waits and checks back for its transcript."
  )
  .option("-p, --podcast <ids>", "Filter by podcast IDs (comma-separated)")
  .option("--max-requests <n>", "Max episodes to request (default: all)", parseIntArg)
  .option("--check-delay <seconds>", "Seconds to wait before checking back (default: 240)", parseIntArg)
  .option("--concurrency <n>", "Concurrent API requests (default: 5)", parseIntArg)
  .option("--retry", "Retry: check and download transcripts for previously requested episodes")
  .option("--quiet", "Suppress verbose output")
  .action(async (opts) => {
    const db = new PodcastDatabase(getDbPath());

    try {
      const result = await requestAndPollTranscripts(db, {
        podcastIds: opts.podcast?.split(","),
        maxRequests: opts.maxRequests as number | undefined,
        checkDelayMs: opts.checkDelay ? (opts.checkDelay as number) * 1000 : undefined,
        concurrency: opts.concurrency as number | undefined,
        retry: opts.retry as boolean | undefined,
        verbose: !opts.quiet,
      });

      console.log("\n=== Request Summary ===");
      console.log(`Requested:        ${result.requested}`);
      console.log(`Downloaded:       ${result.downloaded}`);
      console.log(`Still processing: ${result.stillProcessing}`);
      console.log(`Failed:           ${result.failed}`);
      if (result.errors.length > 0) {
        console.log(`\nErrors:`);
        for (const e of result.errors) console.log(`  - ${e}`);
      }
    } finally {
      db.close();
    }
  });

program.parse();
