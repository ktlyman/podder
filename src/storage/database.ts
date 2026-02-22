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
} from "../types/index.js";

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
  last_synced_at: string | null;
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
  };
}

export class PodcastDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

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

    // Create FTS5 virtual table for full-text search across transcripts and metadata
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
  }

  /** Upsert a podcast configuration */
  upsertPodcast(config: PodcastConfig): void {
    this.db
      .prepare(
        `INSERT INTO podcasts (id, name, feed_url, podscribe_url, tags)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           feed_url = excluded.feed_url,
           podscribe_url = excluded.podscribe_url,
           tags = excluded.tags`
      )
      .run(
        config.id,
        config.name,
        config.feedUrl,
        config.podscribeUrl ?? null,
        JSON.stringify(config.tags ?? [])
      );
  }

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
           duration_seconds, audio_url, episode_url, transcript, transcript_source, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          new Date().toISOString()
        );
      return { isNew: true, updated: false };
    }

    // Update metadata and transcript if we have a new one
    const hasNewTranscript = episode.transcript && !existing.transcript;
    this.db
      .prepare(
        `UPDATE episodes SET
          title = ?, description = ?, published_at = ?,
          duration_seconds = ?, audio_url = ?, episode_url = ?,
          transcript = COALESCE(?, transcript),
          transcript_source = COALESCE(?, transcript_source),
          last_synced_at = ?
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

  /** Get episodes missing transcripts for a podcast */
  getEpisodesMissingTranscripts(podcastId: string, limit = 50): Episode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes
         WHERE podcast_id = ? AND transcript IS NULL
         ORDER BY published_at DESC
         LIMIT ?`
      )
      .all(podcastId, limit) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /** Update just the transcript for an episode */
  setTranscript(
    podcastId: string,
    guid: string,
    transcript: string,
    source: string
  ): void {
    this.db
      .prepare(
        `UPDATE episodes SET transcript = ?, transcript_source = ?, last_synced_at = ?
         WHERE podcast_id = ? AND guid = ?`
      )
      .run(transcript, source, new Date().toISOString(), podcastId, guid);
  }

  /**
   * Full-text search across all episodes using FTS5 BM25 ranking.
   * Supports query syntax: AND, OR, NOT, "exact phrase", prefix*
   */
  search(options: SearchOptions): SearchResult[] {
    const { query, podcastIds, tags, after, before, limit = 20, offset = 0 } = options;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Build WHERE conditions for filtering
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

    // Use FTS5 MATCH with BM25 ranking
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

  /** Get a specific episode by podcast ID and GUID */
  getEpisode(podcastId: string, guid: string): Episode | null {
    const row = this.db
      .prepare("SELECT * FROM episodes WHERE podcast_id = ? AND guid = ?")
      .get(podcastId, guid) as EpisodeRow | undefined;
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

    return {
      totalPodcasts: podcasts.length,
      totalEpisodes: podcasts.reduce((s, p) => s + p.totalEpisodes, 0),
      totalTranscripts: podcasts.reduce(
        (s, p) => s + p.episodesWithTranscripts,
        0
      ),
      podcasts,
    };
  }

  /** Get all podcast configs from DB */
  listPodcasts(): PodcastConfig[] {
    const rows = this.db.prepare("SELECT * FROM podcasts").all() as Array<{
      id: string;
      name: string;
      feed_url: string;
      podscribe_url: string | null;
      tags: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      feedUrl: r.feed_url,
      podscribeUrl: r.podscribe_url ?? undefined,
      tags: JSON.parse(r.tags),
    }));
  }

  /** Mark a podcast as synced */
  markSynced(podcastId: string): void {
    this.db
      .prepare("UPDATE podcasts SET last_synced_at = ? WHERE id = ?")
      .run(new Date().toISOString(), podcastId);
  }

  /** Get the full transcript for an episode */
  getTranscript(episodeId: number): string | null {
    const row = this.db
      .prepare("SELECT transcript FROM episodes WHERE id = ?")
      .get(episodeId) as { transcript: string | null } | undefined;
    return row?.transcript ?? null;
  }

  close(): void {
    this.db.close();
  }
}
