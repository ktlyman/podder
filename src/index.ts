/**
 * Main entry point for programmatic usage.
 * Re-exports all public APIs for use as a library.
 */

export { PodcastDatabase } from "./storage/database.js";
export { QueryEngine } from "./agent/query-engine.js";
export { syncAll, syncPodcast } from "./sync.js";
export { loadPodcastConfig, getDbPath, getDataDir } from "./config.js";
export { parseFeed, fetchTranscriptFromUrl } from "./adapters/rss-parser.js";
export {
  PodscribeAdapter,
  RSSTranscriptAdapter,
  CompositeTranscriptAdapter,
} from "./adapters/podscribe-adapter.js";
export type {
  PodcastConfig,
  Episode,
  SearchResult,
  SearchOptions,
  SyncResult,
  TranscriptAdapter,
  AgentQueryResult,
  PodcastStats,
  SystemStats,
} from "./types/index.js";
