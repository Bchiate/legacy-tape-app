/**
 * finalize_recording: called when STOP is pressed. Joins the take's chunks
 * into one WAV and records it in `recordings`, after which the app picks it up
 * over Realtime and transcribes it on the phone.
 *
 * Required headers: x-hardware-id, x-pair-token, x-session-id
 * Optional headers:
 *   x-duration       seconds recorded (the audio length is used when absent)
 *   x-chapter        0-based chapter index within the book
 *   x-chapter-name, x-book-name
 *   x-book-id        the device's stable id for the book; survives renames
 *   x-turn-index     order of this take within its chapter
 *   x-chunk-count    chunks the recorder produced. When sent, a missing or
 *                    unreadable chunk is a 409 the device retries, instead
 *                    of a WAV with a gap in it.
 *   x-acct           sent by older firmware and ignored: a take always
 *                    belongs to the account that owns the device.
 *
 * Idempotent per session: retrying after a success returns the same row.
 */

import {
  authenticateDevice,
  bookId,
  deviceCredentials,
  intHeader,
  sessionId,
  textHeader,
} from "../_shared/device.ts";
import { earlyResponse, json } from "../_shared/http.ts";
import type { Store } from "../_shared/store.ts";
import { assembleWav, durationSeconds, MAX_CHUNKS } from "../_shared/wav.ts";

export interface FinalizeDeps {
  store: Store;
  /** Runs cleanup after the response is sent. */
  background: (task: Promise<unknown>) => void;
}

interface Chunk {
  index: number;
  path: string;
}

/** The chunk files under `prefix`, by index ("10.pcm" after "9.pcm"); other files are ignored. */
export function chunksInOrder(paths: readonly string[], prefix: string): Chunk[] {
  return paths
    .map((path) => ({ path, match: /^(\d+)\.pcm$/.exec(path.slice(prefix.length)) }))
    .filter((entry): entry is { path: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ path, match }) => ({ index: Number(match[1]), path }))
    .sort((a, b) => a.index - b.index);
}

/** True when the chunks are exactly 0 … expected-1. */
export function isComplete(chunks: readonly Chunk[], expected: number): boolean {
  return chunks.length === expected && chunks.every((chunk, i) => chunk.index === i);
}

export function createFinalizeHandler(
  { store, background }: FinalizeDeps,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const early = earlyResponse(req);
    if (early) return early;

    const creds = deviceCredentials(req);
    const session = sessionId(req);
    if (!creds || !session) return json(req, { error: "missing or malformed headers" }, 400);

    const device = await authenticateDevice(store, creds);
    if (!device) return json(req, { error: "unauthorized" }, 401);
    const account = device.userId;

    const existing = await store.recordingIdForSession(account, session);
    if (existing) return json(req, { id: existing, already_complete: true });

    const prefix = `${device.hardwareId}/${session}/`;
    const chunks = chunksInOrder(await store.listFiles("recording_chunks", prefix), prefix);
    if (chunks.length === 0) return json(req, { error: "no chunks found for this session" }, 404);

    const expected = intHeader(req, "x-chunk-count", MAX_CHUNKS);
    if (expected !== null && !isComplete(chunks, expected)) {
      return json(req, { error: "chunk count mismatch", expected, found: chunks.length }, 409);
    }

    const pcm: Uint8Array[] = [];
    let unreadable = 0;
    for (const chunk of chunks) {
      const bytes = await store.download("recording_chunks", chunk.path);
      if (bytes) pcm.push(bytes);
      else unreadable++;
    }
    if (pcm.length === 0) return json(req, { error: "could not read any chunk" }, 500);
    // Without a declared count (older firmware) a gap beats losing the take.
    if (expected !== null && unreadable > 0) {
      return json(req, { error: "chunk download failed", failed: unreadable }, 409);
    }

    const wav = assembleWav(pcm);
    const storagePath = `${account}/${session}.wav`;
    // Overwriting is safe (same session, same audio) and lets a finalize that
    // failed after this upload be retried.
    await store.upload("recordings", storagePath, wav, "audio/wav");

    const book = bookId(req);
    const bookName = textHeader(req, "x-book-name");
    const inserted = await store.insertRecording({
      accountId: account,
      sessionId: session,
      storagePath,
      durationSeconds: intHeader(req, "x-duration") || durationSeconds(wav.byteLength - 44),
      chapterIdx: intHeader(req, "x-chapter") ?? 0,
      chapterName: textHeader(req, "x-chapter-name"),
      bookId: book,
      bookName,
      turnIndex: intHeader(req, "x-turn-index"),
    });
    if (inserted === "duplicate") {
      // A concurrent finalize of the same take got there first.
      const id = await store.recordingIdForSession(account, session);
      if (id) return json(req, { id, already_complete: true });
      return json(req, { error: "session already used" }, 409);
    }

    background(store.remove("recording_chunks", chunks.map((chunk) => chunk.path)));
    // Takes recorded before the firmware had book ids join this book.
    if (book && bookName) background(store.backfillBookId(account, bookName, book));

    return json(req, { id: inserted.id });
  };
}
