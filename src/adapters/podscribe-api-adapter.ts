/**
 * Podscribe Backend API adapter.
 *
 * Fetches transcripts from backend.podscribe.ai — a public JSON API that
 * requires no authentication. Uses compress-json for decoding responses.
 *
 * Flow:
 * 1. Prefetch: GET /api/series/{seriesId}/episodes → list all episodes (standard JSON)
 * 2. Per-episode: GET /api/episode?id={id}&includeAds=false&includeOriginal=false
 *    → decompress → check transcription.status ("Done" = available)
 * 3. If Done: GET /api/episode/{id}/transcription?transcriptVersionReqId={uuid}
 *    → decompress → extract words array → join into plain text
 */

import { decompress } from "compress-json";
import type { Episode, PodcastConfig, TranscriptAdapter, TranscriptResult, TranscriptWord } from "../types/index.js";
import { formatTranscriptText } from "../utils/format-transcript.js";

const PODSCRIBE_API = "https://backend.podscribe.ai/api";
const USER_AGENT = "PodscribeListener/1.0 (podcast transcript collector)";

/** Episode info returned by the series episodes endpoint (standard JSON) */
export interface PodscribeSeriesEpisode {
  id: number;
  title: string;
  guid: string;
  description?: string;
  uploadedAt: string;
  duration: number;
  url: string;
  seriesId: number;
}

/** Transcription status from episode detail endpoint */
interface PodscribeTranscription {
  id: string | null;
  status: string;
  createdAt: string | null;
  url: string | null;
  diarization: unknown;
}

/**
 * Fetch the full list of episodes for a Podscribe series.
 * Returns standard JSON (not compress-json).
 */
export async function fetchPodscribeSeriesEpisodes(
  seriesId: string
): Promise<PodscribeSeriesEpisode[]> {
  const url = `${PODSCRIBE_API}/series/${seriesId}/episodes`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Podscribe series API error: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as PodscribeSeriesEpisode[];
}

/** Result of checking a single episode's transcript status */
export interface PodscribeStatusResult {
  podscribeId: number;
  guid: string;
  status: string;
  transcriptionId: string | null;
}

/**
 * Fetch episode detail to check transcript status and get version UUID.
 * Response is compress-json encoded.
 */
export async function fetchEpisodeDetail(
  episodeId: number
): Promise<{ transcription: PodscribeTranscription }> {
  const url = `${PODSCRIBE_API}/episode?id=${episodeId}&includeAds=false&includeOriginal=false`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Podscribe episode API error: ${response.status} ${response.statusText}`
    );
  }

  const raw = await response.json();
  return decompress(raw) as { transcription: PodscribeTranscription };
}

/**
 * Fetch the full transcript for an episode with a completed transcription.
 * Returns both speaker-formatted plain text and the raw word-level data
 * (timestamps, speaker IDs, confidence scores).
 * Response is compress-json encoded.
 */
export async function fetchTranscriptText(
  episodeId: number,
  transcriptVersionReqId: string
): Promise<TranscriptResult | null> {
  const url =
    `${PODSCRIBE_API}/episode/${episodeId}/transcription` +
    `?transcriptVersionReqId=${transcriptVersionReqId}`;

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) return null;

  const raw = await response.json();
  const data = decompress(raw) as { text: TranscriptWord[]; status: string };

  if (!Array.isArray(data.text) || data.text.length === 0) return null;

  return {
    text: formatTranscriptText(data.text),
    words: data.text,
  };
}

/**
 * Request Podscribe to start transcribing an episode.
 *
 * Uses the self-hosting-request endpoint which is what the Podscribe
 * frontend calls when a user clicks "Request Transcript". This endpoint
 * requires a valid Cognito JWT access token.
 *
 * Endpoint: POST /api/episode/{episodeId}/self-hosting-request
 *
 * Flow after request:
 *   NotStarted → (30-60s) → Running → (2-5 min) → Done (with text)
 */
export async function requestTranscription(
  episodeId: number,
  authToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${PODSCRIBE_API}/episode/${episodeId}/self-hosting-request`,
      {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401) {
        return {
          success: false,
          error: `Auth expired (401): token rejected by Podscribe. Re-login to Podscribe in Chrome and retry.`,
        };
      }
      if (response.status === 403) {
        return {
          success: false,
          error: `Forbidden (403): not permitted to request this episode. ${text.slice(0, 100)}`,
        };
      }
      return {
        success: false,
        error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Validate an auth token by making a lightweight authenticated request.
 * Returns true if the token is accepted, false if rejected (401).
 */
export async function validateAuthToken(
  authToken: string,
  testEpisodeId: number
): Promise<{ valid: boolean; status?: number; error?: string }> {
  try {
    // Use a HEAD-like approach: POST to self-hosting-request for a known episode.
    // If the episode already has a transcript, Podscribe returns 200 (no-op).
    // A 401 means the token is definitely bad.
    const response = await fetch(
      `${PODSCRIBE_API}/episode/${testEpisodeId}/self-hosting-request`,
      {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
      }
    );

    if (response.status === 401) {
      return { valid: false, status: 401, error: "Token rejected by Podscribe (401)" };
    }

    // 200, 403, or other status means the token itself is accepted
    // (403 = permissions issue, not auth issue)
    return { valid: true, status: response.status };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reset a Podscribe transcription to re-trigger processing.
 *
 * Uses the reset endpoint which the Podscribe frontend calls to re-process
 * an episode that already has a transcription record (e.g. a bogus "Done"
 * record with no actual text). Requires a valid Cognito JWT access token
 * and the user's Cognito sub (userId).
 *
 * Endpoint: POST /api/episode/reset
 * Body: { episodeId, userId }
 *
 * Flow after reset:
 *   Done (no text) → Running → (3-5 min) → Done (with text)
 */
export async function resetTranscription(
  episodeId: number,
  authToken: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${PODSCRIBE_API}/episode/reset`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ episodeId, userId }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401) {
        return {
          success: false,
          error: `Auth expired (401): token rejected by Podscribe. Re-login to Podscribe in Chrome and retry.`,
        };
      }
      if (response.status === 403) {
        return {
          success: false,
          error: `Forbidden (403): not permitted to reset this episode. ${text.slice(0, 100)}`,
        };
      }
      return {
        success: false,
        error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Pre-fetched info about a Podscribe episode for adapter use */
export interface PodscribeEpisodeInfo {
  podscribeId: number;
  podscribeUrl: string;
}

/**
 * Build the Podscribe app URL for an episode.
 */
function buildPodscribeUrl(episodeId: number): string {
  return `https://app.podscribe.com/episode/${episodeId}`;
}

/**
 * Transcript adapter that fetches from the Podscribe backend API.
 *
 * Requires a pre-fetched map of GUID → Podscribe episode info (built during
 * the prefetch phase in the sync engine). For each episode:
 * 1. Look up by GUID in the pre-fetched map
 * 2. Fetch episode detail to check transcript status
 * 3. If status is "Done", fetch and return the transcript text
 */
export class PodscribeApiAdapter implements TranscriptAdapter {
  name = "podscribe-api";
  private episodeMap: Map<string, PodscribeEpisodeInfo>;

  constructor(episodeMap: Map<string, PodscribeEpisodeInfo>) {
    this.episodeMap = episodeMap;
  }

  async fetchTranscript(
    episode: Episode,
    _podcast: PodcastConfig
  ): Promise<string | null> {
    const info = this.episodeMap.get(episode.guid);
    if (!info) return null;

    // Fetch episode detail to check transcript status
    const detail = await fetchEpisodeDetail(info.podscribeId);
    const transcription = detail.transcription;

    if (!transcription || transcription.status !== "Done" || !transcription.id) {
      return null;
    }

    // Fetch the full transcript (extract plain text for adapter interface)
    const result = await fetchTranscriptText(info.podscribeId, transcription.id);
    return result?.text ?? null;
  }
}
