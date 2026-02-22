import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PodcastConfig } from "./types/index.js";

const DEFAULT_CONFIG_PATH = "podcasts.json";

/**
 * Example starter config with popular podcasts that have good Podscribe coverage.
 * Users should create their own podcasts.json with feeds they care about.
 */
export const EXAMPLE_PODCASTS: PodcastConfig[] = [
  {
    id: "huberman-lab",
    name: "Huberman Lab",
    feedUrl: "https://feeds.megaphone.fm/hubermanlab",
    tags: ["science", "health", "neuroscience"],
  },
  {
    id: "lex-fridman",
    name: "Lex Fridman Podcast",
    feedUrl: "https://lexfridman.com/feed/podcast/",
    tags: ["technology", "science", "philosophy"],
  },
  {
    id: "all-in",
    name: "All-In Podcast",
    feedUrl: "https://feeds.megaphone.fm/all-in-with-chamath-jason-sacks-and-friedberg",
    tags: ["technology", "business", "politics"],
  },
  {
    id: "acquired",
    name: "Acquired",
    feedUrl: "https://feeds.acquired.fm/acquired",
    tags: ["business", "technology", "history"],
  },
  {
    id: "dwarkesh",
    name: "Dwarkesh Podcast",
    feedUrl: "https://feeds.megaphone.fm/dwarkeshpatel",
    tags: ["technology", "science", "interviews"],
  },
];

export function loadPodcastConfig(configPath?: string): PodcastConfig[] {
  const path = resolve(configPath ?? DEFAULT_CONFIG_PATH);

  if (!existsSync(path)) {
    console.warn(
      `Config file not found at ${path}, using example podcast list.\n` +
        `Create a podcasts.json file to customize. See podcasts.example.json for format.`
    );
    return EXAMPLE_PODCASTS;
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON array of podcast configs`);
  }

  for (const entry of parsed) {
    if (!entry.id || !entry.name || !entry.feedUrl) {
      throw new Error(
        `Each podcast config must have id, name, and feedUrl. Got: ${JSON.stringify(entry)}`
      );
    }
  }

  return parsed as PodcastConfig[];
}

export function getDataDir(): string {
  return resolve(process.env.PODSCRIBE_DATA_DIR ?? "./data");
}

export function getDbPath(): string {
  return resolve(getDataDir(), "podcasts.db");
}
