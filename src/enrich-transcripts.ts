/**
 * Transcript Enrichment Engine — Queue-based.
 *
 * Fetches word-level structured data (speaker IDs, timestamps, confidence)
 * for episodes that already have plain-text transcripts but are missing
 * the enriched transcript_data.
 *
 * Flow per episode:
 *   1. fetchEpisodeDetail(podscribeEpisodeId) → get transcription.id
 *   2. fetchTranscriptText(podscribeEpisodeId, transcription.id) → get words[]
 *   3. db.setTranscriptData(episodeId, words) — update only transcript_data column
 *
 * Both Podscribe endpoints are unauthenticated (public GET), so no auth token is needed.
 */

import {
  fetchEpisodeDetail,
  fetchTranscriptText,
} from "./adapters/podscribe-api-adapter.js";
import type { PodcastDatabase } from "./storage/database.js";
import type {
  Episode,
  SyncProgressCallback,
} from "./types/index.js";

export interface EnrichmentOptions {
  podcastIds?: string[];
  concurrency?: number;
  delayMs?: number;
  verbose?: boolean;
  onProgress?: SyncProgressCallback;
}

export interface EnrichmentResult {
  enriched: number;
  failed: number;
  skipped: number;
  errors: string[];
}

const DEFAULTS = {
  concurrency: 5,
  delayMs: 300,
  verbose: true,
};

function log(verbose: boolean, ...args: unknown[]): void {
  if (verbose) console.log(...args);
}

/**
 * Queue-based enrichment engine.
 *
 * Processes episodes concurrently with configurable parallelism.
 * Each episode independently fetches its structured data from Podscribe.
 */
export class EnrichmentQueue {
  private db: PodcastDatabase;
  private emit: SyncProgressCallback | undefined;
  private verbose: boolean;

  private concurrency: number;
  private delayMs: number;

  private queue: Episode[] = [];
  private total = 0;
  private active = 0;
  private completed = 0;
  private result: EnrichmentResult = {
    enriched: 0, failed: 0, skipped: 0, errors: [],
  };

  private abortController = new AbortController();
  private donePromise: Promise<EnrichmentResult> | null = null;
  private doneResolve: ((r: EnrichmentResult) => void) | null = null;
  private _running = false;

  constructor(db: PodcastDatabase, options: EnrichmentOptions = {}) {
    this.db = db;
    this.emit = options.onProgress;
    this.verbose = options.verbose ?? DEFAULTS.verbose;
    this.concurrency = options.concurrency ?? DEFAULTS.concurrency;
    this.delayMs = options.delayMs ?? DEFAULTS.delayMs;

    this.queue = db.getEpisodesNeedingEnrichment(options.podcastIds);
    this.total = this.queue.length;
  }

  get running(): boolean { return this._running; }

  getStatus() {
    return {
      queued: this.queue.length,
      active: this.active,
      enriched: this.result.enriched,
      failed: this.result.failed,
      skipped: this.result.skipped,
      total: this.total,
    };
  }

  /** Start processing. Returns a promise that resolves when complete or stopped. */
  start(): Promise<EnrichmentResult> {
    if (this.donePromise) return this.donePromise;

    this._running = true;
    this.donePromise = new Promise((resolve) => {
      this.doneResolve = resolve;
    });

    log(this.verbose, `[enrich] ${this.total} episodes to enrich (concurrency: ${this.concurrency})`);

    if (this.total === 0) {
      log(this.verbose, `[enrich] Nothing to do`);
      this.finish();
      return this.donePromise;
    }

    this.emit?.({
      type: "phase:start",
      podcastId: "all",
      phase: "enrich",
      total: this.total,
      message: `Enriching ${this.total} episodes`,
    });

    this.pump();
    return this.donePromise;
  }

  /** Stop the queue gracefully. In-flight requests will complete. */
  stop(): void {
    log(this.verbose, `[enrich] Stop requested`);
    this.abortController.abort();
    this.queue.length = 0; // Drain remaining so pump() can finish once active hits 0
    if (this.active === 0) this.finish(); // Nothing in flight — resolve immediately
  }

  private pump(): void {
    if (this.abortController.signal.aborted && this.active === 0) {
      this.finish();
      return;
    }

    while (this.active < this.concurrency && this.queue.length > 0) {
      if (this.abortController.signal.aborted) break;
      const ep = this.queue.shift()!;
      this.active++;
      this.processEpisode(ep).finally(() => {
        this.active--;
        this.completed++;

        // Broadcast progress
        this.emit?.({
          type: "phase:progress",
          podcastId: "all",
          phase: "enrich",
          completed: this.completed,
          total: this.total,
        });

        // Schedule next batch with small delay
        if (this.delayMs > 0) {
          setTimeout(() => this.pump(), this.delayMs);
        } else {
          this.pump();
        }
      });
    }

    // Check if we're done
    if (this.active === 0 && this.queue.length === 0) {
      this.finish();
    }
  }

  private async processEpisode(ep: Episode): Promise<void> {
    const label = `"${ep.title}" (${ep.podcastId})`;

    try {
      // Step 1: Get transcription ID from episode detail
      const detail = await fetchEpisodeDetail(ep.podscribeEpisodeId!);
      const transcription = detail.transcription;

      if (!transcription || transcription.status !== "Done" || !transcription.id) {
        log(this.verbose, `[enrich] ✗ ${label} — not ready (status: ${transcription?.status ?? "none"})`);
        this.result.skipped++;
        return;
      }

      // Step 2: Fetch full transcript with word-level data
      const result = await fetchTranscriptText(ep.podscribeEpisodeId!, transcription.id);

      if (!result || result.words.length === 0) {
        log(this.verbose, `[enrich] ✗ ${label} — no word data returned`);
        this.result.skipped++;
        return;
      }

      // Step 3: Store only the structured data (don't overwrite plain text)
      this.db.setTranscriptData(ep.id!, result.words);

      log(this.verbose, `[enrich] ✓ ${label} — ${result.words.length} words`);
      this.result.enriched++;

    } catch (err) {
      const msg = `${label}: ${err instanceof Error ? err.message : String(err)}`;
      log(this.verbose, `[enrich] ✗ ${msg}`);
      this.result.failed++;
      this.result.errors.push(msg);
    }
  }

  private finish(): void {
    if (!this._running) return;
    this._running = false;

    log(this.verbose, `[enrich] Complete: ${this.result.enriched} enriched, ${this.result.failed} failed, ${this.result.skipped} skipped`);

    this.emit?.({
      type: "phase:complete",
      podcastId: "all",
      phase: "enrich",
      summary: `${this.result.enriched} enriched, ${this.result.failed} failed`,
    });

    this.doneResolve?.(this.result);
  }
}
