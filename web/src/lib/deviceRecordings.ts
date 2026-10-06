import { supabase } from "./supabase";

// ── Device recordings: the model shared by My Device and Library ─────────────
//
// The device writes one `recordings` row per REC/STOP (or per AI-interview
// answer). The device itself treats a chapter as ONE continuous timeline
// (`get_recording` plays the rows back-to-back), and the app mirrors that:
//   book    = rows sharing `book_id` (the device's stable per-book id; survives
//             renames). Rows from before ids existed have book_id = NULL and
//             fall back to `book_name`; they fold into the id-keyed book of the
//             same name so a book never shows as "old rows" + "new rows".
//   chapter = rows sharing (book, `chapter_idx`) — every book's chapters start
//             at 0, so chapter_idx alone would mix books. Takes play and read in
//             `turn_index` order (created_at as fallback).
// This file is the single place that grouping lives so the two screens agree.

export interface Recording {
  id: string;
  account_id: string;
  session_id: string;
  book_name: string | null;
  chapter_idx: number;
  chapter_name: string | null;
  storage_path: string;
  duration_seconds: number;
  transcription: string | null;
  transcribed_at: string | null;
  ai_question_text: string | null;
  created_at: string;
  book_id: string | null;     // device-minted, stable across renames; null = legacy row
  turn_index: number | null;  // 0-based within the chapter (AI mode); null = legacy/manual
}

export interface ChapterGroup {
  key: string;               // `${bookKey}::${chapter_idx}`
  bookKey: string;           // book_id, or `name:<book_name>` for legacy rows
  bookName: string | null;
  chapterIdx: number;
  title: string;
  takes: Recording[];        // oldest → newest: the playback/reading order
  totalDuration: number;
  latestAt: string;
}

export interface DeviceBook {
  key: string;               // book_id, or `name:<book_name>` for legacy rows
  title: string;
  chapters: ChapterGroup[];  // by chapter_idx ascending — the book's order
  totalDuration: number;
  latestAt: string;
}

export const DEFAULT_BOOK_TITLE = "My Stories"; // firmware default when no name was set

export async function fetchRecordings(userId: string): Promise<Recording[]> {
  const { data } = await supabase
    .from("recordings")
    .select("*")
    .eq("account_id", userId)
    .order("created_at", { ascending: false });
  return (data ?? []) as Recording[];
}

const legacyBookKey = (name: string | null) => `name:${name?.trim() ?? ""}`;

/** Resolve each row to a book key. Legacy rows (no book_id) join the id-keyed
 *  book with the same name when there is exactly one — the transition the
 *  finalize backfill makes permanent, applied here so the UI never splits. */
function bookKeyFor(recs: Recording[]): (r: Recording) => string {
  const idByName = new Map<string, Set<string>>();
  for (const r of recs) {
    if (!r.book_id) continue;
    const n = r.book_name?.trim() ?? "";
    if (!idByName.has(n)) idByName.set(n, new Set());
    idByName.get(n)!.add(r.book_id);
  }
  return (r) => {
    if (r.book_id) return r.book_id;
    const ids = idByName.get(r.book_name?.trim() ?? "");
    return ids && ids.size === 1 ? [...ids][0] : legacyBookKey(r.book_name);
  };
}

export function groupByChapter(recs: Recording[]): ChapterGroup[] {
  const keyOf = bookKeyFor(recs);
  const map = new Map<string, ChapterGroup>();
  for (const r of recs) {
    const bookKey = keyOf(r);
    const key = `${bookKey}::${r.chapter_idx}`;
    let g = map.get(key);
    if (!g) {
      g = { key, bookKey, bookName: r.book_name, chapterIdx: r.chapter_idx, title: "", takes: [], totalDuration: 0, latestAt: r.created_at };
      map.set(key, g);
    }
    g.takes.push(r);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    // turn_index (device-sent) is authoritative; created_at is finalize time
    // and can invert when a finalize is retried. Legacy rows have no index.
    g.takes.sort((a, b) => {
      if (a.turn_index !== null && b.turn_index !== null && a.turn_index !== b.turn_index) return a.turn_index - b.turn_index;
      return a.created_at.localeCompare(b.created_at);
    });
    g.totalDuration = g.takes.reduce((s, r) => s + (r.duration_seconds || 0), 0);
    g.latestAt = g.takes[g.takes.length - 1].created_at;
    g.title = g.takes.find((r) => r.chapter_name?.trim())?.chapter_name!.trim() || `Chapter ${g.chapterIdx + 1}`;
  }
  groups.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return groups;
}

/** Books as the Library shows them: chapters in book order, newest book first. */
export function groupByBook(recs: Recording[]): DeviceBook[] {
  const map = new Map<string, DeviceBook>();
  for (const ch of groupByChapter(recs)) {
    const key = ch.bookKey;
    let b = map.get(key);
    if (!b) {
      b = { key, title: ch.bookName?.trim() || DEFAULT_BOOK_TITLE, chapters: [], totalDuration: 0, latestAt: ch.latestAt };
      map.set(key, b);
    }
    b.chapters.push(ch);
  }
  const books = [...map.values()];
  for (const b of books) {
    b.chapters.sort((a, c) => a.chapterIdx - c.chapterIdx);
    b.totalDuration = b.chapters.reduce((s, c) => s + c.totalDuration, 0);
    b.latestAt = b.chapters.reduce((m, c) => (c.latestAt > m ? c.latestAt : m), "");
  }
  books.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return books;
}

/** The chapter as prose: takes in order, Q above A for AI-interview takes.
 *  Untranscribed takes are marked inline rather than silently dropped. */
export function chapterTranscript(g: ChapterGroup): string {
  return g.takes
    .map((r, i) => {
      const q = r.ai_question_text ? `Q: ${r.ai_question_text}\n` : "";
      if (r.transcription) return q + (r.ai_question_text ? "A: " : "") + r.transcription;
      return q + `[take ${i + 1} not yet transcribed]`;
    })
    .join("\n\n");
}

export function formatDuration(seconds: number): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
