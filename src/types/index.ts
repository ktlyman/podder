/** Core types for the podcast listener system */

export interface PodcastConfig {
  /** Unique slug identifier for the podcast */
  id: string;
  /** Display name */
  name: string;
  /** RSS feed URL */
  feedUrl: string;
  /** Optional Podscribe URL override (e.g. podscribe.app feed page) */
  podscribeUrl?: string;
  /** Tags for categorization */
  tags?: string[];
}

export interface Episode {
  /** Auto-generated storage ID */
  id?: number;
  /** Parent podcast ID (slug) */
  podcastId: string;
  /** Episode GUID from RSS feed */
  guid: string;
  /** Episode title */
  title: string;
  /** Episode description/show notes */
  description: string;
  /** Publication date as ISO string */
  publishedAt: string;
  /** Duration in seconds */
  durationSeconds?: number;
  /** Direct audio URL */
  audioUrl?: string;
  /** Link to episode page */
  episodeUrl?: string;
  /** Transcript text (plain text, concatenated) */
  transcript?: string;
  /** Source of the transcript (e.g. "podscribe", "rss", "whisper") */
  transcriptSource?: string;
  /** When this episode was last synced */
  lastSyncedAt?: string;
}

export interface SearchResult {
  episode: Episode;
  /** Podcast name for display */
  podcastName: string;
  /** Matched text snippet with context */
  snippet: string;
  /** BM25 relevance rank */
  rank: number;
}

export interface SearchOptions {
  /** Free-text search query */
  query: string;
  /** Filter by podcast IDs */
  podcastIds?: string[];
  /** Filter by tags */
  tags?: string[];
  /** Only episodes after this date */
  after?: string;
  /** Only episodes before this date */
  before?: string;
  /** Max results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface SyncResult {
  podcastId: string;
  newEpisodes: number;
  updatedEpisodes: number;
  newTranscripts: number;
  errors: string[];
}

export interface TranscriptAdapter {
  /** Name of this adapter (e.g. "podscribe", "rss-tag") */
  name: string;
  /** Attempt to fetch a transcript for the given episode */
  fetchTranscript(episode: Episode, podcast: PodcastConfig): Promise<string | null>;
}

export interface AgentQueryResult {
  answer: string;
  sources: Array<{
    podcastName: string;
    episodeTitle: string;
    publishedAt: string;
    snippet: string;
    episodeUrl?: string;
  }>;
  totalResults: number;
}

export interface PodcastStats {
  podcastId: string;
  podcastName: string;
  totalEpisodes: number;
  episodesWithTranscripts: number;
  oldestEpisode?: string;
  newestEpisode?: string;
}

export interface SystemStats {
  totalPodcasts: number;
  totalEpisodes: number;
  totalTranscripts: number;
  podcasts: PodcastStats[];
}
