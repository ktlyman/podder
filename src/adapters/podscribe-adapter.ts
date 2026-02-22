/**
 * Podscribe transcript adapter.
 *
 * Fetches transcripts from multiple Podscribe-family services:
 * 1. podscribe.app - Free community transcript archive
 * 2. RSS podcast:transcript tags - Standard RSS 2.0 transcript links
 * 3. podscribe.io - AI transcription service (if API key provided)
 *
 * Falls back through sources in order until a transcript is found.
 */

import type { Episode, PodcastConfig, TranscriptAdapter } from "../types/index.js";
import { fetchTranscriptFromUrl } from "./rss-parser.js";

/**
 * Attempt to find a transcript on podscribe.app by searching their site.
 * The site organizes transcripts by podcast name and episode title.
 */
async function fetchFromPodscribeApp(
  episode: Episode,
  podcast: PodcastConfig
): Promise<string | null> {
  if (podcast.podscribeUrl) {
    try {
      const response = await fetch(podcast.podscribeUrl, {
        headers: { "User-Agent": "PodscribeListener/1.0" },
      });
      if (response.ok) {
        const html = await response.text();
        return extractTranscriptFromHtml(html);
      }
    } catch {
      // Fall through
    }
  }

  // Try searching podscribe.app with the episode title
  const searchQuery = encodeURIComponent(`${podcast.name} ${episode.title}`);
  try {
    const searchUrl = `https://podscribe.app/feeds?q=${searchQuery}`;
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "PodscribeListener/1.0",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    if (!response.ok) return null;

    const html = await response.text();
    return extractTranscriptFromHtml(html);
  } catch {
    return null;
  }
}

/**
 * Attempt to fetch from podscribe.io using their public-facing pages.
 */
async function fetchFromPodscribeIo(
  episode: Episode,
  podcast: PodcastConfig
): Promise<string | null> {
  const searchQuery = encodeURIComponent(episode.title);
  try {
    const url = `https://podscribe.io/search?q=${searchQuery}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "PodscribeListener/1.0",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    if (!response.ok) return null;

    const html = await response.text();
    return extractTranscriptFromHtml(html);
  } catch {
    return null;
  }
}

/**
 * Extract transcript text from HTML response.
 * Looks for common patterns used by Podscribe services.
 */
function extractTranscriptFromHtml(html: string): string | null {
  // Look for transcript content in common container patterns
  const patterns = [
    // JSON-LD transcript
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    // Common transcript div patterns
    /class="transcript[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /class="episode-transcript[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /id="transcript"[^>]*>([\s\S]*?)<\/(?:div|section)>/gi,
    // Paragraph-based transcripts
    /class="transcript-segment[^"]*"[^>]*>([\s\S]*?)<\/(?:p|span|div)>/gi,
  ];

  for (const pattern of patterns) {
    const matches = [...html.matchAll(pattern)];
    if (matches.length > 0) {
      const text = matches
        .map((m) => m[1])
        .join(" ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 100) {
        return text;
      }
    }
  }

  // Try extracting from JSON-LD
  const jsonLdMatch = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
  );
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld.transcript) return ld.transcript;
      if (ld.text) return ld.text;
    } catch {
      // Not valid JSON-LD
    }
  }

  return null;
}

/**
 * RSS transcript tag adapter - fetch from podcast:transcript URLs discovered during feed parsing.
 */
export class RSSTranscriptAdapter implements TranscriptAdapter {
  name = "rss-tag";
  private transcriptUrls: Map<string, string>;

  constructor(transcriptUrls: Map<string, string>) {
    this.transcriptUrls = transcriptUrls;
  }

  async fetchTranscript(episode: Episode): Promise<string | null> {
    const url = this.transcriptUrls.get(episode.guid);
    if (!url) return null;
    return fetchTranscriptFromUrl(url);
  }
}

/**
 * Main Podscribe adapter that tries multiple Podscribe sources.
 */
export class PodscribeAdapter implements TranscriptAdapter {
  name = "podscribe";

  async fetchTranscript(
    episode: Episode,
    podcast: PodcastConfig
  ): Promise<string | null> {
    // Try podscribe.app first
    const appResult = await fetchFromPodscribeApp(episode, podcast);
    if (appResult) return appResult;

    // Try podscribe.io
    const ioResult = await fetchFromPodscribeIo(episode, podcast);
    if (ioResult) return ioResult;

    return null;
  }
}

/**
 * Composite adapter that chains multiple transcript sources.
 * Tries each adapter in order until one returns a result.
 */
export class CompositeTranscriptAdapter implements TranscriptAdapter {
  name = "composite";
  private adapters: TranscriptAdapter[];

  constructor(adapters: TranscriptAdapter[]) {
    this.adapters = adapters;
  }

  async fetchTranscript(
    episode: Episode,
    podcast: PodcastConfig
  ): Promise<string | null> {
    for (const adapter of this.adapters) {
      const result = await adapter.fetchTranscript(episode, podcast);
      if (result) {
        episode.transcriptSource = adapter.name;
        return result;
      }
    }
    return null;
  }
}
