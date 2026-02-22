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
  SearchOptions,
  SearchResult,
  SystemStats,
} from "../types/index.js";

export class QueryEngine {
  private db: PodcastDatabase;

  constructor(db: PodcastDatabase) {
    this.db = db;
  }

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
   * Get the full transcript for a specific episode by its database ID.
   */
  getTranscript(episodeId: number): string | null {
    return this.db.getTranscript(episodeId);
  }

  /**
   * List all tracked podcasts with their stats.
   */
  getStats(): SystemStats {
    return this.db.getStats();
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

  /**
   * Get recent episodes for a podcast (with or without transcript).
   */
  getRecentEpisodes(
    podcastId: string,
    limit = 10
  ): Array<{
    title: string;
    publishedAt: string;
    hasTranscript: boolean;
    episodeUrl?: string;
  }> {
    const episodes = this.db.listEpisodes(podcastId, { limit });
    return episodes.map((e) => ({
      title: e.title,
      publishedAt: e.publishedAt,
      hasTranscript: !!e.transcript,
      episodeUrl: e.episodeUrl,
    }));
  }

  /**
   * Get a text-based summary of the entire knowledge base.
   * Useful as context for an agent conversation.
   */
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

  /**
   * Retrieve context for an agent prompt about a specific topic.
   * Returns a formatted text block suitable for injection into an LLM prompt.
   */
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
