#!/usr/bin/env node

/**
 * MCP (Model Context Protocol) server for the podcast knowledge base.
 *
 * Exposes the podcast knowledge base as an MCP server that can be used
 * by Claude Code, Claude Desktop, or any MCP-compatible AI agent.
 *
 * Tools provided:
 * - search_podcasts: Full-text search across transcripts
 * - get_context: Get formatted context for a topic (RAG-style)
 * - list_podcasts: List tracked podcasts with stats
 * - get_episodes: List episodes for a podcast
 * - get_transcript: Get full transcript for an episode
 * - sync_podcasts: Trigger a sync of podcast feeds
 *
 * This implements the MCP protocol over stdio using JSON-RPC 2.0.
 */

import { createInterface } from "node:readline";
import { getDbPath, loadPodcastConfig } from "../config.js";
import { PodcastDatabase } from "../storage/database.js";
import { QueryEngine } from "../agent/query-engine.js";
import { syncAll } from "../sync.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOL_DEFINITIONS = [
  {
    name: "search_podcasts",
    description:
      "Search across all podcast transcripts and episode metadata. " +
      "Supports FTS5 query syntax: AND, OR, NOT, \"exact phrase\", prefix*. " +
      "Returns ranked results with text snippets and source attribution.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query text" },
        podcast_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional: filter by podcast IDs",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional: filter by tags",
        },
        after: {
          type: "string",
          description: "Optional: only episodes after this date (ISO 8601)",
        },
        before: {
          type: "string",
          description: "Optional: only episodes before this date (ISO 8601)",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_context",
    description:
      "Get formatted context about a topic from the podcast knowledge base. " +
      "Returns a text block suitable for injection into an LLM prompt, " +
      "with source attribution. Similar to RAG retrieval.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          description: "The topic to retrieve context for",
        },
        max_results: {
          type: "number",
          description: "Max sources to include (default 5)",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "list_podcasts",
    description:
      "List all tracked podcasts with episode counts and transcript coverage statistics.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_episodes",
    description: "List recent episodes for a specific podcast.",
    inputSchema: {
      type: "object" as const,
      properties: {
        podcast_id: {
          type: "string",
          description: "The podcast ID to list episodes for",
        },
        limit: {
          type: "number",
          description: "Max episodes to return (default 10)",
        },
      },
      required: ["podcast_id"],
    },
  },
  {
    name: "get_transcript",
    description: "Get the full transcript text for a specific episode by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        episode_id: {
          type: "number",
          description: "The episode database ID",
        },
      },
      required: ["episode_id"],
    },
  },
  {
    name: "sync_podcasts",
    description:
      "Trigger a sync of podcast RSS feeds and transcript fetching. " +
      "Use this to update the knowledge base with new episodes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        podcast_id: {
          type: "string",
          description: "Optional: sync only a specific podcast",
        },
      },
    },
  },
  {
    name: "knowledge_base_summary",
    description:
      "Get a high-level text summary of the entire podcast knowledge base. " +
      "Useful for understanding what content is available before searching.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

class MCPServer {
  private db: PodcastDatabase;
  private engine: QueryEngine;

  constructor() {
    this.db = new PodcastDatabase(getDbPath());
    this.engine = new QueryEngine(this.db);
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const result = await this.dispatch(request.method, request.params ?? {});
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "podcast-listener-podscribe",
            version: "1.0.0",
          },
        };

      case "notifications/initialized":
        return {};

      case "tools/list":
        return { tools: TOOL_DEFINITIONS };

      case "tools/call":
        return this.handleToolCall(
          params.name as string,
          (params.arguments ?? {}) as Record<string, unknown>
        );

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    let text: string;

    switch (name) {
      case "search_podcasts": {
        const result = this.engine.search({
          query: args.query as string,
          podcastIds: args.podcast_ids as string[] | undefined,
          tags: args.tags as string[] | undefined,
          after: args.after as string | undefined,
          before: args.before as string | undefined,
          limit: (args.limit as number) ?? 10,
        });
        text = JSON.stringify(result, null, 2);
        break;
      }

      case "get_context": {
        text = this.engine.getContextForTopic(
          args.topic as string,
          (args.max_results as number) ?? 5
        );
        break;
      }

      case "list_podcasts": {
        const stats = this.engine.getStats();
        text = JSON.stringify(stats, null, 2);
        break;
      }

      case "get_episodes": {
        const episodes = this.engine.getRecentEpisodes(
          args.podcast_id as string,
          (args.limit as number) ?? 10
        );
        text = JSON.stringify(episodes, null, 2);
        break;
      }

      case "get_transcript": {
        const transcript = this.engine.getTranscript(
          args.episode_id as number
        );
        text = transcript ?? "No transcript found for this episode.";
        break;
      }

      case "sync_podcasts": {
        const podcasts = loadPodcastConfig();
        const targets = args.podcast_id
          ? podcasts.filter((p) => p.id === args.podcast_id)
          : podcasts;

        if (targets.length === 0) {
          text = `Podcast "${args.podcast_id}" not found in config.`;
          break;
        }

        const results = await syncAll(targets, this.db, {
          verbose: false,
          maxTranscriptFetches: 5,
        });
        text = JSON.stringify(results, null, 2);
        break;
      }

      case "knowledge_base_summary": {
        text = this.engine.getKnowledgeBaseSummary();
        break;
      }

      default:
        text = `Unknown tool: ${name}`;
    }

    return { content: [{ type: "text", text }] };
  }

  close(): void {
    this.db.close();
  }
}

// Main: Run MCP server over stdio
const server = new MCPServer();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    const response = await server.handleRequest(request);

    // Notifications don't get responses
    if (request.id !== undefined) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    const errResponse: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      error: {
        code: -32700,
        message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
    process.stdout.write(JSON.stringify(errResponse) + "\n");
  }
});

rl.on("close", () => {
  server.close();
  process.exit(0);
});

process.stderr.write("Podcast Listener MCP Server started.\n");
