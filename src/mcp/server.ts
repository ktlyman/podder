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
 * - get_structured_transcript: Get word-level transcript with speaker/timestamp data
 * - sync_podcasts: Trigger a sync of podcast feeds
 * - knowledge_base_summary: High-level overview of available content
 * - find_episode: Find episodes by title (fuzzy lookup)
 * - get_episode_details: Full metadata for a single episode
 * - get_transcript_segment: Time-bounded transcript extraction
 * - search_by_speaker: Find content spoken by a specific speaker
 * - tag_episode: Set or clear episode tags for curation
 *
 * This implements the MCP protocol over stdio using JSON-RPC 2.0.
 */

import { createInterface } from "node:readline";
import { getDbPath, loadPodcastConfig } from "../config.js";
import { PodcastDatabase } from "../storage/database.js";
import { QueryEngine } from "../agent/query-engine.js";
import { syncAll } from "../sync.js";
import type { TranscriptFormat } from "../agent/query-engine.js";

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
    name: "get_structured_transcript",
    description:
      "Get word-level transcript data for a specific episode, including timestamps, " +
      "speaker IDs, and confidence scores. Returns null if only plain text is available. " +
      "Use get_transcript for plain text; use this for time-aligned or speaker-segmented analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        episode_id: {
          type: "number",
          description: "The episode database ID",
        },
        format: {
          type: "string",
          enum: ["full", "speakers", "timestamps"],
          description:
            "Output format: 'full' returns all word data as JSON (default), " +
            "'speakers' returns speaker-segmented text blocks with time ranges, " +
            "'timestamps' returns text with periodic [MM:SS] timestamp markers",
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
  {
    name: "find_episode",
    description:
      "Find episodes by title (case-insensitive substring match). " +
      "Returns episode IDs, podcast names, and metadata. Use this to discover " +
      "episode IDs before calling get_transcript or get_episode_details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Title substring to search for (e.g. 'Turing', 'AI safety')",
        },
        podcast_id: {
          type: "string",
          description: "Optional: filter to a specific podcast",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "get_episode_details",
    description:
      "Get full metadata for a single episode by its database ID. " +
      "Returns title, publication date, duration, URLs, tags, transcript word count, " +
      "and whether structured (speaker/timestamp) data is available. " +
      "Does NOT return the transcript text itself — use get_transcript for that.",
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
    name: "get_transcript_segment",
    description:
      "Get a time-bounded segment of a transcript. Requires structured transcript data. " +
      "Returns only the words spoken between start_time and end_time, formatted with " +
      "speaker labels and timestamps. Much more token-efficient than retrieving the full transcript " +
      "when you only need a specific portion.",
    inputSchema: {
      type: "object" as const,
      properties: {
        episode_id: {
          type: "number",
          description: "The episode database ID",
        },
        start_time: {
          type: "number",
          description: "Start time in seconds (e.g. 300 for 5:00)",
        },
        end_time: {
          type: "number",
          description: "End time in seconds (e.g. 600 for 10:00)",
        },
        format: {
          type: "string",
          enum: ["speakers", "timestamps", "text"],
          description:
            "Output format: 'speakers' (default) shows speaker-labeled blocks with time ranges, " +
            "'timestamps' inserts periodic [MM:SS] markers, 'text' returns plain concatenated words",
        },
      },
      required: ["episode_id", "start_time", "end_time"],
    },
  },
  {
    name: "search_by_speaker",
    description:
      "Find content spoken by a specific speaker. Two modes: " +
      "(1) With episode_id: returns everything the speaker said in that episode. " +
      "(2) With query: searches across all episodes and filters to content from the specified speaker. " +
      "Requires structured transcript data (episodes without it are skipped). " +
      "Speaker IDs are 0-based (0 = first speaker, 1 = second speaker, etc.).",
    inputSchema: {
      type: "object" as const,
      properties: {
        speaker: {
          type: "number",
          description: "Speaker ID (0-based: 0 = first speaker, 1 = second, etc.)",
        },
        episode_id: {
          type: "number",
          description: "Optional: get all of this speaker's content from a specific episode",
        },
        query: {
          type: "string",
          description: "Optional: FTS search query to find relevant episodes first (required if no episode_id)",
        },
        podcast_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional: filter by podcast IDs (only used with query mode)",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
      required: ["speaker"],
    },
  },
  {
    name: "tag_episode",
    description:
      "Set or clear a tag on an episode for curation purposes. " +
      "Common tags: 'Promo' (promotional episodes), 'Repeat Episode' (duplicates), " +
      "'No transcript' (unavailable). Tagged episodes are excluded from transcript " +
      "processing pipelines. Set tag to null to clear an existing tag.",
    inputSchema: {
      type: "object" as const,
      properties: {
        episode_id: {
          type: "number",
          description: "The episode database ID",
        },
        tag: {
          type: "string",
          description: "Tag to set (e.g. 'Promo', 'Repeat Episode', 'No transcript'), or null to clear",
        },
      },
      required: ["episode_id"],
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

      case "get_structured_transcript": {
        const formatted = this.engine.getFormattedStructuredTranscript(
          args.episode_id as number,
          (args.format as TranscriptFormat) ?? "full"
        );
        text = formatted ??
          "No structured transcript data available for this episode. " +
          "Only plain text may be available (use get_transcript).";
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
        });
        text = JSON.stringify(results, null, 2);
        break;
      }

      case "knowledge_base_summary": {
        text = this.engine.getKnowledgeBaseSummary();
        break;
      }

      case "find_episode": {
        const results = this.engine.findEpisode(
          args.title as string,
          args.podcast_id as string | undefined,
          (args.limit as number) ?? 10
        );
        if (results.length === 0) {
          text = `No episodes found matching "${args.title}".`;
        } else {
          text = JSON.stringify(results, null, 2);
        }
        break;
      }

      case "get_episode_details": {
        const details = this.engine.getEpisodeDetails(
          args.episode_id as number
        );
        if (!details) {
          text = `Episode ${args.episode_id} not found.`;
        } else {
          text = JSON.stringify(details, null, 2);
        }
        break;
      }

      case "get_transcript_segment": {
        const segment = this.engine.getTranscriptSegment(
          args.episode_id as number,
          args.start_time as number,
          args.end_time as number,
          (args.format as "speakers" | "timestamps" | "text") ?? "speakers"
        );
        if (segment === null) {
          text =
            "No structured transcript data available for this episode. " +
            "Time-bounded segments require word-level data with timestamps. " +
            "Use get_transcript for the full plain text instead.";
        } else {
          text = segment;
        }
        break;
      }

      case "search_by_speaker": {
        const speakerResult = this.engine.searchBySpeaker({
          speaker: args.speaker as number,
          episodeId: args.episode_id as number | undefined,
          query: args.query as string | undefined,
          podcastIds: args.podcast_ids as string[] | undefined,
          limit: (args.limit as number) ?? 10,
        });
        if (speakerResult.totalResults === 0) {
          const mode = args.episode_id ? "in this episode" : "matching the query";
          text = `No content found from Speaker ${(args.speaker as number) + 1} ${mode}. ` +
            `Note: speaker search requires structured transcript data (not all episodes have it).`;
        } else {
          text = JSON.stringify(speakerResult, null, 2);
        }
        break;
      }

      case "tag_episode": {
        const tagResult = this.engine.tagEpisode(
          args.episode_id as number,
          (args.tag as string) ?? null
        );
        text = JSON.stringify(tagResult, null, 2);
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
