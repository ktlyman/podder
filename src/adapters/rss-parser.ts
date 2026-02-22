import { XMLParser } from "fast-xml-parser";
import type { Episode, PodcastConfig } from "../types/index.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "podcast:transcript"].includes(name),
});

interface RSSItem {
  title?: string;
  description?: string;
  link?: string;
  guid?: string | { "#text": string };
  pubDate?: string;
  enclosure?: { "@_url"?: string; "@_type"?: string; "@_length"?: string };
  "itunes:duration"?: string | number;
  "podcast:transcript"?: Array<{
    "@_url"?: string;
    "@_type"?: string;
    "@_language"?: string;
  }>;
  "content:encoded"?: string;
}

export interface ParsedFeed {
  title: string;
  description: string;
  episodes: Episode[];
  transcriptUrls: Map<string, string>;
}

function parseDuration(dur: string | number | undefined): number | undefined {
  if (dur === undefined) return undefined;
  if (typeof dur === "number") return dur;

  // Format: HH:MM:SS or MM:SS or seconds
  const parts = dur.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  const secs = Number(dur);
  return Number.isNaN(secs) ? undefined : secs;
}

function extractGuid(item: RSSItem): string {
  if (!item.guid) return item.link ?? item.title ?? "";
  if (typeof item.guid === "string") return item.guid;
  return item.guid["#text"] ?? "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function parseFeed(
  podcast: PodcastConfig
): Promise<ParsedFeed> {
  const response = await fetch(podcast.feedUrl, {
    headers: {
      "User-Agent": "PodscribeListener/1.0 (podcast transcript collector)",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch RSS feed for ${podcast.name}: ${response.status} ${response.statusText}`
    );
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel;
  if (!channel) {
    throw new Error(`Invalid RSS feed for ${podcast.name}: no channel element`);
  }

  const items: RSSItem[] = channel.item ?? [];
  const transcriptUrls = new Map<string, string>();

  const episodes: Episode[] = items.map((item) => {
    const guid = extractGuid(item);
    const description = item["content:encoded"]
      ? stripHtml(item["content:encoded"])
      : item.description
        ? stripHtml(String(item.description))
        : "";

    // Check for podcast:transcript tag in RSS feed
    const transcripts = item["podcast:transcript"];
    if (transcripts) {
      for (const t of transcripts) {
        if (t["@_url"]) {
          const type = t["@_type"] ?? "";
          // Prefer plain text, then SRT, then VTT
          if (
            type.includes("plain") ||
            type.includes("srt") ||
            type.includes("vtt") ||
            !transcriptUrls.has(guid)
          ) {
            transcriptUrls.set(guid, t["@_url"]);
          }
        }
      }
    }

    return {
      podcastId: podcast.id,
      guid,
      title: String(item.title ?? "Untitled"),
      description,
      publishedAt: item.pubDate
        ? new Date(item.pubDate).toISOString()
        : new Date().toISOString(),
      durationSeconds: parseDuration(item["itunes:duration"]),
      audioUrl: item.enclosure?.["@_url"],
      episodeUrl: item.link ? String(item.link) : undefined,
    };
  });

  return {
    title: channel.title ?? podcast.name,
    description: channel.description ?? "",
    episodes,
    transcriptUrls,
  };
}

/**
 * Fetch a transcript from a direct URL (e.g. from RSS podcast:transcript tag)
 */
export async function fetchTranscriptFromUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "PodscribeListener/1.0",
        Accept: "text/plain, text/srt, text/vtt, */*",
      },
    });

    if (!response.ok) return null;

    const text = await response.text();

    // If it's SRT or VTT, strip timestamps and cues
    if (url.endsWith(".srt") || url.endsWith(".vtt") || text.includes("-->")) {
      return cleanSubtitleText(text);
    }

    return text.trim();
  } catch {
    return null;
  }
}

function cleanSubtitleText(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Skip empty lines, numeric cue IDs, timestamp lines, VTT header
      if (!trimmed) return false;
      if (/^\d+$/.test(trimmed)) return false;
      if (trimmed.includes("-->")) return false;
      if (trimmed.startsWith("WEBVTT")) return false;
      if (trimmed.startsWith("NOTE")) return false;
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
