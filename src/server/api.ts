#!/usr/bin/env node

/**
 * HTTP API server for the podcast listener frontend.
 * Uses only Node.js built-ins (no express needed) to keep dependencies minimal.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDbPath, loadPodcastConfig, getDataDir } from "../config.js";
import { PodcastDatabase } from "../storage/database.js";
import { QueryEngine } from "../agent/query-engine.js";
import { syncAll, syncPodcast } from "../sync.js";
import type { PodcastConfig } from "../types/index.js";

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

function getConfigPath(): string {
  return resolve(process.env.PODSCRIBE_CONFIG ?? "podcasts.json");
}

/** Load topics watchlist from data dir */
function loadTopics(): string[] {
  const path = resolve(getDataDir(), "topics.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Save topics watchlist */
function saveTopics(topics: string[]): void {
  const dir = getDataDir();
  const path = resolve(dir, "topics.json");
  writeFileSync(path, JSON.stringify(topics, null, 2));
}

/** Save podcast config to podcasts.json */
function savePodcastConfig(podcasts: PodcastConfig[]): void {
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(podcasts, null, 2));
}

export function startServer(port = 3000): void {
  const db = new PodcastDatabase(getDbPath());
  const engine = new QueryEngine(db);

  // Track active sync to prevent concurrent runs
  let syncInProgress = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS headers for development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ---- API routes ----
      if (path.startsWith("/api/")) {
        return await handleApi(path, method, url, req, res, db, engine);
      }

      // ---- Static file serving ----
      let filePath = path === "/" ? "/index.html" : path;
      const fullPath = resolve(STATIC_DIR, filePath.slice(1));

      // Prevent directory traversal
      if (!fullPath.startsWith(STATIC_DIR)) {
        sendError(res, "Forbidden", 403);
        return;
      }

      if (existsSync(fullPath)) {
        const ext = extname(fullPath);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        const content = readFileSync(fullPath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      } else {
        // SPA fallback - serve index.html for unmatched routes
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

  async function handleApi(
    path: string,
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
    db: PodcastDatabase,
    engine: QueryEngine
  ): Promise<void> {
    // GET /api/stats
    if (path === "/api/stats" && method === "GET") {
      sendJson(res, engine.getStats());
      return;
    }

    // GET /api/podcasts
    if (path === "/api/podcasts" && method === "GET") {
      sendJson(res, db.listPodcasts());
      return;
    }

    // POST /api/podcasts - add a new podcast
    if (path === "/api/podcasts" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { id, name, feedUrl, tags } = body;
      if (!id || !name || !feedUrl) {
        sendError(res, "Missing required fields: id, name, feedUrl");
        return;
      }

      const config: PodcastConfig = {
        id,
        name,
        feedUrl,
        tags: tags ?? [],
      };

      db.upsertPodcast(config);

      // Also persist to config file
      const existing = loadPodcastConfig(getConfigPath());
      const updated = existing.filter((p) => p.id !== id);
      updated.push(config);
      savePodcastConfig(updated);

      sendJson(res, { ok: true, podcast: config }, 201);
      return;
    }

    // DELETE /api/podcasts/:id
    const podcastDeleteMatch = path.match(/^\/api\/podcasts\/([^/]+)$/);
    if (podcastDeleteMatch && method === "DELETE") {
      const podcastId = decodeURIComponent(podcastDeleteMatch[1]);
      const existing = loadPodcastConfig(getConfigPath());
      const updated = existing.filter((p) => p.id !== podcastId);
      if (updated.length === existing.length) {
        sendError(res, "Podcast not found", 404);
        return;
      }
      savePodcastConfig(updated);
      sendJson(res, { ok: true });
      return;
    }

    // GET /api/episodes?podcast=<id>&limit=<n>
    if (path === "/api/episodes" && method === "GET") {
      const podcastId = url.searchParams.get("podcast") ?? "";
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const episodes = engine.getRecentEpisodes(podcastId, limit);
      sendJson(res, episodes);
      return;
    }

    // GET /api/search?q=<query>&podcast=<ids>&tag=<tags>&after=<date>&before=<date>&limit=<n>
    if (path === "/api/search" && method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      if (!query) {
        sendError(res, "Missing query parameter 'q'");
        return;
      }
      const podcastIds = url.searchParams.get("podcast")?.split(",").filter(Boolean);
      const tags = url.searchParams.get("tag")?.split(",").filter(Boolean);
      const after = url.searchParams.get("after") ?? undefined;
      const before = url.searchParams.get("before") ?? undefined;
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);

      const result = engine.search({
        query,
        podcastIds,
        tags,
        after,
        before,
        limit,
      });
      sendJson(res, result);
      return;
    }

    // GET /api/transcript/:id
    const transcriptMatch = path.match(/^\/api\/transcript\/(\d+)$/);
    if (transcriptMatch && method === "GET") {
      const episodeId = parseInt(transcriptMatch[1], 10);
      const transcript = engine.getTranscript(episodeId);
      if (!transcript) {
        sendError(res, "Transcript not found", 404);
        return;
      }
      sendJson(res, { transcript });
      return;
    }

    // POST /api/sync - trigger a sync
    if (path === "/api/sync" && method === "POST") {
      if (syncInProgress) {
        sendError(res, "Sync already in progress", 409);
        return;
      }

      syncInProgress = true;
      const body = await readBody(req);
      const opts = body ? JSON.parse(body) : {};
      const podcastId = opts.podcastId as string | undefined;

      // Run sync asynchronously
      const podcasts = loadPodcastConfig(getConfigPath());
      const targets = podcastId
        ? podcasts.filter((p) => p.id === podcastId)
        : podcasts;

      // Register podcasts in DB first
      for (const p of targets) db.upsertPodcast(p);

      sendJson(res, { ok: true, message: "Sync started", count: targets.length });

      // Fire and forget sync in background
      syncAll(targets, db, {
        verbose: true,
        maxTranscriptFetches: 5,
        maxEpisodesPerFeed: 100,
      })
        .then((results) => {
          console.log("Sync complete:", JSON.stringify(results, null, 2));
        })
        .catch((err) => {
          console.error("Sync error:", err);
        })
        .finally(() => {
          syncInProgress = false;
        });
      return;
    }

    // GET /api/topics
    if (path === "/api/topics" && method === "GET") {
      sendJson(res, loadTopics());
      return;
    }

    // POST /api/topics - add a topic
    if (path === "/api/topics" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      const topic = body.topic as string;
      if (!topic) {
        sendError(res, "Missing 'topic' field");
        return;
      }
      const topics = loadTopics();
      if (!topics.includes(topic)) {
        topics.push(topic);
        saveTopics(topics);
      }
      sendJson(res, { ok: true, topics }, 201);
      return;
    }

    // DELETE /api/topics - remove a topic
    if (path === "/api/topics" && method === "DELETE") {
      const body = JSON.parse(await readBody(req));
      const topic = body.topic as string;
      if (!topic) {
        sendError(res, "Missing 'topic' field");
        return;
      }
      const topics = loadTopics().filter((t) => t !== topic);
      saveTopics(topics);
      sendJson(res, { ok: true, topics });
      return;
    }

    // GET /api/topics/results - search all watched topics
    if (path === "/api/topics/results" && method === "GET") {
      const topics = loadTopics();
      const limit = parseInt(url.searchParams.get("limit") ?? "5", 10);

      const results: Record<string, unknown> = {};
      for (const topic of topics) {
        try {
          results[topic] = engine.search({ query: topic, limit });
        } catch {
          results[topic] = { answer: "Search failed", sources: [], totalResults: 0 };
        }
      }
      sendJson(res, results);
      return;
    }

    sendError(res, "Not found", 404);
  }

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
