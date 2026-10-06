import { assertEquals } from "@std/assert";
import { FakeStore } from "../_shared/fake_store.ts";
import { ALICE, BOB, body, HW, post, SESSION, TOKEN } from "../_shared/testing.ts";
import { createDeleteDeviceHandler } from "./handler.ts";

function setup() {
  const store = new FakeStore();
  store.sessions.set("alice-jwt", ALICE);
  store.sessions.set("bob-jwt", BOB);
  const alices = store.addDevice({ userId: ALICE, hardwareId: HW, pairingToken: TOKEN });
  const bobs = store.addDevice({ userId: BOB, hardwareId: "LT-0000FF" });

  for (const [account, s] of [[ALICE, "a"], [ALICE, "b"], [BOB, "c"]]) {
    const row = store.addRecording({ accountId: account, sessionId: s.repeat(32) });
    store.files.recordings.set(row.storagePath, new Uint8Array(44));
  }
  store.files.recording_chunks.set(`${HW}/${SESSION}/0.pcm`, new Uint8Array(2));
  store.files.recording_chunks.set(`LT-0000FF/${SESSION}/0.pcm`, new Uint8Array(2));

  return { store, alices, bobs, remove: createDeleteDeviceHandler(store) };
}

const asUser = (jwt: string, deviceId: string) =>
  post(
    { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    JSON.stringify({ deviceId }),
  );

Deno.test("the owner removes the device and everything recorded with it", async () => {
  const { store, alices, bobs, remove } = setup();
  const response = await remove(asUser("alice-jwt", alices.id));
  assertEquals(await body(response), { ok: true, deleted: { wavs: 2, chunkFiles: 1, rows: 2 } });

  assertEquals(store.devices.map((d) => d.id), [bobs.id]);
  assertEquals(store.recordings.map((r) => r.accountId), [BOB]);
  assertEquals([...store.files.recordings.keys()], [`${BOB}/${"c".repeat(32)}.wav`]);
  assertEquals([...store.files.recording_chunks.keys()], [`LT-0000FF/${SESSION}/0.pcm`]);
});

Deno.test("someone else's device looks like a missing one, and nothing is deleted", async () => {
  const { store, bobs, remove } = setup();
  const response = await remove(asUser("alice-jwt", bobs.id));
  assertEquals(response.status, 404);
  await response.body?.cancel();
  assertEquals(store.devices.length, 2);
  assertEquals(store.recordings.length, 3);
});

Deno.test("needs a valid session: a pairing token or the API key is not enough", async () => {
  const { store, alices, remove } = setup();
  const responses = await Promise.all([
    remove(
      post({ "x-hardware-id": HW, "x-pair-token": TOKEN }, JSON.stringify({ deviceId: alices.id })),
    ),
    remove(asUser("sb_publishable_not-a-session", alices.id)),
  ]);
  assertEquals(responses.map((r) => r.status), [401, 401]);
  await Promise.all(responses.map((r) => r.body?.cancel()));
  assertEquals(store.devices.length, 2);
});

Deno.test("a request without a device id is a 400", async () => {
  const { remove } = setup();
  const responses = await Promise.all([
    remove(post({ Authorization: "Bearer alice-jwt" }, "not json")),
    remove(post({ Authorization: "Bearer alice-jwt" }, JSON.stringify({}))),
  ]);
  assertEquals(responses.map((r) => r.status), [400, 400]);
  await Promise.all(responses.map((r) => r.body?.cancel()));
});
