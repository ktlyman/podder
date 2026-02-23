/**
 * Transcript Request Engine — Queue-based.
 *
 * Processes episodes through an independent lifecycle:
 *   1. Dequeue → check Podscribe status → request/reset/download
 *   2. Wait 4 minutes (configurable)
 *   3. Check back for text → done or retry
 *
 * Only the initial request step is rate-limited (N concurrent slots).
 * Hundreds of episodes can be "in flight" (waiting for their timer)
 * simultaneously, making this much more efficient than batch polling.
 *
 * Authentication: Requires a valid Cognito JWT from Podscribe.
 * Token is auto-extracted from Chrome localStorage or PODSCRIBE_AUTH_TOKEN env var.
 *
 * Endpoints used:
 *   POST /api/episode/{id}/self-hosting-request — new transcription
 *   POST /api/episode/reset — re-trigger bogus Done records
 */

import {
  fetchEpisodeDetail,
  fetchTranscriptText,
  requestTranscription,
  resetTranscription,
} from "./adapters/podscribe-api-adapter.js";
import { getPodscribeAuthToken } from "./adapters/podscribe-auth.js";
import type { AuthResult } from "./adapters/podscribe-auth.js";
import type { PodcastDatabase } from "./storage/database.js";
import type {
  Episode,
  EpisodeQueueState,
  RequestTranscriptsOptions,
  RequestTranscriptsResult,
  SyncProgressCallback,
  TimingStats,
} from "./types/index.js";

const DEFAULTS = {
  concurrency: 5,
  requestStaggerMs: 500,
  checkDelayMs: 240_000,   // 4 minutes before first check
  retryDelayMs: 120_000,   // 2 minutes between subsequent checks
  maxCheckRetries: 15,     // ~34 min total window (4 + 15×2)
  maxRequests: Infinity,
  verbose: true,
};

function log(verbose: boolean, ...args: unknown[]): void {
  if (verbose) console.log(...args);
}

/** Format ms duration as human-readable string */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m${remSecs}s` : `${mins}m`;
}

/** Compute timing stats from an array of durations */
function computeTimingStats(durations: number[]): TimingStats {
  if (durations.length === 0) {
    return { durations: [], minMs: 0, maxMs: 0, avgMs: 0, medianMs: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    durations: sorted,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    medianMs: sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid],
  };
}

/** Cancellable sleep — resolves to false if aborted */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const timer = setTimeout(() => resolve(true), ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(false); }, { once: true });
  });
}

/**
 * Queue-based transcript request engine.
 *
 * Each episode flows independently through: request → wait → check → done.
 * Rate limiting controls concurrent requests; wait/check steps run freely.
 */
export class TranscriptQueue {
  private db: PodcastDatabase;
  private auth: AuthResult;
  private emit: SyncProgressCallback | undefined;
  private verbose: boolean;

  // Options
  private concurrency: number;
  private requestStaggerMs: number;
  private checkDelayMs: number;
  private retryDelayMs: number;
  private maxCheckRetries: number;
  private retryMode: boolean;

  // Queue state
  private queue: Episode[] = [];
  private total = 0;
  private activeRequests = 0;
  private waiting = 0;      // episodes waiting for their timer
  private activeChecks = 0;  // episodes currently being checked (timer fired, awaiting response)
  private result: RequestTranscriptsResult = {
    requested: 0, downloaded: 0, failed: 0, stillProcessing: 0, errors: [],
  };

  // Timing
  private startTimes = new Map<string, number>();  // guid → Date.now()
  private completedDurations: number[] = [];       // ms per completed episode

  // Lifecycle
  private abortController = new AbortController();
  private donePromise: Promise<RequestTranscriptsResult> | null = null;
  private doneResolve: ((r: RequestTranscriptsResult) => void) | null = null;
  private _running = false;

  constructor(
    db: PodcastDatabase,
    auth: AuthResult,
    options: RequestTranscriptsOptions = {}
  ) {
    this.db = db;
    this.auth = auth;
    this.emit = options.onProgress;
    this.verbose = options.verbose ?? DEFAULTS.verbose;

    this.concurrency = options.concurrency ?? DEFAULTS.concurrency;
    this.requestStaggerMs = options.requestStaggerMs ?? DEFAULTS.requestStaggerMs;
    this.checkDelayMs = options.checkDelayMs ?? DEFAULTS.checkDelayMs;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULTS.retryDelayMs;
    this.maxCheckRetries = options.maxCheckRetries ?? DEFAULTS.maxCheckRetries;
    this.retryMode = options.retry ?? false;

    const maxRequests = options.maxRequests ?? DEFAULTS.maxRequests;
    const limit = Number.isFinite(maxRequests) ? maxRequests : undefined;

    if (this.retryMode) {
      // Retry mode: pick up episodes stuck in Requested/Processing/Running
      const all = db.getEpisodesInProcessing(options.podcastIds);
      this.queue = limit ? all.slice(0, limit) : all;
    } else {
      this.queue = db.getEpisodesNeedingTranscriptRequest(options.podcastIds, limit);
    }
    this.total = this.queue.length;
  }

  get running(): boolean { return this._running; }

  getStatus() {
    return {
      queued: this.queue.length,
      requesting: this.activeRequests,
      waiting: this.waiting,
      checking: this.activeChecks,
      done: this.result.downloaded,
      failed: this.result.failed,
      total: this.total,
    };
  }

  /** Start processing the queue. Returns a promise that resolves when done or stopped. */
  start(): Promise<RequestTranscriptsResult> {
    if (this.donePromise) return this.donePromise;

    this._running = true;
    this.donePromise = new Promise((resolve) => {
      this.doneResolve = resolve;
    });

    const modeLabel = this.retryMode ? "to retry" : "to process";
    log(this.verbose, `[queue] ${this.total} episodes ${modeLabel} (concurrency: ${this.concurrency})`);
    log(this.verbose, `[queue] Auth: ${this.auth.source} (expires ${this.auth.expiresAt.toISOString()})`);

    if (this.total === 0) {
      log(this.verbose, `[queue] Nothing to do`);
      this.finish();
      return this.donePromise;
    }

    this.emit?.({
      type: "phase:start",
      podcastId: "all",
      phase: "request",
      total: this.total,
      message: `Processing ${this.total} episodes`,
    });

    // Launch the main pump loop (non-blocking)
    this.pump();

    return this.donePromise;
  }

  /** Stop the queue gracefully. In-flight checks still finish. */
  stop(): void {
    if (!this._running) return;
    log(this.verbose, `[queue] Stopping...`);
    this._running = false;
    this.abortController.abort();
    // Don't resolve yet — let in-flight tasks finish naturally via checkDone()
    this.result.stillProcessing = this.queue.length + this.waiting + this.activeChecks;
    this.checkDone();
  }

  // ---- Internal machinery ----

  /** Record start time for an episode */
  private startTimer(ep: Episode): void {
    this.startTimes.set(ep.guid, Date.now());
  }

  /** Get elapsed time string and record duration for a completed episode */
  private elapsed(ep: Episode): string {
    const start = this.startTimes.get(ep.guid);
    if (!start) return "";
    const ms = Date.now() - start;
    this.completedDurations.push(ms);
    this.startTimes.delete(ep.guid);
    return formatDuration(ms);
  }

  /** Main loop: dequeue episodes and submit them, respecting concurrency. */
  private async pump(): Promise<void> {
    const signal = this.abortController.signal;

    while (this.queue.length > 0 && !signal.aborted) {
      // Wait for a request slot
      while (this.activeRequests >= this.concurrency && !signal.aborted) {
        await sleep(100, signal);
      }
      if (signal.aborted) break;

      const ep = this.queue.shift()!;
      this.activeRequests++;

      // Fire and forget — processEpisode handles its own lifecycle
      this.processEpisode(ep).catch(() => {});

      // Stagger between request starts
      if (this.queue.length > 0) {
        await sleep(this.requestStaggerMs, signal);
      }
    }

    // Queue drained — check if we're fully done
    this.checkDone();
  }

  /** Process one episode: check status → request/reset → schedule check. */
  private async processEpisode(ep: Episode): Promise<void> {
    const signal = this.abortController.signal;
    this.startTimer(ep);
    this.setEpisodeState(ep, this.retryMode ? "checking" : "requesting");
    try {
      const detail = await fetchEpisodeDetail(ep.podscribeEpisodeId!);
      const psStatus = detail.transcription?.status ?? "none";
      const psId = detail.transcription?.id;

      // Route based on actual Podscribe status
      if (psStatus === "Done" && psId) {
        // Check if text already exists
        const result = await fetchTranscriptText(ep.podscribeEpisodeId!, psId);
        if (result && result.text.length > 0) {
          this.db.setTranscript(ep.podcastId, ep.guid, result.text, "podscribe-api", result.words);
          this.db.setPodscribeTranscriptStatuses([
            { podcastId: ep.podcastId, guid: ep.guid, status: "Done", transcriptionId: psId },
          ]);
          this.result.downloaded++;
          const dt = this.elapsed(ep);
          this.setEpisodeState(ep, "done", `${result.text.length} chars, ${dt}`);
          log(this.verbose, `  ✓ Downloaded: "${ep.title}" (${result.text.length} chars) [${dt}]`);
          this.emitProgress();
          return;
        }

        if (this.retryMode) {
          // In retry mode, bogus Done = permanently empty (short episodes with no audio content)
          this.result.failed++;
          const dt = this.elapsed(ep);
          this.setEpisodeState(ep, "failed", "Done but no text");
          log(this.verbose, `  ✗ Skipped: "${ep.title}" — Done but no text (likely too short) [${dt}]`);
          this.emitProgress();
          return;
        }

        // Bogus Done — reset
        const userId = this.auth.userId;
        if (!userId) {
          this.result.failed++;
          const dt = this.elapsed(ep);
          this.result.errors.push(`Cannot reset "${ep.title}": no userId in JWT`);
          this.setEpisodeState(ep, "failed", "no userId in JWT");
          log(this.verbose, `  ✗ No userId for reset: "${ep.title}" [${dt}]`);
          this.emitProgress();
          return;
        }

        this.setEpisodeState(ep, "requesting", "resetting");
        log(this.verbose, `  ↻ Resetting: "${ep.title}"`);
        const res = await resetTranscription(ep.podscribeEpisodeId!, this.auth.token, userId);
        if (!res.success) {
          if (res.error?.includes("Auth failed")) { this.handleAuthFailure(); return; }
          this.result.failed++;
          const dt = this.elapsed(ep);
          this.result.errors.push(`Reset failed: "${ep.title}": ${res.error}`);
          this.setEpisodeState(ep, "failed", res.error ?? "reset failed");
          log(this.verbose, `  ✗ Reset failed: "${ep.title}" — ${res.error} [${dt}]`);
          this.emitProgress();
          return;
        }

      } else if (psStatus === "Running" || psStatus === "Processing") {
        // Already processing — skip straight to check phase
        log(this.verbose, `  ⟳ Already ${psStatus}: "${ep.title}"`);
        this.db.setPodscribeTranscriptStatuses([
          { podcastId: ep.podcastId, guid: ep.guid, status: psStatus },
        ]);

      } else if (this.retryMode) {
        // In retry mode and status is NotStarted/unknown — not ready yet, schedule recheck
        log(this.verbose, `  ⏳ "${ep.title}" — ${psStatus}, will recheck`);
        this.db.setPodscribeTranscriptStatuses([
          { podcastId: ep.podcastId, guid: ep.guid, status: psStatus },
        ]);
        if (!signal.aborted) {
          this.scheduleCheck(ep, 0);
        }
        return;

      } else {
        // Genuinely NotStarted — request
        const res = await requestTranscription(ep.podscribeEpisodeId!, this.auth.token);
        if (!res.success) {
          if (res.error?.includes("Auth failed")) { this.handleAuthFailure(); return; }
          this.result.failed++;
          const dt = this.elapsed(ep);
          this.result.errors.push(`Request failed: "${ep.title}": ${res.error}`);
          this.setEpisodeState(ep, "failed", res.error ?? "request failed");
          log(this.verbose, `  ✗ Request failed: "${ep.title}" — ${res.error} [${dt}]`);
          this.emitProgress();
          return;
        }
        log(this.verbose, `  ✓ Requested: "${ep.title}"`);
      }

      // Mark as Requested in DB (in retry mode, preserve existing status)
      if (!this.retryMode) {
        this.result.requested++;
        this.db.setPodscribeTranscriptStatuses([
          { podcastId: ep.podcastId, guid: ep.guid, status: "Requested" },
        ]);
      }
      this.emitProgress();

      // Schedule the first check
      if (!signal.aborted) {
        // In retry mode, check immediately (no initial delay — these were requested long ago)
        if (this.retryMode) {
          this.scheduleCheck(ep, 1); // start at retry 1 so delay = retryDelayMs
        } else {
          this.scheduleCheck(ep, 0); // normal mode: wait checkDelayMs first
        }
      }
    } catch (err) {
      this.result.failed++;
      const dt = this.elapsed(ep);
      const msg = err instanceof Error ? err.message : String(err);
      this.result.errors.push(`Error: "${ep.title}": ${msg}`);
      this.setEpisodeState(ep, "failed", msg);
      log(this.verbose, `  ✗ Error: "${ep.title}" — ${msg} [${dt}]`);
      this.emitProgress();
    } finally {
      this.activeRequests--;
      this.checkDone();
    }
  }

  /** Schedule a status check for an episode after a delay. */
  private scheduleCheck(ep: Episode, retryCount: number): void {
    this.waiting++;
    const delayMs = retryCount === 0 ? this.checkDelayMs : this.retryDelayMs;
    const signal = this.abortController.signal;
    this.setEpisodeState(ep, "waiting", retryCount > 0 ? `check ${retryCount + 1}/${this.maxCheckRetries}` : undefined);

    sleep(delayMs, signal).then(async (ok) => {
      this.waiting--;
      if (!ok) {
        // Aborted — count as still processing
        this.setEpisodeState(ep, "stopped");
        this.result.stillProcessing++;
        this.checkDone();
        return;
      }

      // Track that this check is actively running (prevents premature finish)
      this.activeChecks++;
      this.setEpisodeState(ep, "checking");
      try {
        const detail = await fetchEpisodeDetail(ep.podscribeEpisodeId!);
        const status = detail.transcription?.status ?? "Unknown";
        const tid = detail.transcription?.id;

        if (status === "Done" && tid) {
          const result = await fetchTranscriptText(ep.podscribeEpisodeId!, tid);
          if (result && result.text.length > 0) {
            this.db.setTranscript(ep.podcastId, ep.guid, result.text, "podscribe-api", result.words);
            this.db.setPodscribeTranscriptStatuses([
              { podcastId: ep.podcastId, guid: ep.guid, status: "Done", transcriptionId: tid },
            ]);
            this.result.downloaded++;
            const dt = this.elapsed(ep);
            this.setEpisodeState(ep, "done", `${result.text.length} chars, ${dt}`);
            log(this.verbose, `  ✓ Downloaded: "${ep.title}" (${result.text.length} chars) [${dt}]`);
            this.emitProgress();
            return;
          }
        }

        // Update DB with latest status
        this.db.setPodscribeTranscriptStatuses([
          { podcastId: ep.podcastId, guid: ep.guid, status },
        ]);

        // Not ready — retry or give up
        if (retryCount < this.maxCheckRetries && !signal.aborted) {
          log(this.verbose, `    ⏳ "${ep.title}" — ${status}, retry ${retryCount + 1}/${this.maxCheckRetries}`);
          this.scheduleCheck(ep, retryCount + 1);
        } else {
          this.result.failed++;
          const dt = this.elapsed(ep);
          this.result.errors.push(
            `Timeout: "${ep.title}" still ${status} after ${retryCount + 1} checks (${dt})`
          );
          this.setEpisodeState(ep, "failed", `still ${status} after ${retryCount + 1} checks`);
          log(this.verbose, `  ✗ Timeout: "${ep.title}" — ${status} [${dt}]`);
          this.emitProgress();
        }
      } catch (err) {
        // Network error during check — retry
        if (retryCount < this.maxCheckRetries && !signal.aborted) {
          log(this.verbose, `    ⚠ Check error for "${ep.title}", retry ${retryCount + 1}/${this.maxCheckRetries}`);
          this.scheduleCheck(ep, retryCount + 1);
        } else {
          this.result.failed++;
          const dt = this.elapsed(ep);
          const msg = err instanceof Error ? err.message : String(err);
          this.result.errors.push(`Check error: "${ep.title}": ${msg} (${dt})`);
          this.setEpisodeState(ep, "failed", msg);
          this.emitProgress();
        }
      } finally {
        this.activeChecks--;
        this.checkDone();
      }
    });
  }

  private handleAuthFailure(): void {
    log(this.verbose, `  ✗ Auth expired — stopping queue`);
    this.result.errors.push("Auth token expired. Re-login to Podscribe in Chrome and retry.");
    this.stop();
  }

  private emitProgress(): void {
    const completed = this.result.downloaded + this.result.failed;
    const status = this.getStatus();
    this.emit?.({
      type: "phase:progress",
      podcastId: "all",
      phase: "request",
      completed,
      total: this.total,
      message: `${status.requesting} requesting, ${status.waiting} waiting, ${status.done} done, ${status.failed} failed`,
    });
  }

  /** Emit per-episode state change for live UI tracking */
  private setEpisodeState(ep: Episode, state: EpisodeQueueState, detail?: string): void {
    this.emit?.({
      type: "episode:status",
      podcastId: ep.podcastId,
      guid: ep.guid,
      title: ep.title,
      state,
      detail,
    });
  }

  /** Check if all work is done and resolve the promise if so. */
  private checkDone(): void {
    if (this.queue.length === 0 && this.activeRequests === 0 && this.waiting === 0 && this.activeChecks === 0) {
      this.finish();
    }
  }

  private finish(): void {
    if (!this._running && !this.doneResolve) return; // already finished
    this._running = false;

    // Compute timing stats
    if (this.completedDurations.length > 0) {
      this.result.timings = computeTimingStats(this.completedDurations);
    }

    log(
      this.verbose,
      `\n[queue] Done: ${this.result.downloaded} downloaded, ${this.result.failed} failed, ${this.result.stillProcessing} still processing`
    );
    if (this.result.timings && this.completedDurations.length > 0) {
      const t = this.result.timings;
      log(
        this.verbose,
        `[queue] Timing (${this.completedDurations.length} episodes): min ${formatDuration(t.minMs)}, max ${formatDuration(t.maxMs)}, avg ${formatDuration(t.avgMs)}, median ${formatDuration(t.medianMs)}`
      );
    }

    this.emit?.({
      type: "phase:complete",
      podcastId: "all",
      phase: "request",
      summary: `${this.result.downloaded} downloaded, ${this.result.failed} failed`,
    });

    this.doneResolve?.(this.result);
    this.doneResolve = null;
  }
}

/**
 * Convenience wrapper — creates a TranscriptQueue, starts it, and returns
 * a promise. Preserves CLI compatibility with the old batch interface.
 */
export async function requestAndPollTranscripts(
  db: PodcastDatabase,
  options: RequestTranscriptsOptions = {}
): Promise<RequestTranscriptsResult> {
  const auth = getPodscribeAuthToken();
  if (!auth) {
    const msg =
      "No Podscribe auth token available. " +
      "Login to app.podscribe.com in Chrome, or set PODSCRIBE_AUTH_TOKEN env var.";
    if (options.verbose !== false) console.log(`[queue] ✗ ${msg}`);
    options.onProgress?.({
      type: "phase:complete",
      podcastId: "all",
      phase: "request",
      summary: msg,
    });
    return { requested: 0, downloaded: 0, failed: 0, stillProcessing: 0, errors: [msg] };
  }

  const queue = new TranscriptQueue(db, auth, options);
  return queue.start();
}
