import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Episode,
  PodcastConfig,
  PodcastStats,
  SearchOptions,
  SearchResult,
  SystemStats,
  TranscriptWord,
} from "../types/index.js";

// ---- Row types ----

/** Row shape returned by SQLite for the episodes table (snake_case columns) */
interface EpisodeRow {
  id: number;
  podcast_id: string;
  guid: string;
  title: string;
  description: string;
  published_at: string;
  duration_seconds: number | null;
  audio_url: string | null;
  episode_url: string | null;
  transcript: string | null;
  transcript_source: string | null;
  transcript_data: string | null;
  last_synced_at: string | null;
  podscribe_episode_id: number | null;
  podscribe_url: string | null;
  podscribe_transcript_status: string | null;
  podscribe_status_checked_at: string | null;
  episode_tag: string | null;
}

interface SearchRow extends EpisodeRow {
  podcast_name: string;
  snippet: string;
  rank: number;
}

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    podcastId: row.podcast_id,
    guid: row.guid,
    title: row.title,
    description: row.description,
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds ?? undefined,
    audioUrl: row.audio_url ?? undefined,
    episodeUrl: row.episode_url ?? undefined,
    transcript: row.transcript ?? undefined,
    transcriptSource: row.transcript_source ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    podscribeEpisodeId: row.podscribe_episode_id ?? undefined,
    podscribeUrl: row.podscribe_url ?? undefined,
    podscribeTranscriptStatus: row.podscribe_transcript_status ?? undefined,
    podscribeStatusCheckedAt: row.podscribe_status_checked_at ?? undefined,
    episodeTag: row.episode_tag ?? undefined,
  };
}

// ---- Database class ----

export class PodcastDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  // ================================================================
  // Schema & initialization
  // ================================================================

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS podcasts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        podscribe_url TEXT,
        tags TEXT DEFAULT '[]',
        last_synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        podcast_id TEXT NOT NULL REFERENCES podcasts(id),
        guid TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        published_at TEXT NOT NULL,
        duration_seconds INTEGER,
        audio_url TEXT,
        episode_url TEXT,
        transcript TEXT,
        transcript_source TEXT,
        last_synced_at TEXT,
        UNIQUE(podcast_id, guid)
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_podcast_id ON episodes(podcast_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_published_at ON episodes(published_at);
    `);

    // FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        title,
        description,
        transcript,
        content=episodes,
        content_rowid=id,
        tokenize='porter unicode61'
      );
    `);

    // Triggers to keep FTS index in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, title, description, transcript)
        VALUES (new.id, new.title, new.description, COALESCE(new.transcript, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, title, description, transcript)
        VALUES ('delete', old.id, old.title, old.description, COALESCE(old.transcript, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, title, description, transcript)
        VALUES ('delete', old.id, old.title, old.description, COALESCE(old.transcript, ''));
        INSERT INTO episodes_fts(rowid, title, description, transcript)
        VALUES (new.id, new.title, new.description, COALESCE(new.transcript, ''));
      END;
    `);

    // Migrations: add columns introduced after initial schema
    this.addColumnIfMissing("podcasts", "podscribe_series_id", "TEXT");
    this.addColumnIfMissing("episodes", "podscribe_episode_id", "INTEGER");
    this.addColumnIfMissing("episodes", "podscribe_url", "TEXT");
    this.addColumnIfMissing("episodes", "podscribe_transcript_status", "TEXT");
    this.addColumnIfMissing("episodes", "podscribe_status_checked_at", "TEXT");
    this.addColumnIfMissing("episodes", "transcript_data", "TEXT");
    this.addColumnIfMissing("episodes", "episode_tag", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // ================================================================
  // Podcast CRUD
  // ================================================================

  /** Upsert a podcast configuration */
  upsertPodcast(config: PodcastConfig): void {
    this.db
      .prepare(
        `INSERT INTO podcasts (id, name, feed_url, podscribe_url, podscribe_series_id, tags)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           feed_url = excluded.feed_url,
           podscribe_url = excluded.podscribe_url,
           podscribe_series_id = excluded.podscribe_series_id,
           tags = excluded.tags`
      )
      .run(
        config.id,
        config.name,
        config.feedUrl,
        config.podscribeUrl ?? null,
        config.podscribeSeriesId ?? null,
        JSON.stringify(config.tags ?? [])
      );
  }

  /** Get all podcast configs from DB */
  listPodcasts(): PodcastConfig[] {
    const rows = this.db.prepare("SELECT * FROM podcasts").all() as Array<{
      id: string;
      name: string;
      feed_url: string;
      podscribe_url: string | null;
      podscribe_series_id: string | null;
      tags: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      feedUrl: r.feed_url,
      podscribeUrl: r.podscribe_url ?? undefined,
      podscribeSeriesId: r.podscribe_series_id ?? undefined,
      tags: JSON.parse(r.tags),
    }));
  }

  /** Delete a podcast and all its episodes from the DB */
  deletePodcast(podcastId: string): void {
    this.db.prepare("DELETE FROM episodes WHERE podcast_id = ?").run(podcastId);
    this.db.prepare("DELETE FROM podcasts WHERE id = ?").run(podcastId);
  }

  /** Mark a podcast as synced */
  markSynced(podcastId: string): void {
    this.db
      .prepare("UPDATE podcasts SET last_synced_at = ? WHERE id = ?")
      .run(new Date().toISOString(), podcastId);
  }

  // ================================================================
  // Episode CRUD
  // ================================================================

  /** Upsert an episode, returning whether it was new or updated */
  upsertEpisode(episode: Episode): { isNew: boolean; updated: boolean } {
    const existing = this.db
      .prepare("SELECT id, transcript FROM episodes WHERE podcast_id = ? AND guid = ?")
      .get(episode.podcastId, episode.guid) as
      | { id: number; transcript: string | null }
      | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO episodes (podcast_id, guid, title, description, published_at,
           duration_seconds, audio_url, episode_url, transcript, transcript_source, last_synced_at,
           podscribe_episode_id, podscribe_url,
           podscribe_transcript_status, podscribe_status_checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          episode.podcastId,
          episode.guid,
          episode.title,
          episode.description,
          episode.publishedAt,
          episode.durationSeconds ?? null,
          episode.audioUrl ?? null,
          episode.episodeUrl ?? null,
          episode.transcript ?? null,
          episode.transcriptSource ?? null,
          new Date().toISOString(),
          episode.podscribeEpisodeId ?? null,
          episode.podscribeUrl ?? null,
          episode.podscribeTranscriptStatus ?? null,
          episode.podscribeStatusCheckedAt ?? null
        );
      return { isNew: true, updated: false };
    }

    const hasNewTranscript = episode.transcript && !existing.transcript;
    this.db
      .prepare(
        `UPDATE episodes SET
          title = ?, description = ?, published_at = ?,
          duration_seconds = ?, audio_url = ?, episode_url = ?,
          transcript = COALESCE(?, transcript),
          transcript_source = COALESCE(?, transcript_source),
          last_synced_at = ?,
          podscribe_episode_id = COALESCE(?, podscribe_episode_id),
          podscribe_url = COALESCE(?, podscribe_url),
          podscribe_transcript_status = COALESCE(?, podscribe_transcript_status),
          podscribe_status_checked_at = COALESCE(?, podscribe_status_checked_at)
         WHERE id = ?`
      )
      .run(
        episode.title,
        episode.description,
        episode.publishedAt,
        episode.durationSeconds ?? null,
        episode.audioUrl ?? null,
        episode.episodeUrl ?? null,
        episode.transcript ?? null,
        episode.transcriptSource ?? null,
        new Date().toISOString(),
        episode.podscribeEpisodeId ?? null,
        episode.podscribeUrl ?? null,
        episode.podscribeTranscriptStatus ?? null,
        episode.podscribeStatusCheckedAt ?? null,
        existing.id
      );

    return { isNew: false, updated: !!hasNewTranscript };
  }

  /** Bulk upsert episodes within a transaction */
  upsertEpisodes(episodes: Episode[]): { newCount: number; updatedCount: number } {
    let newCount = 0;
    let updatedCount = 0;

    const transaction = this.db.transaction((eps: Episode[]) => {
      for (const ep of eps) {
        const { isNew, updated } = this.upsertEpisode(ep);
        if (isNew) newCount++;
        if (updated) updatedCount++;
      }
    });

    transaction(episodes);
    return { newCount, updatedCount };
  }

  /** Get a specific episode by podcast ID and GUID */
  getEpisode(podcastId: string, guid: string): Episode | null {
    const row = this.db
      .prepare("SELECT * FROM episodes WHERE podcast_id = ? AND guid = ?")
      .get(podcastId, guid) as EpisodeRow | undefined;
    return row ? rowToEpisode(row) : null;
  }

  /** Get a single episode by its database ID */
  getEpisodeById(episodeId: number): Episode | null {
    const row = this.db
      .prepare("SELECT * FROM episodes WHERE id = ?")
      .get(episodeId) as EpisodeRow | undefined;
    return row ? rowToEpisode(row) : null;
  }

  /** List all episodes for a podcast, sorted by date */
  listEpisodes(
    podcastId: string,
    options: { limit?: number; offset?: number; hasTranscript?: boolean } = {}
  ): Episode[] {
    const { limit = 50, offset = 0, hasTranscript } = options;
    let sql = "SELECT * FROM episodes WHERE podcast_id = ?";
    const params: (string | number)[] = [podcastId];

    if (hasTranscript === true) {
      sql += " AND transcript IS NOT NULL";
    } else if (hasTranscript === false) {
      sql += " AND transcript IS NULL";
    }

    sql += " ORDER BY published_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /** Search episodes by title substring (case-insensitive LIKE) */
  findEpisodesByTitle(
    titleQuery: string,
    podcastId?: string,
    limit = 20
  ): Array<{ episode: Episode; podcastName: string }> {
    let sql = `SELECT e.*, p.name as podcast_name
       FROM episodes e
       JOIN podcasts p ON p.id = e.podcast_id
       WHERE e.title LIKE ?`;
    const params: (string | number)[] = [`%${titleQuery}%`];

    if (podcastId) {
      sql += ` AND e.podcast_id = ?`;
      params.push(podcastId);
    }

    sql += ` ORDER BY e.published_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<EpisodeRow & { podcast_name: string }>;
    return rows.map((row) => ({
      episode: rowToEpisode(row),
      podcastName: row.podcast_name,
    }));
  }

  // ================================================================
  // Transcript operations
  // ================================================================

  /** Get the full transcript for an episode */
  getTranscript(episodeId: number): string | null {
    const row = this.db
      .prepare("SELECT transcript FROM episodes WHERE id = ?")
      .get(episodeId) as { transcript: string | null } | undefined;
    return row?.transcript ?? null;
  }

  /** Update the transcript for an episode, with optional structured word-level data */
  setTranscript(
    podcastId: string,
    guid: string,
    transcript: string,
    source: string,
    transcriptData?: TranscriptWord[]
  ): void {
    this.db
      .prepare(
        `UPDATE episodes SET transcript = ?, transcript_source = ?, transcript_data = ?, last_synced_at = ?
         WHERE podcast_id = ? AND guid = ?`
      )
      .run(
        transcript,
        source,
        transcriptData ? JSON.stringify(transcriptData) : null,
        new Date().toISOString(),
        podcastId,
        guid
      );
  }

  /** Get the structured word-level transcript data for an episode */
  getStructuredTranscript(episodeId: number): TranscriptWord[] | null {
    const row = this.db
      .prepare("SELECT transcript_data FROM episodes WHERE id = ?")
      .get(episodeId) as { transcript_data: string | null } | undefined;
    if (!row?.transcript_data) return null;
    return JSON.parse(row.transcript_data) as TranscriptWord[];
  }

  /** Check if an episode has structured transcript data */
  hasStructuredTranscript(episodeId: number): boolean {
    const row = this.db
      .prepare("SELECT transcript_data IS NOT NULL AS has_data FROM episodes WHERE id = ?")
      .get(episodeId) as { has_data: number } | undefined;
    return row?.has_data === 1;
  }

  /** Update only the structured transcript data for an episode (does not overwrite plain text) */
  setTranscriptData(episodeId: number, words: TranscriptWord[]): void {
    this.db
      .prepare("UPDATE episodes SET transcript_data = ? WHERE id = ?")
      .run(JSON.stringify(words), episodeId);
  }

  // ================================================================
  // Podscribe pipeline
  // ================================================================

  /** Store Podscribe metadata for an episode matched by podcast ID and GUID */
  setPodscribeInfo(
    podcastId: string,
    guid: string,
    podscribeEpisodeId: number,
    podscribeUrl: string
  ): void {
    this.db
      .prepare(
        `UPDATE episodes SET podscribe_episode_id = ?, podscribe_url = ?
         WHERE podcast_id = ? AND guid = ?`
      )
      .run(podscribeEpisodeId, podscribeUrl, podcastId, guid);
  }

  /** Bulk update Podscribe transcript statuses within a transaction */
  setPodscribeTranscriptStatuses(
    updates: Array<{ podcastId: string; guid: string; status: string; transcriptionId?: string | null }>
  ): void {
    const stmt = this.db.prepare(
      `UPDATE episodes
       SET podscribe_transcript_status = ?, podscribe_status_checked_at = ?
       WHERE podcast_id = ? AND guid = ?`
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction(
      (items: typeof updates) => {
        for (const u of items) {
          stmt.run(u.status, now, u.podcastId, u.guid);
        }
      }
    );
    tx(updates);
  }

  /** Get episodes missing transcripts for a podcast */
  getEpisodesMissingTranscripts(
    podcastId: string,
    limit?: number,
    options?: { cooldownMs?: number }
  ): Episode[] {
    const sqlLimit = (limit === undefined || !Number.isFinite(limit)) ? -1 : limit;
    const cooldownMs = options?.cooldownMs;

    let sql = `SELECT * FROM episodes WHERE podcast_id = ? AND transcript IS NULL AND episode_tag IS NULL`;
    const params: (string | number)[] = [podcastId];

    if (cooldownMs !== undefined && cooldownMs > 0) {
      const cutoff = new Date(Date.now() - cooldownMs).toISOString();
      sql += ` AND (podscribe_status_checked_at IS NULL OR podscribe_status_checked_at < ?)`;
      params.push(cutoff);
    }

    sql += ` ORDER BY published_at DESC LIMIT ?`;
    params.push(sqlLimit);

    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /** Get episodes that have Podscribe status "Done" but no transcript yet */
  getEpisodesReadyForTranscriptDownload(podcastId: string, limit?: number): Episode[] {
    const sqlLimit = (limit === undefined || !Number.isFinite(limit)) ? -1 : limit;
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes
         WHERE podcast_id = ? AND transcript IS NULL
           AND podscribe_episode_id IS NOT NULL
           AND episode_tag IS NULL
           AND podscribe_transcript_status = 'Done'
         ORDER BY published_at DESC
         LIMIT ?`
      )
      .all(podcastId, sqlLimit) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /** Get episodes that need a transcript request (NotStarted or NULL status, have Podscribe ID) */
  getEpisodesNeedingTranscriptRequest(
    podcastIds?: string[],
    limit?: number
  ): Episode[] {
    let sql = `SELECT * FROM episodes
       WHERE transcript IS NULL
         AND podscribe_episode_id IS NOT NULL
         AND episode_tag IS NULL
         AND (podscribe_transcript_status IS NULL OR podscribe_transcript_status = 'NotStarted')`;

    const params: (string | number)[] = [];

    if (podcastIds && podcastIds.length > 0) {
      sql += ` AND podcast_id IN (${podcastIds.map(() => "?").join(",")})`;
      params.push(...podcastIds);
    }

    sql += ` ORDER BY published_at DESC`;

    if (limit !== undefined && Number.isFinite(limit)) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /**
   * Get ALL episodes that have a Podscribe ID but no local transcript.
   * Used by the download-only mode to find transcripts that may already
   * be available on Podscribe, regardless of what status we have locally.
   */
  getEpisodesAwaitingDownload(podcastIds?: string[], limit?: number): Episode[] {
    let sql = `SELECT * FROM episodes
       WHERE transcript IS NULL
         AND podscribe_episode_id IS NOT NULL
         AND episode_tag IS NULL`;

    const params: (string | number)[] = [];
    if (podcastIds && podcastIds.length > 0) {
      sql += ` AND podcast_id IN (${podcastIds.map(() => "?").join(",")})`;
      params.push(...podcastIds);
    }

    sql += ` ORDER BY published_at DESC`;

    if (limit !== undefined && Number.isFinite(limit)) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /** Get episodes awaiting transcript download (Requested, Processing, Running, or bogus Done with no transcript) */
  getEpisodesInProcessing(podcastIds?: string[]): Episode[] {
    let sql = `SELECT * FROM episodes
       WHERE transcript IS NULL
         AND podscribe_episode_id IS NOT NULL
         AND episode_tag IS NULL
         AND podscribe_transcript_status IN ('Processing', 'Requested', 'Running', 'Done')`;

    const params: string[] = [];
    if (podcastIds && podcastIds.length > 0) {
      sql += ` AND podcast_id IN (${podcastIds.map(() => "?").join(",")})`;
      params.push(...podcastIds);
    }

    sql += ` ORDER BY published_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /** Get episodes that have transcripts but no enriched (word-level) data */
  getEpisodesNeedingEnrichment(podcastIds?: string[], limit?: number): Episode[] {
    let sql = `SELECT * FROM episodes
       WHERE transcript IS NOT NULL
         AND transcript_data IS NULL
         AND podscribe_episode_id IS NOT NULL`;

    const params: (string | number)[] = [];

    if (podcastIds && podcastIds.length > 0) {
      sql += ` AND podcast_id IN (${podcastIds.map(() => "?").join(",")})`;
      params.push(...podcastIds);
    }

    sql += ` ORDER BY published_at DESC`;

    if (limit !== undefined && Number.isFinite(limit)) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  // ================================================================
  // Tags & stats
  // ================================================================

  /** Set or clear the episode tag for a specific episode */
  setEpisodeTag(podcastId: string, guid: string, tag: string | null): void {
    this.db
      .prepare("UPDATE episodes SET episode_tag = ? WHERE podcast_id = ? AND guid = ?")
      .run(tag, podcastId, guid);
  }

  /** Get counts of episodes grouped by episode_tag */
  getTagCounts(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT episode_tag, COUNT(*) as count
         FROM episodes
         WHERE episode_tag IS NOT NULL
         GROUP BY episode_tag`
      )
      .all() as Array<{ episode_tag: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.episode_tag] = row.count;
    }
    return result;
  }

  /** Get system-wide statistics */
  getStats(): SystemStats {
    const podcastRows = this.db
      .prepare(
        `SELECT
           p.id as podcast_id,
           p.name as podcast_name,
           COUNT(e.id) as total_episodes,
           SUM(CASE WHEN e.transcript IS NOT NULL THEN 1 ELSE 0 END) as episodes_with_transcripts,
           MIN(e.published_at) as oldest_episode,
           MAX(e.published_at) as newest_episode
         FROM podcasts p
         LEFT JOIN episodes e ON e.podcast_id = p.id
         GROUP BY p.id, p.name`
      )
      .all() as Array<{
      podcast_id: string;
      podcast_name: string;
      total_episodes: number;
      episodes_with_transcripts: number;
      oldest_episode: string | null;
      newest_episode: string | null;
    }>;

    const podcasts: PodcastStats[] = podcastRows.map((row) => ({
      podcastId: row.podcast_id,
      podcastName: row.podcast_name,
      totalEpisodes: row.total_episodes,
      episodesWithTranscripts: row.episodes_with_transcripts,
      oldestEpisode: row.oldest_episode ?? undefined,
      newestEpisode: row.newest_episode ?? undefined,
    }));

    const tagCounts = this.getTagCounts();

    const enrichedRow = this.db
      .prepare("SELECT COUNT(*) as count FROM episodes WHERE transcript_data IS NOT NULL")
      .get() as { count: number };
    const enrichedTranscripts = enrichedRow.count;

    return {
      totalPodcasts: podcasts.length,
      totalEpisodes: podcasts.reduce((s, p) => s + p.totalEpisodes, 0),
      totalTranscripts: podcasts.reduce(
        (s, p) => s + p.episodesWithTranscripts,
        0
      ),
      podcasts,
      tagCounts: Object.keys(tagCounts).length > 0 ? tagCounts : undefined,
      enrichedTranscripts: enrichedTranscripts > 0 ? enrichedTranscripts : undefined,
    };
  }

  // ================================================================
  // Search
  // ================================================================

  /**
   * Full-text search across all episodes using FTS5 BM25 ranking.
   * Supports query syntax: AND, OR, NOT, "exact phrase", prefix*
   */
  search(options: SearchOptions): SearchResult[] {
    const { query, podcastIds, tags, after, before, limit = 20, offset = 0 } = options;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (podcastIds && podcastIds.length > 0) {
      conditions.push(
        `e.podcast_id IN (${podcastIds.map(() => "?").join(",")})`
      );
      params.push(...podcastIds);
    }

    if (tags && tags.length > 0) {
      const tagConditions = tags.map(() => "p.tags LIKE ?");
      conditions.push(`(${tagConditions.join(" OR ")})`);
      params.push(...tags.map((t) => `%"${t}"%`));
    }

    if (after) {
      conditions.push("e.published_at >= ?");
      params.push(after);
    }

    if (before) {
      conditions.push("e.published_at <= ?");
      params.push(before);
    }

    const whereClause =
      conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT
        e.*,
        p.name as podcast_name,
        snippet(episodes_fts, 2, '>>>>', '<<<<', '...', 64) as snippet,
        rank
      FROM episodes_fts fts
      JOIN episodes e ON e.id = fts.rowid
      JOIN podcasts p ON p.id = e.podcast_id
      WHERE episodes_fts MATCH ?
      ${whereClause}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;

    params.unshift(query);
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as SearchRow[];

    return rows.map((row) => ({
      episode: rowToEpisode(row),
      podcastName: row.podcast_name,
      snippet: row.snippet,
      rank: row.rank,
    }));
  }

  // ================================================================
  // Lifecycle
  // ================================================================

  close(): void {
    this.db.close();
  }
}
