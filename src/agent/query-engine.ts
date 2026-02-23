/**
 * Agent query engine - provides a high-level interface for AI agents
 * to search and retrieve podcast knowledge, similar to a RAG database.
 *
 * Designed so an agent (Claude, etc.) can ask natural-language questions
 * and get structured, source-attributed answers.
 */

import type { PodcastDatabase } from "../storage/database.js";
import type {
  AgentQueryResult,
  EpisodeDetails,
  EpisodeListEntry,
  EpisodeSummary,
  SearchOptions,
  SearchResult,
  SpeakerSearchResult,
  SystemStats,
  TagResult,
  TranscriptWord,
} from "../types/index.js";
import { formatSpeakerBlocks, formatWithTimestamps } from "../utils/format-transcript.js";

/** Transcript format options used by structured/segment endpoints */
export type TranscriptFormat = "full" | "speakers" | "timestamps" | "text";

export class QueryEngine {
  private db: PodcastDatabase;

  /** Cached podcast ID → name map (invalidated on access after 60s) */
  private podcastNameCache: Map<string, string> | null = null;
  private podcastNameCacheAge = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(db: PodcastDatabase) {
    this.db = db;
  }

  // ---- Podcast name cache ----

  /** Get podcast name by ID (uses cache to avoid repeated full-table scans) */
  private getPodcastName(podcastId: string): string {
    const cache = this.ensurePodcastNameCache();
    return cache.get(podcastId) ?? podcastId;
  }

  private ensurePodcastNameCache(): Map<string, string> {
    const now = Date.now();
    if (!this.podcastNameCache || now - this.podcastNameCacheAge > QueryEngine.CACHE_TTL_MS) {
      const podcasts = this.db.listPodcasts();
      this.podcastNameCache = new Map(podcasts.map((p) => [p.id, p.name]));
      this.podcastNameCacheAge = now;
    }
    return this.podcastNameCache;
  }

  // ---- Search ----

  /**
   * Search for episodes matching a query.
   * Returns structured results with snippets and source attribution.
   */
  search(options: SearchOptions): AgentQueryResult {
    const results = this.db.search(options);

    return {
      answer: this.formatSearchSummary(options.query, results),
      sources: results.map((r) => ({
        podcastName: r.podcastName,
        episodeTitle: r.episode.title,
        publishedAt: r.episode.publishedAt,
        snippet: r.snippet,
        episodeUrl: r.episode.episodeUrl,
      })),
      totalResults: results.length,
    };
  }

  /**
   * Find episodes about a topic across all podcasts.
   * Convenience wrapper for agents to do a simple topic lookup.
   */
  findEpisodesAbout(
    topic: string,
    options?: { podcastIds?: string[]; limit?: number }
  ): AgentQueryResult {
    return this.search({
      query: topic,
      podcastIds: options?.podcastIds,
      limit: options?.limit ?? 10,
    });
  }

  // ---- Transcripts ----

  /** Get the full transcript for a specific episode by its database ID. */
  getTranscript(episodeId: number): string | null {
    return this.db.getTranscript(episodeId);
  }

  /** Get the structured word-level transcript for an episode. */
  getStructuredTranscript(episodeId: number): TranscriptWord[] | null {
    return this.db.getStructuredTranscript(episodeId);
  }

  /** Check if an episode has structured transcript data available. */
  hasStructuredTranscript(episodeId: number): boolean {
    return this.db.hasStructuredTranscript(episodeId);
  }

  /**
   * Get a formatted structured transcript in the requested format.
   * Centralises the format-switching logic (used by MCP tools).
   */
  getFormattedStructuredTranscript(
    episodeId: number,
    format: TranscriptFormat = "full"
  ): string | null {
    const words = this.db.getStructuredTranscript(episodeId);
    if (!words) return null;

    switch (format) {
      case "speakers":
        return formatSpeakerBlocks(words);
      case "timestamps":
        return formatWithTimestamps(words);
      case "text":
        return words.map((w) => w.word).join(" ");
      case "full":
      default:
        return JSON.stringify({ wordCount: words.length, words }, null, 2);
    }
  }

  /**
   * Get a time-bounded segment of a structured transcript.
   * Returns words between startTime and endTime, formatted as requested.
   */
  getTranscriptSegment(
    episodeId: number,
    startTime: number,
    endTime: number,
    format: "speakers" | "timestamps" | "text" = "speakers"
  ): string | null {
    const words = this.db.getStructuredTranscript(episodeId);
    if (!words) return null;

    const segment = words.filter(
      (w) => w.startTime >= startTime && w.startTime <= endTime
    );

    if (segment.length === 0) {
      return `No words found between ${fmtTime(startTime)} and ${fmtTime(endTime)}.`;
    }

    const header = `Transcript segment: ${fmtTime(startTime)} – ${fmtTime(endTime)} (${segment.length} words)\n\n`;

    switch (format) {
      case "speakers":
        return header + formatSpeakerBlocks(segment);
      case "timestamps":
        return header + formatWithTimestamps(segment);
      case "text":
        return header + segment.map((w) => w.word).join(" ");
    }
  }

  // ---- Episode listing & lookup ----

  /** List all tracked podcasts with their stats. */
  getStats(): SystemStats {
    return this.db.getStats();
  }

  /** Get recent episodes for a podcast (with or without transcript). */
  getRecentEpisodes(podcastId: string, limit = 10, offset = 0): EpisodeListEntry[] {
    const episodes = this.db.listEpisodes(podcastId, { limit, offset });
    return episodes.map((e) => ({
      id: e.id,
      title: e.title,
      publishedAt: e.publishedAt,
      hasTranscript: !!e.transcript,
      episodeUrl: e.episodeUrl,
      podscribeEpisodeId: e.podscribeEpisodeId,
      podscribeUrl: e.podscribeUrl,
      episodeTag: e.episodeTag,
    }));
  }

  /** Find episodes by title substring (case-insensitive). */
  findEpisode(titleQuery: string, podcastId?: string, limit = 10): EpisodeSummary[] {
    const results = this.db.findEpisodesByTitle(titleQuery, podcastId, limit);
    return results.map(({ episode, podcastName }) => ({
      id: episode.id,
      title: episode.title,
      podcastName,
      podcastId: episode.podcastId,
      publishedAt: episode.publishedAt,
      hasTranscript: !!episode.transcript,
      hasStructuredData: episode.id ? this.db.hasStructuredTranscript(episode.id) : false,
      episodeTag: episode.episodeTag,
      episodeUrl: episode.episodeUrl,
    }));
  }

  /**
   * Get full metadata for a single episode by its database ID.
   * Omits the transcript body — use getTranscript() for that.
   */
  getEpisodeDetails(episodeId: number): EpisodeDetails | null {
    const episode = this.db.getEpisodeById(episodeId);
    if (!episode) return null;

    const hasStructured = this.db.hasStructuredTranscript(episodeId);

    const transcriptWordCount = episode.transcript
      ? episode.transcript.split(/\s+/).length
      : undefined;

    // Strip transcript body to keep response lightweight
    const { transcript: _t, ...metadata } = episode;

    return {
      episode: { ...metadata, transcript: undefined },
      podcastName: this.getPodcastName(episode.podcastId),
      hasStructuredData: hasStructured,
      transcriptWordCount,
    };
  }

  // ---- Speaker search ----

  /**
   * Search for content spoken by a specific speaker.
   *
   * Two modes:
   * - With episodeId: returns what the speaker said in that episode
   * - With query (no episodeId): FTS search, then filters to the specified speaker
   */
  searchBySpeaker(options: {
    speaker: number;
    episodeId?: number;
    query?: string;
    podcastIds?: string[];
    limit?: number;
  }): SpeakerSearchResult {
    const { speaker, episodeId, query, podcastIds, limit = 10 } = options;

    // Mode 1: Single episode — extract everything the speaker said
    if (episodeId !== undefined) {
      return this.speakerFromEpisode(episodeId, speaker);
    }

    // Mode 2: Cross-episode search — FTS first, then filter by speaker
    if (!query) {
      return { results: [], totalResults: 0 };
    }

    return this.speakerAcrossEpisodes(query, speaker, podcastIds, limit);
  }

  private speakerFromEpisode(episodeId: number, speaker: number): SpeakerSearchResult {
    const words = this.db.getStructuredTranscript(episodeId);
    if (!words) return { results: [], totalResults: 0 };

    const speakerWords = words.filter((w) => w.speaker === speaker);
    if (speakerWords.length === 0) return { results: [], totalResults: 0 };

    const episode = this.db.getEpisodeById(episodeId);

    return {
      results: [{
        episodeId,
        episodeTitle: episode?.title ?? "Unknown",
        podcastName: this.getPodcastName(episode?.podcastId ?? ""),
        speakerText: formatSpeakerBlocks(speakerWords),
      }],
      totalResults: 1,
    };
  }

  private speakerAcrossEpisodes(
    query: string,
    speaker: number,
    podcastIds: string[] | undefined,
    limit: number
  ): SpeakerSearchResult {
    const searchResults = this.db.search({
      query,
      podcastIds,
      limit: limit * 3, // fetch extra since we'll filter some out
    });

    const results: SpeakerSearchResult["results"] = [];

    for (const sr of searchResults) {
      if (results.length >= limit) break;
      if (!sr.episode.id) continue;

      const words = this.db.getStructuredTranscript(sr.episode.id);
      if (!words) continue;

      const speakerWords = words.filter((w) => w.speaker === speaker);
      if (speakerWords.length === 0) continue;

      // Only include speaker blocks that contain search terms
      const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      const blocks = groupBySpeakerRuns(speakerWords);
      const matchingBlocks = blocks.filter((block) => {
        const text = block.map((w) => w.word).join(" ").toLowerCase();
        return queryTerms.some((term) => text.includes(term));
      });

      if (matchingBlocks.length === 0) continue;

      results.push({
        episodeId: sr.episode.id,
        episodeTitle: sr.episode.title,
        podcastName: sr.podcastName,
        speakerText: formatSpeakerBlocks(matchingBlocks.flat()),
      });
    }

    return { results, totalResults: results.length };
  }

  // ---- Tags ----

  /** Set or clear an episode tag. */
  tagEpisode(episodeId: number, tag: string | null): TagResult {
    const episode = this.db.getEpisodeById(episodeId);
    if (!episode) {
      return { success: false, message: `Episode ${episodeId} not found.` };
    }
    this.db.setEpisodeTag(episode.podcastId, episode.guid, tag);
    const action = tag ? `Tagged as "${tag}"` : "Tag cleared";
    return { success: true, message: `${action}: "${episode.title}"` };
  }

  // ---- Knowledge base summary ----

  /** Get a text-based summary of the entire knowledge base. */
  getKnowledgeBaseSummary(): string {
    const stats = this.db.getStats();

    const lines = [
      `Podcast Knowledge Base Summary`,
      `==============================`,
      `Total podcasts tracked: ${stats.totalPodcasts}`,
      `Total episodes indexed: ${stats.totalEpisodes}`,
      `Episodes with transcripts: ${stats.totalTranscripts}`,
      ``,
      `Podcasts:`,
    ];

    for (const p of stats.podcasts) {
      lines.push(
        `  - ${p.podcastName}: ${p.totalEpisodes} episodes (${p.episodesWithTranscripts} with transcripts)`
      );
      if (p.oldestEpisode) {
        lines.push(
          `    Date range: ${p.oldestEpisode.split("T")[0]} to ${(p.newestEpisode ?? "").split("T")[0]}`
        );
      }
    }

    return lines.join("\n");
  }

  /** Retrieve context for an agent prompt about a specific topic. */
  getContextForTopic(topic: string, maxResults = 5): string {
    const results = this.db.search({ query: topic, limit: maxResults });

    if (results.length === 0) {
      return `No podcast episodes found matching "${topic}".`;
    }

    const sections = results.map((r, i) => {
      const date = r.episode.publishedAt.split("T")[0];
      return [
        `[Source ${i + 1}] ${r.podcastName} - "${r.episode.title}" (${date})`,
        r.snippet.replace(/>>>>/g, "**").replace(/<<<</, "**"),
        r.episode.episodeUrl ? `Link: ${r.episode.episodeUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    });

    return [
      `Found ${results.length} relevant podcast episode(s) for "${topic}":`,
      "",
      ...sections,
    ].join("\n\n");
  }

  // ---- Private helpers ----

  private formatSearchSummary(query: string, results: SearchResult[]): string {
    if (results.length === 0) {
      return `No results found for "${query}".`;
    }

    const podcastSet = new Set(results.map((r) => r.podcastName));
    return (
      `Found ${results.length} result(s) for "${query}" ` +
      `across ${podcastSet.size} podcast(s): ${[...podcastSet].join(", ")}.`
    );
  }
}

// ---- Module-level utility functions ----

/** Format seconds as H:MM:SS or MM:SS */
function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Group words into runs of consecutive same-speaker words */
function groupBySpeakerRuns(words: TranscriptWord[]): TranscriptWord[][] {
  if (words.length === 0) return [];
  const runs: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    if (words[i].speaker !== words[i - 1].speaker ||
        words[i].startTime - words[i - 1].endTime > 30) {
      runs.push(current);
      current = [];
    }
    current.push(words[i]);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}
