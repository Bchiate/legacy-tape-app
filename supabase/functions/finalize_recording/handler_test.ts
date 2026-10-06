import { assert, assertEquals } from "@std/assert";
import { FakeStore } from "../_shared/fake_store.ts";
import { ALICE, asDevice, BOB, body, HW, pcm, post, SESSION } from "../_shared/testing.ts";
import { chunksInOrder, createFinalizeHandler, isComplete } from "./handler.ts";

function setup(chunkCount = 3) {
  const store = new FakeStore();
  store.addDevice({ userId: ALICE });
  // Chunk i is filled with byte i, so the assembled order is visible.
  for (let i = 0; i < chunkCount; i++) {
    store.files.recording_chunks.set(`${HW}/${SESSION}/${i}.pcm`, pcm(4, i));
  }
  const pending: Promise<unknown>[] = [];
  const finalize = createFinalizeHandler({ store, background: (task) => pending.push(task) });
  return { store, finalize, settle: () => Promise.all(pending) };
}

const stop = (extra: Record<string, string> = {}) =>
  post(asDevice({ "x-session-id": SESSION, ...extra }), "{}");

Deno.test("joins the chunks into a WAV and files it under the device owner", async () => {
  const { store, finalize, settle } = setup();
  const response = await finalize(stop({
    "x-duration": "28",
    "x-chapter": "2",
    "x-chapter-name": "The farm",
    "x-book-name": "Growing Up",
    "x-book-id": "00112233aabbccdd",
    "x-turn-index": "0",
  }));
  assertEquals(response.status, 200);
  const { id } = await body(response);
  await settle();

  const wav = store.files.recordings.get(`${ALICE}/${SESSION}.wav`)!;
  assertEquals([...wav.slice(44)], [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  assertEquals(store.recordings.length, 1);
  const { createdAt: _, ...row } = store.recordings[0];
  assertEquals(row, {
    id: id as string,
    accountId: ALICE,
    sessionId: SESSION,
    storagePath: `${ALICE}/${SESSION}.wav`,
    durationSeconds: 28,
    chapterIdx: 2,
    chapterName: "The farm",
    bookId: "00112233aabbccdd",
    bookName: "Growing Up",
    turnIndex: 0,
  });
  assertEquals(store.files.recording_chunks.size, 0, "chunks are cleaned up");
});

Deno.test("orders chunks numerically, so chunk 10 follows chunk 9", () => {
  const prefix = `${HW}/${SESSION}/`;
  const paths = ["10.pcm", "9.pcm", "0.pcm", "notes.txt", "1.pcm"].map((name) => prefix + name);
  assertEquals(chunksInOrder(paths, prefix).map((c) => c.index), [0, 1, 9, 10]);
  assert(isComplete(chunksInOrder(paths.slice(2, 3), prefix), 1));
  assert(!isComplete(chunksInOrder(paths, prefix), 4), "2 through 8 are missing");
});

Deno.test("files the take under the device owner whatever x-acct says", async () => {
  const { store, finalize } = setup();
  const response = await finalize(stop({ "x-acct": BOB }));
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(store.recordings.map((r) => r.accountId), [ALICE]);
  assertEquals([...store.files.recordings.keys()], [`${ALICE}/${SESSION}.wav`]);
});

Deno.test("a retried finalize returns the same recording", async () => {
  const { store, finalize, settle } = setup();
  const first = await body(await finalize(stop()));
  await settle();
  const again = await body(await finalize(stop()));
  assertEquals(again, { id: first.id, already_complete: true });
  assertEquals(store.recordings.length, 1);
});

Deno.test("a concurrent finalize of the same take is answered as a retry", async () => {
  const { store, finalize } = setup();
  store.raceOnInsert = true;
  const result = await body(await finalize(stop()));
  assertEquals(result.already_complete, true);
  assertEquals(store.recordings.length, 1);
});

Deno.test("with a declared chunk count, a missing chunk is a retryable 409", async () => {
  const { store, finalize } = setup(3);
  const short = await finalize(stop({ "x-chunk-count": "4" }));
  assertEquals(short.status, 409);
  assertEquals(await body(short), { error: "chunk count mismatch", expected: 4, found: 3 });

  store.files.recording_chunks.delete(`${HW}/${SESSION}/1.pcm`);
  store.files.recording_chunks.set(`${HW}/${SESSION}/3.pcm`, pcm(4, 3));
  const gap = await finalize(stop({ "x-chunk-count": "3" }));
  assertEquals(gap.status, 409);
  await gap.body?.cancel();
  assertEquals(store.recordings.length, 0);
  assertEquals(store.files.recordings.size, 0);
});

Deno.test("an unreadable chunk fails a counted take but not an uncounted one", async () => {
  const counted = setup(3);
  counted.store.unreadable.add(`${HW}/${SESSION}/1.pcm`);
  const refused = await counted.finalize(stop({ "x-chunk-count": "3" }));
  assertEquals(refused.status, 409);
  await refused.body?.cancel();

  // Older firmware sends no count; keeping what arrived beats losing the take.
  const legacy = setup(3);
  legacy.store.unreadable.add(`${HW}/${SESSION}/1.pcm`);
  const kept = await legacy.finalize(stop());
  assertEquals(kept.status, 200);
  await kept.body?.cancel();
  const wav = legacy.store.files.recordings.get(`${ALICE}/${SESSION}.wav`)!;
  assertEquals([...wav.slice(44)], [0, 0, 0, 0, 2, 2, 2, 2]);
});

Deno.test("without x-duration the length comes from the audio", async () => {
  const { store, finalize } = setup(0);
  store.files.recording_chunks.set(`${HW}/${SESSION}/0.pcm`, pcm(320_000, 0));
  store.files.recording_chunks.set(`${HW}/${SESSION}/1.pcm`, pcm(160_000, 0));
  await (await finalize(stop())).body?.cancel();
  assertEquals(store.recordings[0].durationSeconds, 15);
});

Deno.test("takes from before book ids join their book", async () => {
  const { store, finalize, settle } = setup();
  const old = store.addRecording({
    accountId: ALICE,
    sessionId: "a".repeat(32),
    bookName: "Growing Up",
  });
  const otherBook = store.addRecording({
    accountId: ALICE,
    sessionId: "b".repeat(32),
    bookName: "Letters",
  });
  const bobs = store.addRecording({
    accountId: BOB,
    sessionId: "c".repeat(32),
    bookName: "Growing Up",
  });
  await (await finalize(stop({ "x-book-name": "Growing Up", "x-book-id": "00112233aabbccdd" })))
    .body?.cancel();
  await settle();
  assertEquals([old.bookId, otherBook.bookId, bobs.bookId], ["00112233aabbccdd", null, null]);
});

Deno.test("refuses unknown devices, bad tokens and malformed sessions", async () => {
  const { store, finalize } = setup();
  const responses = await Promise.all([
    finalize(stop({ "x-pair-token": "f".repeat(32) })),
    finalize(stop({ "x-hardware-id": "LT-FFFFFF" })),
    finalize(post(asDevice({ "x-session-id": "../x" }))),
  ]);
  assertEquals(responses.map((r) => r.status), [401, 401, 400]);
  await Promise.all(responses.map((r) => r.body?.cancel()));
  assertEquals(store.recordings.length, 0);
});

Deno.test("a session with no chunks is a 404", async () => {
  const { finalize } = setup(0);
  const response = await finalize(stop());
  assertEquals(response.status, 404);
  await response.body?.cancel();
});
