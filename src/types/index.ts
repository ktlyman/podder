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
  /** Podscribe series ID for backend API access (e.g. "188") */
  podscribeSeriesId?: string;
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
  /** Podscribe internal episode ID */
  podscribeEpisodeId?: number;
  /** URL to this episode on app.podscribe.com (for manual transcript requests) */
  podscribeUrl?: string;
  /** Cached Podscribe transcription status ("Done", "NotStarted", etc.) */
  podscribeTranscriptStatus?: string;
  /** When the Podscribe transcript status was last checked (ISO string) */
  podscribeStatusCheckedAt?: string;
  /** Episode-level tag (e.g. "Promo", "Repeat Episode", "No transcript") */
  episodeTag?: string;
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

// ---- Structured transcript data ----

/** Per-word transcript data from speech-to-text systems (e.g., Podscribe) */
export interface TranscriptWord {
  /** The transcribed word */
  word: string;
  /** Speaker diarization ID (0-based) */
  speaker: number;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Confidence score 0-1 */
  confidence: number;
}

/** Structured transcript result containing both plain text and word-level data */
export interface TranscriptResult {
  /** Plain text transcript (speaker-formatted when diarization is available) */
  text: string;
  /** Per-word structured data with timestamps, speaker IDs, and confidence */
  words: TranscriptWord[];
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
  /** Counts of episodes by episode_tag (e.g. { "Promo": 19, "Repeat Episode": 9 }) */
  tagCounts?: Record<string, number>;
  /** Number of episodes with enriched (word-level) transcript data */
  enrichedTranscripts?: number;
}

// ---- Query engine return types ----

/** Summary of an episode for list/search results (no transcript body) */
export interface EpisodeSummary {
  id?: number;
  title: string;
  podcastName: string;
  podcastId: string;
  publishedAt: string;
  hasTranscript: boolean;
  hasStructuredData: boolean;
  episodeTag?: string;
  episodeUrl?: string;
}

/** Lightweight episode listing entry (used by get_episodes) */
export interface EpisodeListEntry {
  id?: number;
  title: string;
  publishedAt: string;
  hasTranscript: boolean;
  episodeUrl?: string;
  podscribeEpisodeId?: number;
  podscribeUrl?: string;
  episodeTag?: string;
}

/** Full episode metadata without the transcript body (used by get_episode_details) */
export interface EpisodeDetails {
  episode: Episode;
  podcastName: string;
  hasStructuredData: boolean;
  transcriptWordCount?: number;
}

/** Result from a speaker-specific search */
export interface SpeakerSearchResult {
  results: Array<{
    episodeId: number;
    episodeTitle: string;
    podcastName: string;
    speakerText: string;
  }>;
  totalResults: number;
}

/** Result of a tag operation */
export interface TagResult {
  success: boolean;
  message: string;
}

// ---- Sync progress events (SSE) ----

/** Phase identifiers for sync progress */
export type SyncPhase = "feed" | "status" | "download" | "fallback" | "request" | "poll" | "enrich";

/** Callback for reporting progress events during sync */
export type SyncProgressCallback = (event: SyncProgressEvent) => void;

/** Discriminated union for all sync progress events */
export type SyncProgressEvent =
  | SyncStartEvent
  | PodcastStartEvent
  | PhaseStartEvent
  | PhaseProgressEvent
  | PhaseCompleteEvent
  | PodcastCompleteEvent
  | SyncCompleteEvent
  | SyncErrorEvent
  | EpisodeStatusEvent;

export interface SyncStartEvent {
  type: "sync:start";
  totalPodcasts: number;
  podcastIds: string[];
}

export interface PodcastStartEvent {
  type: "podcast:start";
  podcastId: string;
  podcastName: string;
  podcastIndex: number;
  totalPodcasts: number;
}

export interface PhaseStartEvent {
  type: "phase:start";
  podcastId: string;
  phase: SyncPhase;
  total: number;
  message: string;
}

export interface PhaseProgressEvent {
  type: "phase:progress";
  podcastId: string;
  phase: SyncPhase;
  completed: number;
  total: number;
  message?: string;
}

export interface PhaseCompleteEvent {
  type: "phase:complete";
  podcastId: string;
  phase: SyncPhase;
  summary: string;
}

export interface PodcastCompleteEvent {
  type: "podcast:complete";
  podcastId: string;
  podcastName: string;
  result: SyncResult;
}

export interface SyncCompleteEvent {
  type: "sync:complete";
  results: SyncResult[];
  durationMs: number;
}

export interface SyncErrorEvent {
  type: "sync:error";
  podcastId?: string;
  message: string;
}

/** Per-episode queue states for transcript request tracking */
export type EpisodeQueueState = "queued" | "requesting" | "waiting" | "checking" | "done" | "failed" | "stopped";

export interface EpisodeStatusEvent {
  type: "episode:status";
  podcastId: string;
  guid: string;
  title: string;
  state: EpisodeQueueState;
  detail?: string;
}

// ---- Transcript request workflow ----

export interface RequestTranscriptsOptions {
  /** Max concurrent Podscribe request/reset API calls (default: 5) */
  concurrency?: number;
  /** Delay between starting consecutive requests in ms (default: 500) */
  requestStaggerMs?: number;
  /** Delay before first status check after triggering, in ms (default: 240000 = 4 min) */
  checkDelayMs?: number;
  /** Delay for retry checks when text not yet ready, in ms (default: 120000 = 2 min) */
  retryDelayMs?: number;
  /** Max check retries per episode before marking failed (default: 5) */
  maxCheckRetries?: number;
  /** Filter to specific podcast IDs */
  podcastIds?: string[];
  /** Max episodes to request (default: all) */
  maxRequests?: number;
  /** Retry mode: pick up episodes stuck in Requested/Processing/Running and check for transcripts */
  retry?: boolean;
  /** Log progress to console */
  verbose?: boolean;
  /** Progress callback for SSE */
  onProgress?: SyncProgressCallback;
}

export interface TimingStats {
  /** All individual durations in ms */
  durations: number[];
  minMs: number;
  maxMs: number;
  avgMs: number;
  medianMs: number;
}

export interface RequestTranscriptsResult {
  requested: number;
  downloaded: number;
  failed: number;
  stillProcessing: number;
  errors: string[];
  /** Per-episode timing stats (request-to-completion, only for downloaded + failed) */
  timings?: TimingStats;
}
