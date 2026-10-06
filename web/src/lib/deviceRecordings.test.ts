import { describe, expect, it } from "vitest";
import {
  type Recording,
  chapterTranscript,
  formatDuration,
  groupByBook,
  groupByChapter,
} from "./deviceRecordings";

let n = 0;
function take(fields: Partial<Recording>): Recording {
  n += 1;
  return {
    id: `rec-${n}`,
    account_id: "user-1",
    session_id: String(n).padStart(32, "0"),
    book_name: "Growing Up",
    chapter_idx: 0,
    chapter_name: null,
    storage_path: `user-1/${n}.wav`,
    duration_seconds: 10,
    transcription: null,
    transcribed_at: null,
    ai_question_text: null,
    created_at: `2026-09-11T10:00:${String(n).padStart(2, "0")}Z`,
    book_id: "aaaa000000000001",
    turn_index: null,
    ...fields,
  };
}

describe("groupByChapter", () => {
  it("keeps the same chapter number in different books apart", () => {
    const groups = groupByChapter([
      take({ chapter_idx: 0, book_id: "aaaa000000000001" }),
      take({ chapter_idx: 0, book_id: "bbbb000000000002", book_name: "Letters" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("orders takes by the device's turn index, then by time", () => {
    const [group] = groupByChapter([
      take({ id: "late", turn_index: 1, created_at: "2026-09-11T10:00:00Z" }),
      take({ id: "early", turn_index: 0, created_at: "2026-09-11T10:05:00Z" }),
    ]);
    expect(group.takes.map((t) => t.id)).toEqual(["early", "late"]);
    expect(group.totalDuration).toBe(20);
  });

  it("names a chapter after the first take that has a name", () => {
    const [named] = groupByChapter([take({}), take({ chapter_name: "  The farm " })]);
    expect(named.title).toBe("The farm");
    const [unnamed] = groupByChapter([take({ chapter_idx: 2 })]);
    expect(unnamed.title).toBe("Chapter 3");
  });

  it("folds takes from before book ids into the book with the same name", () => {
    const groups = groupByChapter([
      take({ book_id: null }),
      take({ book_id: "aaaa000000000001" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].takes).toHaveLength(2);
  });
});

describe("groupByBook", () => {
  it("lists a book's chapters in order, newest book first", () => {
    const books = groupByBook([
      take({ chapter_idx: 1, created_at: "2026-09-10T00:00:00Z" }),
      take({ chapter_idx: 0, created_at: "2026-09-10T00:00:01Z" }),
      take({ book_id: "bbbb000000000002", book_name: "Letters", created_at: "2026-09-12T00:00:00Z" }),
    ]);
    expect(books.map((b) => b.title)).toEqual(["Letters", "Growing Up"]);
    expect(books[1].chapters.map((c) => c.chapterIdx)).toEqual([0, 1]);
    expect(books[1].totalDuration).toBe(20);
  });

  it("uses the device's default title for unnamed books", () => {
    const [book] = groupByBook([take({ book_name: null })]);
    expect(book.title).toBe("My Stories");
  });
});

describe("chapterTranscript", () => {
  it("reads takes in order and marks the ones still being transcribed", () => {
    const [group] = groupByChapter([
      take({ turn_index: 0, transcription: "We lived by the river." }),
      take({ turn_index: 1 }),
      take({ turn_index: 2, ai_question_text: "Who lived next door?", transcription: "The Garcias." }),
    ]);
    expect(chapterTranscript(group)).toBe(
      "We lived by the river.\n\n[take 2 not yet transcribed]\n\nQ: Who lived next door?\nA: The Garcias.",
    );
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
  });
});
