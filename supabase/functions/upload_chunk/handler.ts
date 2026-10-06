/**
 * upload_chunk: stores one chunk of audio while the device is still recording.
 *
 * Headers: x-hardware-id, x-pair-token, x-session-id, x-chunk-idx (0, 1, 2…)
 * Body:    raw 16 kHz mono 16-bit little-endian PCM, 10 s per full chunk
 * Stored:  recording_chunks/<hardware_id>/<session_id>/<chunk_idx>.pcm
 *
 * Sending the same chunk again overwrites it, so the device can retry freely.
 */

import { authenticateDevice, deviceCredentials, intHeader, sessionId } from "../_shared/device.ts";
import { earlyResponse, json } from "../_shared/http.ts";
import type { Store } from "../_shared/store.ts";
import { CHUNK_BYTES, MAX_CHUNKS } from "../_shared/wav.ts";

/** Twice a full chunk: room for a firmware change in chunk length, not for abuse. */
export const MAX_CHUNK_BYTES = CHUNK_BYTES * 2;

export function createUploadChunkHandler(store: Store): (req: Request) => Promise<Response> {
  return async (req) => {
    const early = earlyResponse(req);
    if (early) return early;

    const creds = deviceCredentials(req);
    const session = sessionId(req);
    const index = intHeader(req, "x-chunk-idx", MAX_CHUNKS - 1);
    if (!creds || !session || index === null) {
      return json(req, { error: "missing or malformed headers" }, 400);
    }
    if (Number(req.headers.get("content-length") ?? 0) > MAX_CHUNK_BYTES) {
      return json(req, { error: "chunk too large" }, 413);
    }

    const device = await authenticateDevice(store, creds);
    if (!device) return json(req, { error: "unauthorized" }, 401);

    const pcm = new Uint8Array(await req.arrayBuffer());
    if (pcm.byteLength === 0) return json(req, { error: "empty chunk" }, 400);
    if (pcm.byteLength > MAX_CHUNK_BYTES) return json(req, { error: "chunk too large" }, 413);

    await store.upload(
      "recording_chunks",
      `${device.hardwareId}/${session}/${index}.pcm`,
      pcm,
      "application/octet-stream",
    );
    return json(req, { ok: true, chunk: index });
  };
}
