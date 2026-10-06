/** Shared fixtures for the handler tests. */

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";

export const HW = "LT-A1B2C3";
export const TOKEN = "8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d";
export const SESSION = "0123456789abcdef0123456789abcdef";

/** A POST to a function with the given headers and body. */
export function post(headers: Record<string, string>, body?: BodyInit): Request {
  return new Request("http://functions.test/fn", { method: "POST", headers, body });
}

/** Headers that identify the default test device, plus any extras. */
export function asDevice(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-hardware-id": HW, "x-pair-token": TOKEN, ...extra };
}

/** `length` bytes of fake PCM, all set to `fill` so chunks are recognizable after assembly. */
export function pcm(length: number, fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(fill);
}

export async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}
