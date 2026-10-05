import type { Platform } from "@workspace/api-client-react";

/*
 * How long a post is, as each network counts it. Everywhere but X that is the number of characters. X counts a
 * "weighted" length (limit 280), following its published twitter-text v3 rules:
 *   - a link counts as 23, however long it really is (X replaces every link with a t.co address);
 *   - Latin, Cyrillic, Greek, Arabic, Hebrew, Indic and similar letters, digits and common punctuation count 1;
 *   - everything else (Chinese, Japanese, Korean...) counts 2, and an emoji counts 2 however many code points it has.
 *
 * Link detection is simpler than X's own: http(s) links, and bare domains ending in a well-known or two-letter
 * suffix. Where the two could differ, this counts a little more, never less, so a post accepted here fits on X.
 * This is a copy of the server code in api-server/src/lib/twitter-text.ts (keep the two in step); the server is
 * authoritative and counts again on save.
 */

export const TWITTER_CHAR_LIMIT = 280;
const LINK_LENGTH = 23;

// Code points X counts as 1 (twitter-text v3 "ranges"); all others count 2.
const SINGLE: Array<[number, number]> = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];

const GENERIC_SUFFIXES =
  "com|net|org|edu|gov|mil|int|info|biz|name|pro|app|dev|xyz|online|site|store|tech|blog|shop|club|top|live|news|media|cloud|design|agency|digital|studio|email|group|world|life|today|space|website|link|page|art|fun|icu|vip|work|one|plus|global|academy|solutions|services|company|network|systems|technology|software|marketing|social|photos|video|games|health|finance|money|travel|events|community|foundation|education|consulting|ventures|capital|partners|careers|jobs|mobi|asia|africa|london|nyc|berlin|tokyo";
const LINK = new RegExp(`https?://[^\\s]+|(?<![@\\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${GENERIC_SUFFIXES}|[a-z]{2})(?![a-z0-9-])(?:/[^\\s]*)?`, "gi");
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}>]+$/;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u; // U+20E3 closes a keycap such as 1️⃣

// Splits text into what a reader sees as one character, so an emoji built from several code points is one unit.
// Browsers from before 2024 may lack Intl.Segmenter; there each code point is taken on its own, which counts a
// joined emoji as more than X does, never less.
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const segmentsOf = (text: string): string[] => (segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text));

function weightOf(text: string): number {
  let total = 0;
  for (const segment of segmentsOf(text)) {
    if (EMOJI.test(segment)) { total += 2; continue; }
    for (const char of segment) {
      const code = char.codePointAt(0)!;
      total += SINGLE.some(([from, to]) => code >= from && code <= to) ? 1 : 2;
    }
  }
  return total;
}

/** The length X counts for this text. */
export function twitterLength(input: string): number {
  const text = input.normalize("NFC");
  let total = 0;
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    // Punctuation after a link belongs to the sentence, not the link.
    const link = match[0].replace(TRAILING_PUNCTUATION, "");
    if (link.length === 0) continue;
    total += weightOf(text.slice(last, match.index)) + LINK_LENGTH;
    last = match.index + link.length;
  }
  return total + weightOf(text.slice(last));
}

/** A post's length the way this network counts it. */
export function postLength(platform: Platform, text: string): number {
  return platform === "twitter" ? twitterLength(text) : text.length;
}
