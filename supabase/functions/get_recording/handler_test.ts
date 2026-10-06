import { assertEquals } from "@std/assert";
import { FakeStore } from "../_shared/fake_store.ts";
import { ALICE, asDevice, BOB, body, post } from "../_shared/testing.ts";
import { createGetRecordingHandler, URL_LIFETIME_SECONDS } from "./handler.ts";

const BOOK = "00112233aabbccdd";
const OTHER_BOOK = "ffeeddccbbaa9988";

function setup() {
  const store = new FakeStore();
  store.addDevice({ userId: ALICE });
  const take = (fields: Parameters<FakeStore["addRecording"]>[0]) => {
    const row = store.addRecording(fields);
    store.files.recordings.set(row.storagePath, new Uint8Array(44));
    return row;
  };
  return { store, take, play: createGetRecordingHandler(store) };
}

const session = (c: string) => c.repeat(32);

Deno.test("plays every take of the chapter, in turn order, with signed URLs", async () => {
  const { take, play } = setup();
  // Created out of order: the device's turn index decides, then creation time.
  take({
    accountId: ALICE,
    sessionId: session("b"),
    chapterIdx: 1,
    bookId: BOOK,
    turnIndex: 1,
    durationSeconds: 20,
  });
  take({
    accountId: ALICE,
    sessionId: session("a"),
    chapterIdx: 1,
    bookId: BOOK,
    turnIndex: 0,
    durationSeconds: 30,
  });
  take({
    accountId: ALICE,
    sessionId: session("c"),
    chapterIdx: 1,
    bookId: BOOK,
    durationSeconds: 5,
  });
  take({ accountId: ALICE, sessionId: session("d"), chapterIdx: 2, bookId: BOOK });

  const response = await play(post(asDevice({ "x-chapter": "1", "x-book-id": BOOK })));
  const result = await body(response);
  assertEquals(result.found, true);
  assertEquals(result.count, 3);
  assertEquals(result.total_duration_sec, 55);
  assertEquals(
    (result.recordings as { url: string }[]).map((r) => r.url),
    ["a", "b", "c"].map((c) =>
      `https://storage.test/recordings/${ALICE}/${session(c)}.wav?expires=${URL_LIFETIME_SECONDS}`
    ),
  );
});

Deno.test("with a book id, only that book's chapter plays", async () => {
  const { take, play } = setup();
  take({ accountId: ALICE, sessionId: session("a"), chapterIdx: 0, bookId: BOOK });
  take({ accountId: ALICE, sessionId: session("b"), chapterIdx: 0, bookId: OTHER_BOOK });

  const one = await body(await play(post(asDevice({ "x-chapter": "0", "x-book-id": BOOK }))));
  assertEquals(one.count, 1);
  // Older firmware sends no book id and gets the chapter index across books.
  const legacy = await body(await play(post(asDevice({ "x-chapter": "0" }))));
  assertEquals(legacy.count, 2);
});

Deno.test("never plays another account's recordings", async () => {
  const { take, play } = setup();
  take({ accountId: BOB, sessionId: session("a"), chapterIdx: 0 });
  assertEquals(await body(await play(post(asDevice()))), { found: false });
});

Deno.test("skips takes whose audio is missing", async () => {
  const { store, take, play } = setup();
  take({ accountId: ALICE, sessionId: session("a"), durationSeconds: 7 });
  store.addRecording({ accountId: ALICE, sessionId: session("b"), durationSeconds: 9 }); // no file
  const result = await body(await play(post(asDevice())));
  assertEquals([result.count, result.total_duration_sec], [1, 7]);
});

Deno.test("refuses a wrong token", async () => {
  const { take, play } = setup();
  take({ accountId: ALICE, sessionId: session("a") });
  const response = await play(post(asDevice({ "x-pair-token": "0".repeat(32) })));
  assertEquals(response.status, 401);
  await response.body?.cancel();
});
