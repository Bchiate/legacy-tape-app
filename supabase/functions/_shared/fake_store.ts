/** An in-memory Store for the handler tests. */

import type { Bucket, DeviceRow, NewRecording, Store, Take } from "./store.ts";

export interface FakeRecording extends NewRecording {
  id: string;
  createdAt: number;
}

export class FakeStore implements Store {
  devices: DeviceRow[] = [];
  /** Session JWT → user id. */
  sessions = new Map<string, string>();
  files: Record<Bucket, Map<string, Uint8Array>> = {
    recording_chunks: new Map(),
    recordings: new Map(),
  };
  recordings: FakeRecording[] = [];
  /** Paths whose download fails, to simulate a storage hiccup. */
  unreadable = new Set<string>();
  /** When set, the next insert reports a concurrent finalize of the same session. */
  raceOnInsert = false;

  #ids = 0;
  #clock = 0;

  addDevice(device: Partial<DeviceRow> = {}): DeviceRow {
    const row: DeviceRow = {
      id: `device-${++this.#ids}`,
      userId: "user-alice",
      hardwareId: "LT-A1B2C3",
      pairingToken: "8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d",
      ...device,
    };
    this.devices.push(row);
    return row;
  }

  addRecording(row: Partial<NewRecording> & { accountId: string; sessionId: string }) {
    const recording: FakeRecording = {
      storagePath: `${row.accountId}/${row.sessionId}.wav`,
      durationSeconds: 10,
      chapterIdx: 0,
      chapterName: null,
      bookId: null,
      bookName: null,
      turnIndex: null,
      ...row,
      id: `rec-${++this.#ids}`,
      createdAt: ++this.#clock,
    };
    this.recordings.push(recording);
    return recording;
  }

  deviceByHardwareId(hardwareId: string) {
    return Promise.resolve(this.devices.find((d) => d.hardwareId === hardwareId) ?? null);
  }

  deviceById(id: string) {
    return Promise.resolve(this.devices.find((d) => d.id === id) ?? null);
  }

  deleteDevice(id: string) {
    this.devices = this.devices.filter((d) => d.id !== id);
    return Promise.resolve();
  }

  userIdForJwt(jwt: string) {
    return Promise.resolve(this.sessions.get(jwt) ?? null);
  }

  upload(bucket: Bucket, path: string, bytes: Uint8Array) {
    this.files[bucket].set(path, bytes);
    return Promise.resolve();
  }

  listFiles(bucket: Bucket, prefix: string) {
    return Promise.resolve([...this.files[bucket].keys()].filter((p) => p.startsWith(prefix)));
  }

  download(bucket: Bucket, path: string) {
    if (this.unreadable.has(path)) return Promise.resolve(null);
    return Promise.resolve(this.files[bucket].get(path) ?? null);
  }

  remove(bucket: Bucket, paths: string[]) {
    for (const path of paths) this.files[bucket].delete(path);
    return Promise.resolve();
  }

  signedUrls(bucket: Bucket, paths: string[], expiresInSeconds: number) {
    const urls = new Map<string, string>();
    for (const path of paths) {
      if (this.files[bucket].has(path)) {
        urls.set(path, `https://storage.test/${bucket}/${path}?expires=${expiresInSeconds}`);
      }
    }
    return Promise.resolve(urls);
  }

  recordingIdForSession(accountId: string, sessionId: string) {
    const row = this.recordings.find((r) => r.accountId === accountId && r.sessionId === sessionId);
    return Promise.resolve(row?.id ?? null);
  }

  insertRecording(row: NewRecording): Promise<{ id: string } | "duplicate"> {
    if (this.raceOnInsert) {
      this.raceOnInsert = false;
      this.addRecording({ accountId: row.accountId, sessionId: row.sessionId });
      return Promise.resolve("duplicate");
    }
    if (this.recordings.some((r) => r.sessionId === row.sessionId)) {
      return Promise.resolve("duplicate");
    }
    return Promise.resolve({ id: this.addRecording(row).id });
  }

  backfillBookId(accountId: string, bookName: string, bookId: string) {
    for (const r of this.recordings) {
      if (r.accountId === accountId && r.bookName === bookName && r.bookId === null) {
        r.bookId = bookId;
      }
    }
    return Promise.resolve();
  }

  chapterTakes(accountId: string, chapterIdx: number, bookId: string | null): Promise<Take[]> {
    const takes = this.recordings
      .filter((r) =>
        r.accountId === accountId && r.chapterIdx === chapterIdx && (!bookId || r.bookId === bookId)
      )
      .sort((a, b) =>
        (a.turnIndex ?? Infinity) - (b.turnIndex ?? Infinity) || a.createdAt - b.createdAt
      );
    return Promise.resolve(
      takes.map((r) => ({ storagePath: r.storagePath, durationSeconds: r.durationSeconds })),
    );
  }

  deleteRecordings(accountId: string) {
    const before = this.recordings.length;
    this.recordings = this.recordings.filter((r) => r.accountId !== accountId);
    return Promise.resolve(before - this.recordings.length);
  }
}
