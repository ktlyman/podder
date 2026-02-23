/**
 * Transcript formatting utilities.
 *
 * Converts raw TranscriptWord arrays into human-readable formats
 * with speaker labels, timestamps, and paragraph structure.
 */

import type { TranscriptWord } from "../types/index.js";

/**
 * Format an array of TranscriptWord objects into speaker-segmented plain text.
 * Groups consecutive words by speaker and creates paragraph breaks on speaker changes.
 *
 * Example output:
 *   [Speaker 1]
 *   Hello and welcome to the show today we have a great guest.
 *
 *   [Speaker 2]
 *   Thanks for having me it's great to be here.
 */
export function formatTranscriptText(words: TranscriptWord[]): string {
  if (words.length === 0) return "";

  const paragraphs: string[] = [];
  let currentSpeaker = words[0].speaker;
  let currentWords: string[] = [];

  for (const w of words) {
    if (w.speaker !== currentSpeaker) {
      // Speaker changed — flush current paragraph
      paragraphs.push(`[Speaker ${currentSpeaker + 1}]\n${currentWords.join(" ")}`);
      currentSpeaker = w.speaker;
      currentWords = [];
    }
    currentWords.push(w.word);
  }

  // Flush last paragraph
  if (currentWords.length > 0) {
    paragraphs.push(`[Speaker ${currentSpeaker + 1}]\n${currentWords.join(" ")}`);
  }

  return paragraphs.join("\n\n");
}

/** Format seconds as MM:SS */
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format transcript as speaker blocks with time ranges.
 *
 * Example output:
 *   [Speaker 1] (0:00 - 1:23)
 *   Hello and welcome to the show today we have a great guest.
 *
 *   [Speaker 2] (1:24 - 2:45)
 *   Thanks for having me it's great to be here.
 */
export function formatSpeakerBlocks(words: TranscriptWord[]): string {
  if (words.length === 0) return "";

  const blocks: string[] = [];
  let currentSpeaker = words[0].speaker;
  let blockStart = words[0].startTime;
  let currentWords: string[] = [];

  for (const w of words) {
    if (w.speaker !== currentSpeaker) {
      const lastWord = words[words.indexOf(w) - 1];
      blocks.push(
        `[Speaker ${currentSpeaker + 1}] (${formatTime(blockStart)} - ${formatTime(lastWord.endTime)})\n${currentWords.join(" ")}`
      );
      currentSpeaker = w.speaker;
      blockStart = w.startTime;
      currentWords = [];
    }
    currentWords.push(w.word);
  }

  // Flush last block
  if (currentWords.length > 0) {
    const lastWord = words[words.length - 1];
    blocks.push(
      `[Speaker ${currentSpeaker + 1}] (${formatTime(blockStart)} - ${formatTime(lastWord.endTime)})\n${currentWords.join(" ")}`
    );
  }

  return blocks.join("\n\n");
}

/**
 * Format transcript with periodic timestamp markers inserted into the text flow.
 * Inserts [MM:SS] markers approximately every `intervalSeconds` seconds.
 *
 * Example output:
 *   [0:00] Hello and welcome to the show today we have a great guest
 *   [0:30] and I'm really excited to talk about this topic with you
 *   [1:00] so let's dive right in shall we
 */
export function formatWithTimestamps(words: TranscriptWord[], intervalSeconds = 30): string {
  if (words.length === 0) return "";

  const parts: string[] = [];
  let nextMarker = 0;

  for (const w of words) {
    if (w.startTime >= nextMarker) {
      if (parts.length > 0) parts.push("\n");
      parts.push(`[${formatTime(w.startTime)}] `);
      nextMarker = w.startTime + intervalSeconds;
    }
    parts.push(w.word + " ");
  }

  return parts.join("").trim();
}
