/**
 * Sync engine - orchestrates fetching RSS feeds, discovering episodes,
 * and pulling transcripts from Podscribe sources.
 */

import {
  CompositeTranscriptAdapter,
  PodscribeAdapter,
  RSSTranscriptAdapter,
} from "./adapters/podscribe-adapter.js";
import { parseFeed } from "./adapters/rss-parser.js";
import type { PodcastDatabase } from "./storage/database.js";
import type { PodcastConfig, SyncResult } from "./types/index.js";

export interface SyncOptions {
  /** Max episodes to process per podcast (newest first) */
  maxEpisodesPerFeed?: number;
  /** Max transcript fetches per podcast per sync run */
  maxTranscriptFetches?: number;
  /** Whether to attempt transcript fetching */
  fetchTranscripts?: boolean;
  /** Delay between transcript fetches in ms (be nice to servers) */
  fetchDelayMs?: number;
  /** Log progress to console */
  verbose?: boolean;
}

const DEFAULT_OPTIONS: Required<SyncOptions> = {
  maxEpisodesPerFeed: 100,
  maxTranscriptFetches: 10,
  fetchTranscripts: true,
  fetchDelayMs: 1000,
  verbose: true,
};

function log(verbose: boolean, ...args: unknown[]): void {
  if (verbose) console.log(...args);
}

export async function syncPodcast(
  podcast: PodcastConfig,
  db: PodcastDatabase,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const result: SyncResult = {
    podcastId: podcast.id,
    newEpisodes: 0,
    updatedEpisodes: 0,
    newTranscripts: 0,
    errors: [],
  };

  log(opts.verbose, `\nSyncing: ${podcast.name} (${podcast.id})`);

  // Ensure podcast is registered in DB
  db.upsertPodcast(podcast);

  // 1. Parse RSS feed
  let feedData;
  try {
    feedData = await parseFeed(podcast);
    log(
      opts.verbose,
      `  Found ${feedData.episodes.length} episodes in RSS feed`
    );
  } catch (err) {
    const msg = `Failed to parse feed: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    log(opts.verbose, `  ERROR: ${msg}`);
    return result;
  }

  // 2. Limit to N newest episodes
  const episodes = feedData.episodes.slice(0, opts.maxEpisodesPerFeed);

  // 3. Upsert episodes into DB
  const { newCount, updatedCount } = db.upsertEpisodes(episodes);
  result.newEpisodes = newCount;
  result.updatedEpisodes = updatedCount;
  log(
    opts.verbose,
    `  Episodes: ${newCount} new, ${updatedCount} updated`
  );

  // 4. Fetch transcripts for episodes that don't have them
  if (opts.fetchTranscripts) {
    const adapter = new CompositeTranscriptAdapter([
      new RSSTranscriptAdapter(feedData.transcriptUrls),
      new PodscribeAdapter(),
    ]);

    const missing = db.getEpisodesMissingTranscripts(
      podcast.id,
      opts.maxTranscriptFetches
    );
    log(
      opts.verbose,
      `  Fetching transcripts for ${missing.length} episodes...`
    );

    for (const episode of missing) {
      try {
        const transcript = await adapter.fetchTranscript(episode, podcast);
        if (transcript) {
          db.setTranscript(
            podcast.id,
            episode.guid,
            transcript,
            episode.transcriptSource ?? "unknown"
          );
          result.newTranscripts++;
          log(
            opts.verbose,
            `    ✓ Transcript: "${episode.title}" (via ${episode.transcriptSource})`
          );
        }
      } catch (err) {
        const msg = `Transcript fetch failed for "${episode.title}": ${
          err instanceof Error ? err.message : String(err)
        }`;
        result.errors.push(msg);
      }

      // Rate limiting
      if (opts.fetchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.fetchDelayMs));
      }
    }
  }

  db.markSynced(podcast.id);
  log(
    opts.verbose,
    `  Done: ${result.newTranscripts} new transcripts, ${result.errors.length} errors`
  );

  return result;
}

export async function syncAll(
  podcasts: PodcastConfig[],
  db: PodcastDatabase,
  options: SyncOptions = {}
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  for (const podcast of podcasts) {
    const result = await syncPodcast(podcast, db, options);
    results.push(result);
  }

  return results;
}
