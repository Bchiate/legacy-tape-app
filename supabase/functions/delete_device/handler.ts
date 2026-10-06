/**
 * delete_device: "Remove this device" in the app.
 *
 * Deletes the device and everything recorded with it: the account's WAVs,
 * any chunks left over from takes that never finished, the recording rows,
 * and finally the devices row, which frees the hardware id so the device can
 * be paired again (to this account or another one). Recordings are kept per
 * account rather than per device; an account has one device today.
 *
 * Called by the signed-in owner (Authorization: Bearer <session JWT>).
 * Body: { "deviceId": "<uuid>" }
 * Response: { ok: true, deleted: { wavs, chunkFiles, rows } }
 */

import { earlyResponse, json } from "../_shared/http.ts";
import type { Store } from "../_shared/store.ts";

function bearerToken(req: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "");
  return match ? match[1] : null;
}

async function requestedDeviceId(req: Request): Promise<string | null> {
  try {
    const body = await req.json();
    return typeof body?.deviceId === "string" && body.deviceId ? body.deviceId : null;
  } catch {
    return null;
  }
}

export function createDeleteDeviceHandler(store: Store): (req: Request) => Promise<Response> {
  return async (req) => {
    const early = earlyResponse(req);
    if (early) return early;

    const jwt = bearerToken(req);
    const userId = jwt ? await store.userIdForJwt(jwt) : null;
    if (!userId) return json(req, { error: "sign in to remove a device" }, 401);

    const deviceId = await requestedDeviceId(req);
    if (!deviceId) return json(req, { error: "deviceId is required" }, 400);

    // Someone else's device answers exactly like a missing one.
    const device = await store.deviceById(deviceId);
    if (!device || device.userId !== userId) return json(req, { error: "device not found" }, 404);

    const wavs = await store.listFiles("recordings", `${userId}/`);
    await store.remove("recordings", wavs);
    const chunkFiles = await store.listFiles("recording_chunks", `${device.hardwareId}/`);
    await store.remove("recording_chunks", chunkFiles);
    const rows = await store.deleteRecordings(userId);
    // Last, so a failure part-way leaves the device listed and the user can retry.
    await store.deleteDevice(device.id);

    return json(req, {
      ok: true,
      deleted: { wavs: wavs.length, chunkFiles: chunkFiles.length, rows },
    });
  };
}
