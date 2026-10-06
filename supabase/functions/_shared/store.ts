/**
 * Everything the edge functions read or write, as one narrow interface.
 *
 * Production uses supabase_store.ts (supabase-js with the service role, which
 * bypasses row-level security, so every handler checks the caller first).
 * Tests use fake_store.ts, an in-memory version with the same behavior.
 */

export type Bucket = "recording_chunks" | "recordings";

export interface DeviceRow {
  id: string;
  userId: string;
  hardwareId: string;
  pairingToken: string;
}

export interface NewRecording {
  accountId: string;
  sessionId: string;
  storagePath: string;
  durationSeconds: number;
  chapterIdx: number;
  chapterName: string | null;
  bookId: string | null;
  bookName: string | null;
  turnIndex: number | null;
}

/** One take of a chapter, for playback. */
export interface Take {
  storagePath: string;
  durationSeconds: number;
}

export interface Store {
  deviceByHardwareId(hardwareId: string): Promise<DeviceRow | null>;
  deviceById(id: string): Promise<DeviceRow | null>;
  deleteDevice(id: string): Promise<void>;
  /** The user a session JWT belongs to, or null when Supabase Auth rejects it. */
  userIdForJwt(jwt: string): Promise<string | null>;

  /** Writes a file, replacing any file already at that path. */
  upload(bucket: Bucket, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Full paths of every file under `prefix` (which ends in "/"), at any depth. */
  listFiles(bucket: Bucket, prefix: string): Promise<string[]>;
  /** A file's bytes, or null when it cannot be read. */
  download(bucket: Bucket, path: string): Promise<Uint8Array | null>;
  remove(bucket: Bucket, paths: string[]): Promise<void>;
  /** Signed download URLs by path; paths that could not be signed are missing. */
  signedUrls(
    bucket: Bucket,
    paths: string[],
    expiresInSeconds: number,
  ): Promise<Map<string, string>>;

  recordingIdForSession(accountId: string, sessionId: string): Promise<string | null>;
  /** Inserts the row; "duplicate" when the session was finalized concurrently. */
  insertRecording(row: NewRecording): Promise<{ id: string } | "duplicate">;
  /** Stamps `bookId` on the account's rows for that book that predate book ids. */
  backfillBookId(accountId: string, bookName: string, bookId: string): Promise<void>;
  /**
   * The takes of one chapter in playback order: turn_index first (absent
   * last), then created_at. With a book id only that book's chapter is
   * returned; without one (older firmware), the chapter index alone decides.
   */
  chapterTakes(accountId: string, chapterIdx: number, bookId: string | null): Promise<Take[]>;
  /** Deletes all of the account's recording rows; returns how many. */
  deleteRecordings(accountId: string): Promise<number>;
}
