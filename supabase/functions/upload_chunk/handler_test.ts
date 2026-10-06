import { assertEquals } from "@std/assert";
import { FakeStore } from "../_shared/fake_store.ts";
import { ALICE, asDevice, body, HW, pcm, post, SESSION } from "../_shared/testing.ts";
import { createUploadChunkHandler, MAX_CHUNK_BYTES } from "./handler.ts";

function setup() {
  const store = new FakeStore();
  store.addDevice({ userId: ALICE });
  return { store, upload: createUploadChunkHandler(store) };
}

const chunk = (idx: string, extra: Record<string, string> = {}) =>
  asDevice({ "x-session-id": SESSION, "x-chunk-idx": idx, ...extra });

Deno.test("stores the chunk under the device and session", async () => {
  const { store, upload } = setup();
  const response = await upload(post(chunk("3"), pcm(320_000, 7)));
  assertEquals(response.status, 200);
  assertEquals(await body(response), { ok: true, chunk: 3 });
  assertEquals([...store.files.recording_chunks.keys()], [`${HW}/${SESSION}/3.pcm`]);
});

Deno.test("a retried chunk overwrites the first copy", async () => {
  const { store, upload } = setup();
  await upload(post(chunk("0"), pcm(10, 1)));
  await upload(post(chunk("0"), pcm(10, 2)));
  assertEquals(store.files.recording_chunks.size, 1);
  assertEquals(store.files.recording_chunks.get(`${HW}/${SESSION}/0.pcm`)?.[0], 2);
});

Deno.test("rejects a wrong token or an unknown device", async () => {
  const { store, upload } = setup();
  const wrongToken = await upload(post(chunk("0", { "x-pair-token": "f".repeat(32) }), pcm(10, 1)));
  const unknown = await upload(post(chunk("0", { "x-hardware-id": "LT-FFFFFF" }), pcm(10, 1)));
  assertEquals([wrongToken.status, unknown.status], [401, 401]);
  await Promise.all([wrongToken.body?.cancel(), unknown.body?.cancel()]);
  assertEquals(store.files.recording_chunks.size, 0);
});

Deno.test("rejects malformed headers before touching storage", async () => {
  const { store, upload } = setup();
  for (
    const headers of [
      chunk("0", { "x-session-id": "../../recordings/x" }),
      chunk("-1"),
      chunk("1.5"),
      chunk("2000"),
      asDevice({ "x-session-id": SESSION }),
    ]
  ) {
    const response = await upload(post(headers, pcm(10, 1)));
    assertEquals(response.status, 400);
    await response.body?.cancel();
  }
  assertEquals(store.files.recording_chunks.size, 0);
});

Deno.test("rejects empty and oversized chunks", async () => {
  const { store, upload } = setup();
  const empty = await upload(post(chunk("0"), new Uint8Array()));
  const huge = await upload(post(chunk("0"), pcm(MAX_CHUNK_BYTES + 1, 1)));
  assertEquals([empty.status, huge.status], [400, 413]);
  await Promise.all([empty.body?.cancel(), huge.body?.cancel()]);
  assertEquals(store.files.recording_chunks.size, 0);
});
