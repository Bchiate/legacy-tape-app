/**
 * get_recording: what the device plays when the user presses PLAY on a chapter.
 *
 * A chapter is every take recorded into it, played back to back as one
 * timeline the user can seek across. The response lists each take in order
 * with a signed URL (valid for an hour) and its length, plus the total for
 * the device's seek bar.
 *
 * Headers: x-hardware-id, x-pair-token, x-chapter (0-based),
 *          x-book-id (optional; without it, older firmware gets the chapter
 *          index across all books, as before book ids existed)
 * Response: { found: true, count, total_duration_sec, recordings: [{ url, duration_sec }] }
 *           { found: false } when the chapter is empty
 */

import { authenticateDevice, bookId, deviceCredentials, intHeader } from "../_shared/device.ts";
import { earlyResponse, json } from "../_shared/http.ts";
import type { Store } from "../_shared/store.ts";

export const URL_LIFETIME_SECONDS = 3600;

export function createGetRecordingHandler(store: Store): (req: Request) => Promise<Response> {
  return async (req) => {
    const early = earlyResponse(req);
    if (early) return early;

    const creds = deviceCredentials(req);
    if (!creds) return json(req, { error: "missing or malformed headers" }, 400);
    const device = await authenticateDevice(store, creds);
    if (!device) return json(req, { error: "unauthorized" }, 401);

    const takes = await store.chapterTakes(
      device.userId,
      intHeader(req, "x-chapter") ?? 0,
      bookId(req),
    );
    if (takes.length === 0) return json(req, { found: false });

    const urls = await store.signedUrls(
      "recordings",
      takes.map((take) => take.storagePath),
      URL_LIFETIME_SECONDS,
    );
    const recordings = takes
      .filter((take) => urls.has(take.storagePath))
      .map((take) => ({ url: urls.get(take.storagePath)!, duration_sec: take.durationSeconds }));
    if (recordings.length === 0) {
      return json(req, { found: false, error: "no playable recordings" }, 500);
    }

    return json(req, {
      found: true,
      count: recordings.length,
      total_duration_sec: recordings.reduce((sum, r) => sum + r.duration_sec, 0),
      recordings,
    });
  };
}
