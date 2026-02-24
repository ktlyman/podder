#!/usr/bin/env node

/**
 * HTTP API server for the podcast listener frontend.
 * Uses only Node.js built-ins (no express needed) to keep dependencies minimal.
 *
 * Routes are defined as a table of { method, pattern, handler } entries,
 * matched in order. Pattern groups are passed as `params` to the handler.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDbPath, loadPodcastConfig, getDataDir } from "../config.js";
import { PodcastDatabase } from "../storage/database.js";
import { QueryEngine } from "../agent/query-engine.js";
import { syncAll } from "../sync.js";
import { TranscriptQueue, TranscriptDownloader } from "../request-transcripts.js";
import { EnrichmentQueue } from "../enrich-transcripts.js";
import { getPodscribeAuthToken, setManualAuthToken } from "../adapters/podscribe-auth.js";
import { validateAuthToken } from "../adapters/podscribe-api-adapter.js";
import type { PodcastConfig, SyncProgressEvent } from "../types/index.js";

// ---- Constants ----

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const STATIC_DIR = resolve(__dirname, "../../public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Auto-clear stuck operations after 30 minutes */
const OPERATION_TIMEOUT_MS = 30 * 60 * 1000;

// ---- HTTP helpers ----

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

// ---- Config helpers ----

function getConfigPath(): string {
  return resolve(process.env.PODSCRIBE_CONFIG ?? "podcasts.json");
}

function loadTopics(): string[] {
  const path = resolve(getDataDir(), "topics.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveTopics(topics: string[]): void {
  const path = resolve(getDataDir(), "topics.json");
  writeFileSync(path, JSON.stringify(topics, null, 2));
}

function savePodcastConfig(podcasts: PodcastConfig[]): void {
  writeFileSync(getConfigPath(), JSON.stringify(podcasts, null, 2));
}

// ---- Operation state (replaces bare syncInProgress boolean) ----

interface ActiveOperation {
  type: "sync" | "request" | "enrich";
  startedAt: Date;
}

/** Minimal interface shared by TranscriptQueue and TranscriptDownloader */
interface Stoppable {
  running: boolean;
  stop(): void;
  getStatus(): Record<string, number>;
}

interface ServerState {
  operation: ActiveOperation | null;
  transcriptQueue: Stoppable | null;
  enrichQueue: EnrichmentQueue | null;
  sseClients: Set<ServerResponse>;
}

function isOperationActive(state: ServerState): boolean {
  if (!state.operation) return false;
  // Auto-clear stuck operations
  const elapsed = Date.now() - state.operation.startedAt.getTime();
  if (elapsed > OPERATION_TIMEOUT_MS) {
    console.warn(`[server] Auto-clearing stuck ${state.operation.type} operation after ${Math.round(elapsed / 60000)}m`);
    state.operation = null;
    state.transcriptQueue = null;
    state.enrichQueue = null;
    return false;
  }
  return true;
}

function startOperation(state: ServerState, type: ActiveOperation["type"]): void {
  state.operation = { type, startedAt: new Date() };
}

function clearOperation(state: ServerState): void {
  state.operation = null;
  state.transcriptQueue = null;
  state.enrichQueue = null;
}

// ---- Router ----

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  db: PodcastDatabase;
  engine: QueryEngine;
  state: ServerState;
  broadcast: (event: SyncProgressEvent) => void;
}

type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

// ---- Route handlers ----

function getStats(ctx: RouteContext): void {
  sendJson(ctx.res, ctx.engine.getStats());
}

function listPodcasts(ctx: RouteContext): void {
  sendJson(ctx.res, ctx.db.listPodcasts());
}

async function createPodcast(ctx: RouteContext): Promise<void> {
  const body = await jsonBody(ctx.req);
  const { id, name, feedUrl, tags, podscribeSeriesId } = body;
  if (!id || !name || !feedUrl) {
    sendError(ctx.res, "Missing required fields: id, name, feedUrl");
    return;
  }

  const config: PodcastConfig = {
    id: id as string,
    name: name as string,
    feedUrl: feedUrl as string,
    tags: (tags as string[]) ?? [],
    ...((podscribeSeriesId as string) ? { podscribeSeriesId: podscribeSeriesId as string } : {}),
  };

  ctx.db.upsertPodcast(config);
  const existing = loadPodcastConfig(getConfigPath());
  const updated = existing.filter((p) => p.id !== id);
  updated.push(config);
  savePodcastConfig(updated);
  sendJson(ctx.res, { ok: true, podcast: config }, 201);
}

async function updatePodcast(ctx: RouteContext): Promise<void> {
  const podcastId = decodeURIComponent(ctx.params[0]);
  const existing = loadPodcastConfig(getConfigPath());
  const target = existing.find((p) => p.id === podcastId);
  if (!target) {
    sendError(ctx.res, "Podcast not found", 404);
    return;
  }

  const body = await jsonBody(ctx.req);
  if (body.name !== undefined) target.name = body.name as string;
  if (body.feedUrl !== undefined) target.feedUrl = body.feedUrl as string;
  if (body.tags !== undefined) target.tags = body.tags as string[];
  if (body.podscribeSeriesId !== undefined) {
    if (body.podscribeSeriesId === "" || body.podscribeSeriesId === null) {
      delete target.podscribeSeriesId;
    } else {
      target.podscribeSeriesId = body.podscribeSeriesId as string;
    }
  }

  savePodcastConfig(existing);
  ctx.db.upsertPodcast(target);
  sendJson(ctx.res, { ok: true, podcast: target });
}

function deletePodcast(ctx: RouteContext): void {
  const podcastId = decodeURIComponent(ctx.params[0]);
  const existing = loadPodcastConfig(getConfigPath());
  const updated = existing.filter((p) => p.id !== podcastId);
  if (updated.length === existing.length) {
    sendError(ctx.res, "Podcast not found", 404);
    return;
  }
  savePodcastConfig(updated);
  ctx.db.deletePodcast(podcastId);
  sendJson(ctx.res, { ok: true });
}

function listEpisodes(ctx: RouteContext): void {
  const podcastId = ctx.url.searchParams.get("podcast") ?? "";
  const limit = parseInt(ctx.url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(ctx.url.searchParams.get("offset") ?? "0", 10);
  sendJson(ctx.res, ctx.engine.getRecentEpisodes(podcastId, limit, offset));
}

async function tagEpisode(ctx: RouteContext): Promise<void> {
  const body = await jsonBody(ctx.req);
  const { podcastId, guid, tag } = body;
  if (!podcastId || !guid) {
    sendError(ctx.res, "Missing required fields: podcastId, guid");
    return;
  }
  ctx.db.setEpisodeTag(podcastId as string, guid as string, (tag as string) ?? null);
  sendJson(ctx.res, { ok: true, podcastId, guid, tag: (tag as string) ?? null });
}

function searchEpisodes(ctx: RouteContext): void {
  const query = ctx.url.searchParams.get("q") ?? "";
  if (!query) {
    sendError(ctx.res, "Missing query parameter 'q'");
    return;
  }
  sendJson(ctx.res, ctx.engine.search({
    query,
    podcastIds: ctx.url.searchParams.get("podcast")?.split(",").filter(Boolean),
    tags: ctx.url.searchParams.get("tag")?.split(",").filter(Boolean),
    after: ctx.url.searchParams.get("after") ?? undefined,
    before: ctx.url.searchParams.get("before") ?? undefined,
    limit: parseInt(ctx.url.searchParams.get("limit") ?? "20", 10),
  }));
}

function getStructuredTranscript(ctx: RouteContext): void {
  const episodeId = parseInt(ctx.params[0], 10);
  const words = ctx.engine.getStructuredTranscript(episodeId);
  if (!words) {
    const plainText = ctx.engine.getTranscript(episodeId);
    if (!plainText) {
      sendError(ctx.res, "Transcript not found", 404);
      return;
    }
    sendJson(ctx.res, { structured: false, transcript: plainText, words: null });
    return;
  }
  sendJson(ctx.res, { structured: true, wordCount: words.length, words });
}

function getTranscript(ctx: RouteContext): void {
  const episodeId = parseInt(ctx.params[0], 10);
  const transcript = ctx.engine.getTranscript(episodeId);
  if (!transcript) {
    sendError(ctx.res, "Transcript not found", 404);
    return;
  }
  sendJson(ctx.res, { transcript, hasStructuredData: ctx.engine.hasStructuredTranscript(episodeId) });
}

function syncEvents(ctx: RouteContext): void {
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const active = isOperationActive(ctx.state);
  ctx.res.write(`data: ${JSON.stringify({ type: "connected", syncInProgress: active })}\n\n`);
  ctx.state.sseClients.add(ctx.res);

  const keepAlive = setInterval(() => {
    try { ctx.res.write(": keepalive\n\n"); } catch { /* client gone */ }
  }, 15000);

  ctx.req.on("close", () => {
    ctx.state.sseClients.delete(ctx.res);
    clearInterval(keepAlive);
  });
}

async function triggerSync(ctx: RouteContext): Promise<void> {
  if (isOperationActive(ctx.state)) {
    sendError(ctx.res, `A ${ctx.state.operation!.type} operation is already in progress`, 409);
    return;
  }

  startOperation(ctx.state, "sync");
  const opts = await jsonBody(ctx.req);
  const podcastId = opts.podcastId as string | undefined;

  const podcasts = loadPodcastConfig(getConfigPath());
  const targets = podcastId ? podcasts.filter((p) => p.id === podcastId) : podcasts;
  for (const p of targets) ctx.db.upsertPodcast(p);

  sendJson(ctx.res, { ok: true, message: "Sync started", count: targets.length });

  const syncOpts: Record<string, unknown> = {
    verbose: true,
    onProgress: ctx.broadcast,
  };
  if (typeof opts.concurrency === "number") syncOpts.concurrency = opts.concurrency;
  if (typeof opts.statusCooldownMs === "number") syncOpts.statusCooldownMs = opts.statusCooldownMs;

  syncAll(targets, ctx.db, syncOpts)
    .then((results) => console.log("Sync complete:", JSON.stringify(results, null, 2)))
    .catch((err) => {
      console.error("Sync error:", err);
      ctx.broadcast({ type: "sync:error", message: String(err) });
    })
    .finally(() => clearOperation(ctx.state));
}

function stopSync(ctx: RouteContext): void {
  if (!ctx.state.operation || ctx.state.operation.type !== "sync") {
    sendError(ctx.res, "No sync operation is currently running", 404);
    return;
  }
  // Sync doesn't have a graceful abort — clear state so the UI unblocks.
  // The underlying sync will still finish in the background but new operations can start.
  console.log("[server] Force-clearing sync operation state");
  clearOperation(ctx.state);
  ctx.broadcast({
    type: "sync:complete",
    results: [{ podcastId: "all", newEpisodes: 0, updatedEpisodes: 0, newTranscripts: 0, errors: ["Sync cancelled by user"] }],
    durationMs: 0,
  });
  sendJson(ctx.res, { ok: true, message: "Sync operation cancelled" });
}

function getTopics(ctx: RouteContext): void {
  sendJson(ctx.res, loadTopics());
}

async function addTopic(ctx: RouteContext): Promise<void> {
  const body = await jsonBody(ctx.req);
  const topic = body.topic as string;
  if (!topic) { sendError(ctx.res, "Missing 'topic' field"); return; }
  const topics = loadTopics();
  if (!topics.includes(topic)) { topics.push(topic); saveTopics(topics); }
  sendJson(ctx.res, { ok: true, topics }, 201);
}

async function removeTopic(ctx: RouteContext): Promise<void> {
  const body = await jsonBody(ctx.req);
  const topic = body.topic as string;
  if (!topic) { sendError(ctx.res, "Missing 'topic' field"); return; }
  const topics = loadTopics().filter((t) => t !== topic);
  saveTopics(topics);
  sendJson(ctx.res, { ok: true, topics });
}

function searchTopics(ctx: RouteContext): void {
  const topics = loadTopics();
  const limit = parseInt(ctx.url.searchParams.get("limit") ?? "5", 10);
  const results: Record<string, unknown> = {};
  for (const topic of topics) {
    try { results[topic] = ctx.engine.search({ query: topic, limit }); }
    catch { results[topic] = { answer: "Search failed", sources: [], totalResults: 0 }; }
  }
  sendJson(ctx.res, results);
}

async function requestTranscripts(ctx: RouteContext): Promise<void> {
  if (isOperationActive(ctx.state)) {
    sendError(ctx.res, `A ${ctx.state.operation!.type} operation is already in progress`, 409);
    return;
  }

  const bodyOpts = await jsonBody(ctx.req);
  const podcastIds = bodyOpts.podcastIds as string[] | undefined;

  // Step 1: Always try download mode first (no auth needed).
  // This catches transcripts that Podscribe already has available.
  const missing = ctx.db.getEpisodesAwaitingDownload(podcastIds);
  if (missing.length > 0) {
    startOperation(ctx.state, "request");

    const downloader = new TranscriptDownloader(ctx.db, {
      podcastIds,
      concurrency: (bodyOpts.concurrency as number) ?? 10,
      verbose: true,
      onProgress: ctx.broadcast,
    });
    // Store as transcript queue so the stop button works
    ctx.state.transcriptQueue = downloader;

    sendJson(ctx.res, { ok: true, message: "Downloading available transcripts", mode: "download", ...downloader.getStatus() });

    downloader.start()
      .then((result) => {
        console.log("Download complete:", JSON.stringify(result, null, 2));
        ctx.broadcast({
          type: "sync:complete",
          results: [{ podcastId: "all", newEpisodes: 0, updatedEpisodes: 0, newTranscripts: result.downloaded, errors: result.errors }],
          durationMs: 0,
        });
      })
      .catch((err) => {
        console.error("Download error:", err);
        ctx.broadcast({ type: "sync:error", message: String(err) });
      })
      .finally(() => clearOperation(ctx.state));
    return;
  }

  // Step 2: No missing transcripts to download — try auth-requiring request mode
  const auth = getPodscribeAuthToken();
  if (!auth) {
    sendError(ctx.res, "All available transcripts are downloaded. To request new ones, paste a Podscribe auth token above.", 401);
    return;
  }

  // Pre-validate token against Podscribe API
  if (auth.source === "chrome") {
    const needsWork = ctx.db.getEpisodesNeedingTranscriptRequest();
    const testEp = needsWork.find(ep => ep.podscribeEpisodeId) ?? null;
    if (testEp) {
      console.log(`[auth] Pre-validating Chrome token against episode ${testEp.podscribeEpisodeId}...`);
      const check = await validateAuthToken(auth.token, testEp.podscribeEpisodeId!);
      console.log(`[auth] Pre-validation result: ${check.valid ? "OK" : "FAILED"} (status ${check.status})`);
      if (!check.valid) {
        sendError(ctx.res,
          `Auth token from Chrome is stale (rejected by Podscribe). ` +
          `Paste a fresh token using the auth field above.`,
          401);
        return;
      }
    }
  }

  startOperation(ctx.state, "request");

  let retry = bodyOpts.retry as boolean | undefined;
  let queue = new TranscriptQueue(ctx.db, auth, {
    podcastIds,
    maxRequests: bodyOpts.maxRequests as number | undefined,
    concurrency: bodyOpts.concurrency as number | undefined,
    checkDelayMs: bodyOpts.checkDelayMs as number | undefined,
    retry,
    verbose: true,
    onProgress: ctx.broadcast,
  });

  if (queue.getStatus().total === 0 && !retry) {
    queue = new TranscriptQueue(ctx.db, auth, {
      podcastIds,
      retry: true,
      verbose: true,
      onProgress: ctx.broadcast,
    });
    retry = true;
  }

  if (queue.getStatus().total === 0) {
    clearOperation(ctx.state);
    sendJson(ctx.res, { ok: true, message: "Nothing to process — all transcripts are up to date", mode: "none", total: 0 });
    return;
  }

  ctx.state.transcriptQueue = queue;

  const mode = retry ? "retry" : "request";
  sendJson(ctx.res, { ok: true, message: `Transcript ${mode} started`, mode, ...queue.getStatus() });

  queue.start()
    .then((result) => {
      console.log("Transcript request complete:", JSON.stringify(result, null, 2));
      ctx.broadcast({
        type: "sync:complete",
        results: [{ podcastId: "all", newEpisodes: 0, updatedEpisodes: 0, newTranscripts: result.downloaded, errors: result.errors }],
        durationMs: 0,
      });
    })
    .catch((err) => {
      console.error("Transcript request error:", err);
      ctx.broadcast({ type: "sync:error", message: String(err) });
    })
    .finally(() => clearOperation(ctx.state));
}

function stopTranscriptRequest(ctx: RouteContext): void {
  const queue = ctx.state.transcriptQueue;
  if (!queue || !queue.running) {
    sendError(ctx.res, "No transcript request is currently running", 404);
    return;
  }
  const status = queue.getStatus();
  queue.stop();
  sendJson(ctx.res, { ok: true, message: "Transcript request stopping", ...status });
}

function transcriptRequestStatus(ctx: RouteContext): void {
  const podcastIds = ctx.url.searchParams.get("podcast")?.split(",").filter(Boolean);
  const queue = ctx.state.transcriptQueue;
  const auth = getPodscribeAuthToken();
  sendJson(ctx.res, {
    needingRequest: ctx.db.getEpisodesNeedingTranscriptRequest(podcastIds).length,
    inProcessing: ctx.db.getEpisodesInProcessing(podcastIds).length,
    queue: queue?.running ? queue.getStatus() : null,
    auth: auth
      ? { available: true, source: auth.source, expiresAt: auth.expiresAt.toISOString(), email: auth.email }
      : { available: false, hint: "Login to app.podscribe.com in Chrome, or set PODSCRIBE_AUTH_TOKEN env var" },
  });
}

async function startEnrichment(ctx: RouteContext): Promise<void> {
  if (isOperationActive(ctx.state)) {
    sendError(ctx.res, `A ${ctx.state.operation!.type} operation is already in progress`, 409);
    return;
  }

  startOperation(ctx.state, "enrich");
  const bodyOpts = await jsonBody(ctx.req);

  const queue = new EnrichmentQueue(ctx.db, {
    podcastIds: bodyOpts.podcastIds as string[] | undefined,
    concurrency: bodyOpts.concurrency as number | undefined,
    delayMs: bodyOpts.delayMs as number | undefined,
    verbose: true,
    onProgress: ctx.broadcast,
  });
  ctx.state.enrichQueue = queue;

  sendJson(ctx.res, { ok: true, message: "Enrichment started", ...queue.getStatus() });

  queue.start()
    .then((result) => {
      console.log("Enrichment complete:", JSON.stringify(result, null, 2));
      ctx.broadcast({
        type: "sync:complete",
        results: [{ podcastId: "all", newEpisodes: 0, updatedEpisodes: 0, newTranscripts: result.enriched, errors: result.errors }],
        durationMs: 0,
      });
    })
    .catch((err) => {
      console.error("Enrichment error:", err);
      ctx.broadcast({ type: "sync:error", message: String(err) });
    })
    .finally(() => clearOperation(ctx.state));
}

function stopEnrichment(ctx: RouteContext): void {
  const queue = ctx.state.enrichQueue;
  if (!queue || !queue.running) {
    sendError(ctx.res, "No enrichment is currently running", 404);
    return;
  }
  const status = queue.getStatus();
  queue.stop();
  sendJson(ctx.res, { ok: true, message: "Enrichment stopping", ...status });
}

function enrichmentStatus(ctx: RouteContext): void {
  const podcastIds = ctx.url.searchParams.get("podcast")?.split(",").filter(Boolean);
  const queue = ctx.state.enrichQueue;
  sendJson(ctx.res, {
    needingEnrichment: ctx.db.getEpisodesNeedingEnrichment(podcastIds).length,
    queue: queue?.running ? queue.getStatus() : null,
  });
}

function getAuthStatus(ctx: RouteContext): void {
  const auth = getPodscribeAuthToken();
  sendJson(ctx.res, auth
    ? {
      available: true,
      source: auth.source,
      expiresAt: auth.expiresAt.toISOString(),
      email: auth.email,
      expiresIn: Math.round((auth.expiresAt.getTime() - Date.now()) / 60000) + " min",
    }
    : {
      available: false,
      hint: "Paste a token from Chrome DevTools → Application → Local Storage → app.podscribe.com → accessToken",
    },
  );
}

async function setAuthToken(ctx: RouteContext): Promise<void> {
  const body = await jsonBody(ctx.req);
  const token = body.token as string;
  if (!token) {
    // Clear manual override
    setManualAuthToken(null);
    sendJson(ctx.res, { ok: true, message: "Manual token cleared" });
    return;
  }

  const result = setManualAuthToken(token);
  if (!result) {
    sendError(ctx.res, "Invalid or expired token. Must be a valid JWT starting with 'eyJ'.", 400);
    return;
  }

  // Validate against Podscribe API using an episode that needs transcription
  // (Podscribe may not check auth for already-transcribed episodes)
  const needsWork = ctx.db.getEpisodesNeedingTranscriptRequest();
  const testEp = needsWork.find(ep => ep.podscribeEpisodeId) ?? null;
  if (testEp) {
    const check = await validateAuthToken(token, testEp.podscribeEpisodeId!);
    if (!check.valid) {
      setManualAuthToken(null);
      sendError(ctx.res, `Token was rejected by Podscribe: ${check.error ?? "401 Unauthorized"}. Make sure you copied the full accessToken value.`, 401);
      return;
    }
  }

  sendJson(ctx.res, {
    ok: true,
    source: result.source,
    expiresAt: result.expiresAt.toISOString(),
    email: result.email,
    expiresIn: Math.round((result.expiresAt.getTime() - Date.now()) / 60000) + " min",
  });
}

// ---- Route table ----

const routes: Route[] = [
  // Stats & search
  { method: "GET",    pattern: /^\/api\/stats$/,                          handler: getStats },
  { method: "GET",    pattern: /^\/api\/search$/,                         handler: searchEpisodes },

  // Podcasts CRUD
  { method: "GET",    pattern: /^\/api\/podcasts$/,                       handler: listPodcasts },
  { method: "POST",   pattern: /^\/api\/podcasts$/,                       handler: createPodcast },
  { method: "PUT",    pattern: /^\/api\/podcasts\/([^/]+)$/,              handler: updatePodcast },
  { method: "DELETE", pattern: /^\/api\/podcasts\/([^/]+)$/,              handler: deletePodcast },

  // Episodes
  { method: "GET",    pattern: /^\/api\/episodes$/,                       handler: listEpisodes },
  { method: "POST",   pattern: /^\/api\/episodes\/tag$/,                  handler: tagEpisode },

  // Transcripts (order matters: /structured before /:id)
  { method: "GET",    pattern: /^\/api\/transcript\/(\d+)\/structured$/,  handler: getStructuredTranscript },
  { method: "GET",    pattern: /^\/api\/transcript\/(\d+)$/,              handler: getTranscript },

  // Sync
  { method: "GET",    pattern: /^\/api\/sync\/events$/,                   handler: syncEvents },
  { method: "POST",   pattern: /^\/api\/sync$/,                           handler: triggerSync },
  { method: "POST",   pattern: /^\/api\/sync\/stop$/,                     handler: stopSync },

  // Topics
  { method: "GET",    pattern: /^\/api\/topics\/results$/,                handler: searchTopics },
  { method: "GET",    pattern: /^\/api\/topics$/,                         handler: getTopics },
  { method: "POST",   pattern: /^\/api\/topics$/,                         handler: addTopic },
  { method: "DELETE", pattern: /^\/api\/topics$/,                         handler: removeTopic },

  // Transcript request queue
  { method: "POST",   pattern: /^\/api\/transcripts\/request$/,           handler: requestTranscripts },
  { method: "POST",   pattern: /^\/api\/transcripts\/stop$/,              handler: stopTranscriptRequest },
  { method: "GET",    pattern: /^\/api\/transcripts\/status$/,            handler: transcriptRequestStatus },

  // Enrichment queue
  { method: "POST",   pattern: /^\/api\/transcripts\/enrich$/,            handler: startEnrichment },
  { method: "POST",   pattern: /^\/api\/transcripts\/enrich\/stop$/,      handler: stopEnrichment },
  { method: "GET",    pattern: /^\/api\/transcripts\/enrich\/status$/,    handler: enrichmentStatus },

  // Auth
  { method: "GET",    pattern: /^\/api\/auth$/,                           handler: getAuthStatus },
  { method: "POST",   pattern: /^\/api\/auth$/,                           handler: setAuthToken },
];

// ---- Server ----

export function startServer(port = 3000): void {
  const db = new PodcastDatabase(getDbPath());
  const engine = new QueryEngine(db);

  const state: ServerState = {
    operation: null,
    transcriptQueue: null,
    enrichQueue: null,
    sseClients: new Set(),
  };

  function broadcast(event: SyncProgressEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of state.sseClients) {
      try { client.write(data); }
      catch { state.sseClients.delete(client); }
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ---- API route matching ----
      if (path.startsWith("/api/")) {
        for (const route of routes) {
          if (route.method !== method) continue;
          const match = path.match(route.pattern);
          if (!match) continue;

          const ctx: RouteContext = {
            req, res, url, db, engine, state, broadcast,
            params: match.slice(1),
          };
          await route.handler(ctx);
          return;
        }
        sendError(res, "Not found", 404);
        return;
      }

      // ---- Static file serving ----
      const filePath = path === "/" ? "/index.html" : path;
      const fullPath = resolve(STATIC_DIR, filePath.slice(1));

      if (!fullPath.startsWith(STATIC_DIR)) {
        sendError(res, "Forbidden", 403);
        return;
      }

      if (existsSync(fullPath)) {
        const ext = extname(fullPath);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(readFileSync(fullPath));
      } else {
        const indexPath = resolve(STATIC_DIR, "index.html");
        if (existsSync(indexPath)) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(readFileSync(indexPath));
        } else {
          sendError(res, "Not found", 404);
        }
      }
    } catch (err) {
      console.error("Request error:", err);
      sendError(res, "Internal server error", 500);
    }
  });

  server.listen(port, () => {
    console.log(`Podcast Listener running at http://localhost:${port}`);
    console.log(`API available at http://localhost:${port}/api/`);
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    db.close();
    server.close();
    process.exit(0);
  });
}

// Run directly
const port = parseInt(process.env.PORT ?? "3000", 10);
startServer(port);
