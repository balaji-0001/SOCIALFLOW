import { addDays, addHours, setHours, setMilliseconds, setMinutes, setSeconds, startOfDay } from 'date-fns';

/* Pure helpers for the post composer. Everything here operates on the text the user typed. */

const TRAILING_PUNCTUATION = /[.,;:!?)\]}"'”’]+$/;
// RFC 3986 URL characters only, so an emoji or other symbol typed right after a link ends the link
// instead of becoming part of it (and later being percent-encoded when tracking is added).
const URL_SOURCE = "https?:\\/\\/[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]+";
const URL_PATTERN = new RegExp(URL_SOURCE, 'gi');

/** A `{start,end,value}` for every http(s) link in the text, in order. */
export function findUrls(text: string): Array<{ start: number; end: number; value: string }> {
  const found: Array<{ start: number; end: number; value: string }> = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const value = raw.replace(TRAILING_PUNCTUATION, '');
    if (value.length > 'https://'.length) found.push({ start: match.index!, end: match.index! + value.length, value });
  }
  return found;
}

export function extractUrls(text: string): string[] {
  return [...new Set(findUrls(text).map((url) => url.value))];
}

export function extractHashtags(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(/(^|[\s(])#([\p{L}\p{N}_]{1,100})/gu)) {
    const tag = match[2]!;
    if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  return [...seen.values()];
}

export type UtmParams = { source: string; medium: string; campaign: string; term?: string; content?: string };

const UTM_KEYS: Array<[keyof UtmParams, string]> = [
  ['source', 'utm_source'], ['medium', 'utm_medium'], ['campaign', 'utm_campaign'], ['term', 'utm_term'], ['content', 'utm_content'],
];

/** Adds (or replaces) UTM parameters on one link, keeping every other parameter. Returns the link unchanged if it isn't a valid http(s) URL. */
export function addUtm(link: string, params: UtmParams): string {
  let url: URL;
  try { url = new URL(link); } catch { return link; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return link;
  for (const [key, param] of UTM_KEYS) {
    const value = params[key]?.trim();
    if (value) url.searchParams.set(param, value);
  }
  return url.toString();
}

/** Applies UTM parameters to every link in the text. */
export function applyUtmToText(text: string, params: UtmParams): string {
  const urls = findUrls(text);
  let out = '';
  let cursor = 0;
  for (const url of urls) {
    out += text.slice(cursor, url.start) + addUtm(url.value, params);
    cursor = url.end;
  }
  return out + text.slice(cursor);
}

/** Inserts text at the cursor (or over the selection) and returns the new value and caret position. */
export function insertAt(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return { value: value.slice(0, from) + insert + value.slice(to), caret: from + insert.length };
}

/** Inserts a hashtag with sensible spacing around it. */
export function insertHashtag(value: string, start: number, end: number, tag: string): { value: string; caret: number } {
  const clean = tag.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  if (!clean) return { value, caret: end };
  const before = value.slice(0, start);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  return insertAt(value, start, end, `${needsLeadingSpace ? ' ' : ''}#${clean} `);
}

export type PreviewToken = { type: 'text' | 'url' | 'hashtag'; value: string };

/** Splits text so previews can colour links and hashtags the way the networks do. */
export function tokenizeForPreview(text: string): PreviewToken[] {
  const tokens: PreviewToken[] = [];
  const pattern = new RegExp(`(${URL_SOURCE})|((?:^|(?<=[\\s(]))#[\\p{L}\\p{N}_]+)`, 'giu');
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > cursor) tokens.push({ type: 'text', value: text.slice(cursor, match.index) });
    const raw = match[0];
    if (match[1]) {
      const value = raw.replace(TRAILING_PUNCTUATION, '');
      tokens.push({ type: 'url', value });
      if (value.length < raw.length) tokens.push({ type: 'text', value: raw.slice(value.length) });
    } else {
      tokens.push({ type: 'hashtag', value: raw });
    }
    cursor = match.index! + raw.length;
  }
  if (cursor < text.length) tokens.push({ type: 'text', value: text.slice(cursor) });
  return tokens;
}

/** Quick schedule slots, always in the future. */
export function schedulePresets(now = new Date()): Array<{ key: string; label: string; date: Date }> {
  const at = (day: Date, hour: number) => setMilliseconds(setSeconds(setMinutes(setHours(day, hour), 0), 0), 0);
  const nextHour = setMilliseconds(setSeconds(setMinutes(addHours(now, 1), 0), 0), 0);
  const tomorrow = at(addDays(startOfDay(now), 1), 9);
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  const nextMonday = at(addDays(startOfDay(now), daysToMonday), 9);
  return [
    { key: 'hour', label: 'In an hour', date: nextHour },
    { key: 'tomorrow', label: 'Tomorrow 9:00', date: tomorrow },
    { key: 'monday', label: 'Next Monday 9:00', date: nextMonday },
  ];
}

/* ---- Local autosave of an unsent new post (per signed-in user, on this device only) ---- */

export type LocalDraft = { content: string; accountIds: string[]; savedAt: number; platformContent?: Record<string, string>; firstComment?: string; tagIds?: string[]; link?: { url: string; title?: string | null; description?: string | null; imageUrl?: string | null } | null };

export function loadLocalDraft(key: string | null): LocalDraft | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDraft>;
    if (typeof parsed.content !== 'string' || !Array.isArray(parsed.accountIds) || typeof parsed.savedAt !== 'number') return null;
    return {
      content: parsed.content, accountIds: parsed.accountIds.filter((id): id is string => typeof id === 'string'), savedAt: parsed.savedAt,
      platformContent: parsed.platformContent && typeof parsed.platformContent === 'object' ? parsed.platformContent : undefined,
      firstComment: typeof parsed.firstComment === 'string' ? parsed.firstComment : undefined,
      tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds.filter((id): id is string => typeof id === 'string') : undefined,
      link: parsed.link && typeof parsed.link === 'object' && typeof parsed.link.url === 'string' ? parsed.link : undefined,
    };
  } catch { return null; }
}

export function saveLocalDraft(key: string | null, draft: LocalDraft): boolean {
  if (!key) return false;
  try { window.localStorage.setItem(key, JSON.stringify(draft)); return true; } catch { return false; }
}

export function clearLocalDraft(key: string | null): void {
  if (!key) return;
  try { window.localStorage.removeItem(key); } catch { /* storage unavailable: nothing to clear */ }
}
