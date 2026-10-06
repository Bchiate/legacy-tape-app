import { assert, assertEquals } from "@std/assert";
import { deviceCredentials, intHeader, sameSecret, sessionId, textHeader } from "./device.ts";
import { earlyResponse, withErrorHandling } from "./http.ts";
import { post } from "./testing.ts";
import { assembleWav, CHUNK_BYTES, durationSeconds, wavHeader } from "./wav.ts";

Deno.test("wavHeader describes 16 kHz mono 16-bit PCM of the given size", () => {
  const header = wavHeader(320_000);
  const view = new DataView(header.buffer);
  const text = (from: number) => new TextDecoder().decode(header.slice(from, from + 4));
  assertEquals(header.byteLength, 44);
  assertEquals([text(0), text(8), text(12), text(36)], ["RIFF", "WAVE", "fmt ", "data"]);
  assertEquals(view.getUint32(4, true), 36 + 320_000);
  assertEquals(view.getUint16(20, true), 1); // PCM
  assertEquals(view.getUint16(22, true), 1); // mono
  assertEquals(view.getUint32(24, true), 16_000); // sample rate
  assertEquals(view.getUint32(28, true), 32_000); // byte rate
  assertEquals(view.getUint16(32, true), 2); // block align
  assertEquals(view.getUint16(34, true), 16); // bits per sample
  assertEquals(view.getUint32(40, true), 320_000);
});

Deno.test("assembleWav puts the chunks after the header, in order", () => {
  const wav = assembleWav([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])]);
  assertEquals([...wav.slice(44)], [1, 2, 3, 4, 5, 6]);
  assertEquals(new DataView(wav.buffer).getUint32(40, true), 6);
});

Deno.test("a full chunk is ten seconds", () => {
  assertEquals(CHUNK_BYTES, 320_000);
  assertEquals(durationSeconds(CHUNK_BYTES * 3 + 16_000), 31);
});

Deno.test("sameSecret compares whole strings", () => {
  assert(sameSecret("abc", "abc"));
  assert(!sameSecret("abc", "abd"));
  assert(!sameSecret("abc", "abcd"));
  assert(!sameSecret("", "a"));
});

Deno.test("device credentials must be well-formed; the token is matched lowercase", () => {
  const token = "8C4A7B9E6F1D2A3B5C4D6E7F8A9B0C1D";
  assertEquals(
    deviceCredentials(post({ "x-hardware-id": "LT-A1B2C3", "x-pair-token": token })),
    { hardwareId: "LT-A1B2C3", token: token.toLowerCase() },
  );
  const malformed: Record<string, string>[] = [
    { "x-pair-token": token },
    { "x-hardware-id": "LT-A1B2C3" },
    { "x-hardware-id": "LT-A1B2C3/..", "x-pair-token": token },
    { "x-hardware-id": "LT-A1B2C3", "x-pair-token": `${token}00` },
  ];
  for (const headers of malformed) assertEquals(deviceCredentials(post(headers)), null);
});

Deno.test("session ids cannot steer a storage path", () => {
  assertEquals(
    sessionId(post({ "x-session-id": "ABCDEF0123456789abcdef0123456789" })),
    "abcdef0123456789abcdef0123456789",
  );
  assertEquals(sessionId(post({ "x-session-id": "../LT-FFFFFF/0123456789abcdef0123" })), null);
  assertEquals(sessionId(post({})), null);
});

Deno.test("intHeader accepts plain non-negative integers within range", () => {
  const req = post({ a: "12", b: "-1", c: "1.5", d: "9999999", e: "" });
  assertEquals(intHeader(req, "a"), 12);
  assertEquals(intHeader(req, "a", 10), null);
  assertEquals([intHeader(req, "b"), intHeader(req, "c"), intHeader(req, "e")], [null, null, null]);
  assertEquals(intHeader(req, "d"), null);
  assertEquals(intHeader(req, "missing"), null);
});

Deno.test("textHeader trims, caps and drops empty values", () => {
  const req = post({ name: "  Growing Up  ", blank: "   ", long: "x".repeat(300) });
  assertEquals(textHeader(req, "name"), "Growing Up");
  assertEquals(textHeader(req, "blank"), null);
  assertEquals(textHeader(req, "long")?.length, 100);
});

Deno.test("preflight and wrong methods are answered before any handler runs", async () => {
  const preflight = earlyResponse(
    new Request("http://functions.test/fn", {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Headers": "authorization, x-client-info, x-supabase-api-version",
      },
    }),
  );
  assertEquals(preflight?.status, 204);
  assertEquals(
    preflight?.headers.get("Access-Control-Allow-Headers"),
    "authorization, x-client-info, x-supabase-api-version",
  );
  const get = earlyResponse(new Request("http://functions.test/fn"));
  assertEquals(get?.status, 405);
  await get?.body?.cancel();
  assertEquals(earlyResponse(post({})), null);
});

Deno.test("unexpected errors become a JSON 500", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const handler = withErrorHandling(() => Promise.reject(new Error("storage is down")));
    const response = await handler(post({}));
    assertEquals(response.status, 500);
    assertEquals(await response.json(), { error: "internal error" });
  } finally {
    console.error = original;
  }
});
