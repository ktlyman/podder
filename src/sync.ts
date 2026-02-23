/**
 * Sync engine - orchestrates fetching RSS feeds, discovering episodes,
 * and pulling transcripts from Podscribe sources.
 *
 * Uses a 3-phase pipeline for Podscribe-indexed podcasts:
 *   Phase A: Prefetch — parse RSS, match episodes to Podscribe series
 *   Phase B: Status check — batch-check transcript availability (concurrent)
 *   Phase C: Download — fetch ready transcripts (concurrent)
 *
 * Non-Podscribe episodes fall back to the sequential adapter chain.
 */

import {
  CompositeTranscriptAdapter,
  PodscribeAdapter,
  RSSTranscriptAdapter,
} from "./adapters/podscribe-adapter.js";
import {
  PodscribeApiAdapter,
  fetchEpisodeDetail,
  fetchPodscribeSeriesEpisodes,
  fetchTranscriptText,
  requestTranscription,
  resetTranscription,
  type PodscribeEpisodeInfo,
  type PodscribeStatusResult,
} from "./adapters/podscribe-api-adapter.js";
import { getPodscribeAuthToken } from "./adapters/podscribe-auth.js";
import { parseFeed } from "./adapters/rss-parser.js";
import type { PodcastDatabase } from "./storage/database.js";
import type { Episode, PodcastConfig, SyncProgressCallback, SyncResult, TranscriptAdapter } from "./types/index.js";
import { pooledMap } from "./utils/concurrency.js";

export interface SyncOptions {
  /** Max episodes to process per podcast (newest first) */
  maxEpisodesPerFeed?: number;
  /** Max transcript fetches per podcast per sync run */
  maxTranscriptFetches?: number;
  /** Whether to attempt transcript fetching */
  fetchTranscripts?: boolean;
  /** Delay between sequential transcript fetches in ms (non-Podscribe fallback) */
  fetchDelayMs?: number;
  /** Log progress to console */
  verbose?: boolean;
  /** Concurrency for Podscribe API calls (default: 5) */
  concurrency?: number;
  /** Delay between concurrent task starts in ms (default: 200) */
  concurrentDelayMs?: number;
  /** Cooldown before re-checking Podscribe status in ms (default: 24h) */
  statusCooldownMs?: number;
  /** Optional callback for real-time progress reporting (SSE) */
  onProgress?: SyncProgressCallback;
}

const DEFAULT_OPTIONS = {
  maxEpisodesPerFeed: Infinity,
  maxTranscriptFetches: Infinity,
  fetchTranscripts: true,
  fetchDelayMs: 1000,
  verbose: true,
  concurrency: 5,
  concurrentDelayMs: 200,
  statusCooldownMs: 24 * 60 * 60 * 1000,
} satisfies Required<Omit<SyncOptions, "onProgress">>;

function log(verbose: boolean, ...args: unknown[]): void {
  if (verbose) console.log(...args);
}

export async function syncPodcast(
  podcast: PodcastConfig,
  db: PodcastDatabase,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const emit = opts.onProgress;
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

  // ============================================================
  // Phase A: Prefetch — RSS parse + Podscribe series matching
  // ============================================================

  emit?.({ type: "phase:start", podcastId: podcast.id, phase: "feed", total: 0, message: "Parsing RSS feed" });

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
    emit?.({ type: "sync:error", podcastId: podcast.id, message: msg });
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

  // 4. Podscribe API prefetch: match episodes and store Podscribe metadata
  const episodeMap = new Map<string, PodscribeEpisodeInfo>();
  if (podcast.podscribeSeriesId) {
    try {
      const podscribeEpisodes = await fetchPodscribeSeriesEpisodes(
        podcast.podscribeSeriesId
      );
      log(
        opts.verbose,
        `  Podscribe: found ${podscribeEpisodes.length} episodes for series ${podcast.podscribeSeriesId}`
      );

      // Index Podscribe episodes by GUID and by normalized title
      const podByGuid = new Map<string, typeof podscribeEpisodes[0]>();
      const podByTitle = new Map<string, typeof podscribeEpisodes[0]>();
      for (const pe of podscribeEpisodes) {
        if (pe.guid) podByGuid.set(pe.guid, pe);
        if (pe.title) podByTitle.set(pe.title.toLowerCase().trim(), pe);
      }

      // Match RSS episodes to Podscribe episodes by GUID first, then title
      let guidMatches = 0;
      let titleMatches = 0;
      for (const ep of episodes) {
        let pe = podByGuid.get(ep.guid);
        if (pe) {
          guidMatches++;
        } else {
          pe = podByTitle.get(ep.title.toLowerCase().trim());
          if (pe) titleMatches++;
        }
        if (!pe) continue;

        const info: PodscribeEpisodeInfo = {
          podscribeId: pe.id,
          podscribeUrl: `https://app.podscribe.com/episode/${pe.id}`,
        };
        episodeMap.set(ep.guid, info);

        // Store Podscribe metadata in DB (keyed by RSS GUID)
        db.setPodscribeInfo(podcast.id, ep.guid, pe.id, info.podscribeUrl);
      }
      log(
        opts.verbose,
        `  Podscribe: matched ${guidMatches + titleMatches} episodes (${guidMatches} by GUID, ${titleMatches} by title)`
      );

      // Backfill: insert Podscribe episodes that the RSS feed truncated
      const rssGuids = new Set(episodes.map((e) => e.guid));
      const rssTitles = new Set(episodes.map((e) => e.title.toLowerCase().trim()));
      const backfillEpisodes: Episode[] = [];

      for (const pe of podscribeEpisodes) {
        // Skip if already matched to an RSS episode
        if (pe.guid && rssGuids.has(pe.guid)) continue;
        if (pe.title && rssTitles.has(pe.title.toLowerCase().trim())) continue;

        const ep: Episode = {
          podcastId: podcast.id,
          guid: pe.guid || `podscribe-${pe.id}`,
          title: pe.title,
          description: pe.description ?? "",
          publishedAt: pe.uploadedAt,
          durationSeconds: pe.duration ?? undefined,
          audioUrl: pe.url ?? undefined,
          podscribeEpisodeId: pe.id,
          podscribeUrl: `https://app.podscribe.com/episode/${pe.id}`,
        };
        backfillEpisodes.push(ep);

        // Also add to the episode map for transcript fetching
        const info: PodscribeEpisodeInfo = {
          podscribeId: pe.id,
          podscribeUrl: `https://app.podscribe.com/episode/${pe.id}`,
        };
        episodeMap.set(ep.guid, info);
      }

      if (backfillEpisodes.length > 0) {
        const { newCount: backfillNew } = db.upsertEpisodes(backfillEpisodes);
        result.newEpisodes += backfillNew;
        log(
          opts.verbose,
          `  Podscribe backfill: ${backfillNew} episodes beyond RSS feed cap`
        );
      }
    } catch (err) {
      const msg = `Podscribe API prefetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      result.errors.push(msg);
      log(opts.verbose, `  WARNING: ${msg}`);
    }
  }

  emit?.({ type: "phase:complete", podcastId: podcast.id, phase: "feed", summary: `${result.newEpisodes} new, ${result.updatedEpisodes} updated episodes` });

  if (!opts.fetchTranscripts) {
    db.markSynced(podcast.id);
    log(opts.verbose, `  Done (transcript fetching disabled)`);
    return result;
  }

  // ============================================================
  // Phase B: Batch status check (concurrent Podscribe API calls)
  // ============================================================

  // Get all episodes missing transcripts, skipping recently-checked ones
  const allMissing = db.getEpisodesMissingTranscripts(
    podcast.id,
    opts.maxTranscriptFetches,
    { cooldownMs: opts.statusCooldownMs }
  );

  // Split into Podscribe-indexed and non-Podscribe episodes
  const podscribeEpisodes: Episode[] = [];
  const nonPodscribeEpisodes: Episode[] = [];
  for (const ep of allMissing) {
    if (ep.podscribeEpisodeId) {
      podscribeEpisodes.push(ep);
    } else {
      nonPodscribeEpisodes.push(ep);
    }
  }

  log(
    opts.verbose,
    `  Missing transcripts: ${allMissing.length} total (${podscribeEpisodes.length} Podscribe-indexed, ${nonPodscribeEpisodes.length} other)`
  );

  // Batch check transcript statuses via Podscribe API
  const statusResults: PodscribeStatusResult[] = [];
  if (podscribeEpisodes.length > 0) {
    log(opts.verbose, `  Phase B: Checking ${podscribeEpisodes.length} Podscribe statuses (concurrency: ${opts.concurrency})...`);
    emit?.({ type: "phase:start", podcastId: podcast.id, phase: "status", total: podscribeEpisodes.length, message: `Checking ${podscribeEpisodes.length} transcript statuses` });

    let checked = 0;
    const results = await pooledMap(
      podscribeEpisodes,
      async (ep): Promise<PodscribeStatusResult | null> => {
        try {
          const detail = await fetchEpisodeDetail(ep.podscribeEpisodeId!);
          const transcription = detail.transcription;
          checked++;
          return {
            podscribeId: ep.podscribeEpisodeId!,
            guid: ep.guid,
            status: transcription?.status ?? "Unknown",
            transcriptionId: transcription?.id ?? null,
          };
        } catch (err) {
          const msg = `Status check failed for "${ep.title}": ${
            err instanceof Error ? err.message : String(err)
          }`;
          result.errors.push(msg);
          return null;
        }
      },
      {
        concurrency: opts.concurrency,
        delayMs: opts.concurrentDelayMs,
        onProgress: (done, total) => {
          if (done % 50 === 0 || done === total) {
            log(opts.verbose, `    Status checked: ${done}/${total}`);
          }
          emit?.({ type: "phase:progress", podcastId: podcast.id, phase: "status", completed: done, total });
        },
      }
    );

    // Collect successful results
    for (const r of results) {
      if (r) statusResults.push(r);
    }

    // Cache statuses in DB
    if (statusResults.length > 0) {
      db.setPodscribeTranscriptStatuses(
        statusResults.map((r) => ({
          podcastId: podcast.id,
          guid: r.guid,
          status: r.status,
        }))
      );
    }

    const doneCount = statusResults.filter((r) => r.status === "Done").length;
    const notStarted = statusResults.filter((r) => r.status === "NotStarted").length;
    const other = statusResults.length - doneCount - notStarted;
    log(
      opts.verbose,
      `  Status results: ${doneCount} Done, ${notStarted} NotStarted${other > 0 ? `, ${other} other` : ""}`
    );
    emit?.({ type: "phase:complete", podcastId: podcast.id, phase: "status", summary: `${doneCount} Done, ${notStarted} NotStarted${other > 0 ? `, ${other} other` : ""}` });
  }

  // ============================================================
  // Phase C: Download transcripts (concurrent for Podscribe)
  // ============================================================

  // C1: Download ready Podscribe transcripts concurrently
  const readyToDownload = statusResults.filter(
    (r) => r.status === "Done" && r.transcriptionId
  );

  // Track which Done episodes had no text (bogus Done → reset later)
  const bogusDone: PodscribeStatusResult[] = [];

  if (readyToDownload.length > 0) {
    log(opts.verbose, `  Phase C: Downloading ${readyToDownload.length} transcripts (concurrency: ${opts.concurrency})...`);
    emit?.({ type: "phase:start", podcastId: podcast.id, phase: "download", total: readyToDownload.length, message: `Downloading ${readyToDownload.length} transcripts` });

    await pooledMap(
      readyToDownload,
      async (r) => {
        try {
          const result2 = await fetchTranscriptText(r.podscribeId, r.transcriptionId!);
          if (result2) {
            db.setTranscript(podcast.id, r.guid, result2.text, "podscribe-api", result2.words);
            result.newTranscripts++;
            log(opts.verbose, `    ✓ "${r.guid}" (podscribe-api)`);
          } else {
            // Done but no text — will be reset in Phase D
            bogusDone.push(r);
          }
        } catch (err) {
          const msg = `Transcript download failed for episode ${r.podscribeId}: ${
            err instanceof Error ? err.message : String(err)
          }`;
          result.errors.push(msg);
        }
      },
      {
        concurrency: opts.concurrency,
        delayMs: opts.concurrentDelayMs,
        onProgress: (done, total) => {
          if (done % 20 === 0 || done === total) {
            log(opts.verbose, `    Downloaded: ${done}/${total}`);
          }
          emit?.({ type: "phase:progress", podcastId: podcast.id, phase: "download", completed: done, total });
        },
      }
    );
    emit?.({ type: "phase:complete", podcastId: podcast.id, phase: "download", summary: `${result.newTranscripts} transcripts downloaded` });
  }

  // ============================================================
  // Phase D: Auto-request transcripts for NotStarted + reset bogus Done
  // ============================================================

  const needsRequest = statusResults.filter((r) => r.status === "NotStarted");
  const needsAction = [...needsRequest, ...bogusDone];

  if (needsAction.length > 0) {
    const auth = getPodscribeAuthToken();
    if (auth) {
      log(opts.verbose, `  Phase D: Requesting ${needsRequest.length} NotStarted${bogusDone.length > 0 ? `, resetting ${bogusDone.length} bogus Done` : ""} (concurrency: ${opts.concurrency})...`);
      emit?.({ type: "phase:start", podcastId: podcast.id, phase: "request", total: needsAction.length, message: `Requesting ${needsAction.length} transcripts` });

      let requestIdx = 0;
      await pooledMap(
        needsAction,
        async (r) => {
          try {
            const isReset = bogusDone.includes(r);
            if (isReset) {
              // Bogus Done → reset to re-trigger transcription
              if (auth.userId) {
                const res = await resetTranscription(r.podscribeId, auth.token, auth.userId);
                if (res.success) {
                  log(opts.verbose, `    ↻ Reset: episode ${r.podscribeId}`);
                } else {
                  log(opts.verbose, `    ✗ Reset failed: episode ${r.podscribeId} — ${res.error}`);
                }
              }
            } else {
              // NotStarted → request transcription
              const res = await requestTranscription(r.podscribeId, auth.token);
              if (res.success) {
                log(opts.verbose, `    ✓ Requested: episode ${r.podscribeId}`);
              } else {
                log(opts.verbose, `    ✗ Request failed: episode ${r.podscribeId} — ${res.error}`);
              }
            }
            // Mark as Requested so next sync picks it up as Done
            db.setPodscribeTranscriptStatuses([
              { podcastId: podcast.id, guid: r.guid, status: "Requested" },
            ]);
          } catch (err) {
            const msg = `Request failed for episode ${r.podscribeId}: ${
              err instanceof Error ? err.message : String(err)
            }`;
            result.errors.push(msg);
          }
          requestIdx++;
          emit?.({ type: "phase:progress", podcastId: podcast.id, phase: "request", completed: requestIdx, total: needsAction.length });
        },
        {
          concurrency: opts.concurrency,
          delayMs: opts.concurrentDelayMs,
        }
      );
      emit?.({ type: "phase:complete", podcastId: podcast.id, phase: "request", summary: `${needsRequest.length} requested, ${bogusDone.length} reset` });
    } else {
      log(opts.verbose, `  Skipping transcript requests (no Podscribe auth token)`);
    }
  }

  // C2: Fallback — non-Podscribe episodes go through the sequential adapter chain
  if (nonPodscribeEpisodes.length > 0) {
    log(opts.verbose, `  Fallback: ${nonPodscribeEpisodes.length} episodes via adapter chain...`);
    emit?.({ type: "phase:start", podcastId: podcast.id, phase: "fallback", total: nonPodscribeEpisodes.length, message: `Checking ${nonPodscribeEpisodes.length} episodes via adapters` });

    // Build adapter chain: RSS tags → Podscribe API lookup → HTML scraping
    const adapters: TranscriptAdapter[] = [
      new RSSTranscriptAdapter(feedData.transcriptUrls),
    ];
    if (episodeMap.size > 0) {
      adapters.push(new PodscribeApiAdapter(episodeMap));
    }
    adapters.push(new PodscribeAdapter());
    const adapter = new CompositeTranscriptAdapter(adapters);

    let fallbackIdx = 0;
    for (const episode of nonPodscribeEpisodes) {
      fallbackIdx++;
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
      emit?.({ type: "phase:progress", podcastId: podcast.id, phase: "fallback", completed: fallbackIdx, total: nonPodscribeEpisodes.length });

      // Rate limiting for external servers
      if (opts.fetchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.fetchDelayMs));
      }
    }
    emit?.({ type: "phase:complete", podcastId: podcast.id, phase: "fallback", summary: `Adapter chain processed ${nonPodscribeEpisodes.length} episodes` });
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
  const emit = options.onProgress;
  const startTime = Date.now();

  emit?.({
    type: "sync:start",
    totalPodcasts: podcasts.length,
    podcastIds: podcasts.map((p) => p.id),
  });

  for (let i = 0; i < podcasts.length; i++) {
    const podcast = podcasts[i];
    emit?.({
      type: "podcast:start",
      podcastId: podcast.id,
      podcastName: podcast.name,
      podcastIndex: i,
      totalPodcasts: podcasts.length,
    });

    const result = await syncPodcast(podcast, db, options);
    results.push(result);

    emit?.({
      type: "podcast:complete",
      podcastId: podcast.id,
      podcastName: podcast.name,
      result,
    });
  }

  emit?.({
    type: "sync:complete",
    results,
    durationMs: Date.now() - startTime,
  });

  return results;
}
