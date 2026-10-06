/**
 * The Store, backed by Supabase with the service-role key. The key bypasses
 * row-level security, so the handlers decide who may do what before calling
 * any of this.
 */

import { createClient } from "npm:@supabase/supabase-js@2.103.2";
import type { Bucket, DeviceRow, NewRecording, Store, Take } from "./store.ts";

const PAGE = 1000;

interface DeviceRecord {
  id: string;
  user_id: string;
  hardware_id: string;
  pairing_token: string;
}

const DEVICE_COLUMNS = "id, user_id, hardware_id, pairing_token";

function toDevice(row: DeviceRecord | null): DeviceRow | null {
  return row && {
    id: row.id,
    userId: row.user_id,
    hardwareId: row.hardware_id,
    pairingToken: row.pairing_token,
  };
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

/** Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, which the platform injects. */
export function storeFromEnv(): Store {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  return supabaseStore(url, key);
}

export function supabaseStore(url: string, serviceRoleKey: string): Store {
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function listFiles(bucket: Bucket, prefix: string): Promise<string[]> {
    const files: string[] = [];
    const folder = prefix.replace(/\/+$/, "");
    for (let offset = 0;; offset += PAGE) {
      const { data, error } = await db.storage.from(bucket).list(folder, { limit: PAGE, offset });
      if (error) fail(`list ${bucket}/${folder}`, error);
      for (const entry of data) {
        // Folders come back as entries without an id.
        if (entry.id === null) files.push(...await listFiles(bucket, `${folder}/${entry.name}/`));
        else files.push(`${folder}/${entry.name}`);
      }
      if (data.length < PAGE) return files;
    }
  }

  return {
    async deviceByHardwareId(hardwareId) {
      const { data, error } = await db.from("devices").select(DEVICE_COLUMNS)
        .eq("hardware_id", hardwareId).maybeSingle();
      if (error) fail("device lookup", error);
      return toDevice(data);
    },

    async deviceById(id) {
      const { data, error } = await db.from("devices").select(DEVICE_COLUMNS)
        .eq("id", id).maybeSingle();
      if (error) fail("device lookup", error);
      return toDevice(data);
    },

    async deleteDevice(id) {
      const { error } = await db.from("devices").delete().eq("id", id);
      if (error) fail("delete device", error);
    },

    async userIdForJwt(jwt) {
      const { data, error } = await db.auth.getUser(jwt);
      return error ? null : data.user?.id ?? null;
    },

    async upload(bucket, path, bytes, contentType) {
      const { error } = await db.storage.from(bucket).upload(path, bytes, {
        contentType,
        upsert: true,
      });
      if (error) fail(`upload ${bucket}/${path}`, error);
    },

    listFiles,

    async download(bucket, path) {
      const { data, error } = await db.storage.from(bucket).download(path);
      if (error || !data) {
        console.error(`download ${bucket}/${path} failed:`, error?.message);
        return null;
      }
      return new Uint8Array(await data.arrayBuffer());
    },

    async remove(bucket, paths) {
      for (let i = 0; i < paths.length; i += PAGE) {
        const { error } = await db.storage.from(bucket).remove(paths.slice(i, i + PAGE));
        if (error) fail(`remove from ${bucket}`, error);
      }
    },

    async signedUrls(bucket, paths, expiresInSeconds) {
      const urls = new Map<string, string>();
      if (paths.length === 0) return urls;
      const { data, error } = await db.storage.from(bucket).createSignedUrls(
        paths,
        expiresInSeconds,
      );
      if (error) fail(`sign ${bucket} URLs`, error);
      for (const item of data) {
        if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
      }
      return urls;
    },

    async recordingIdForSession(accountId, sessionId) {
      const { data, error } = await db.from("recordings").select("id")
        .eq("account_id", accountId).eq("session_id", sessionId).maybeSingle();
      if (error) fail("recording lookup", error);
      return data?.id ?? null;
    },

    async insertRecording(row: NewRecording) {
      const { data, error } = await db.from("recordings").insert({
        account_id: row.accountId,
        session_id: row.sessionId,
        storage_path: row.storagePath,
        duration_seconds: row.durationSeconds,
        chapter_idx: row.chapterIdx,
        chapter_name: row.chapterName,
        book_id: row.bookId,
        book_name: row.bookName,
        turn_index: row.turnIndex,
      }).select("id").single();
      if (error?.code === "23505") return "duplicate"; // unique_violation
      if (error) fail("insert recording", error);
      return { id: data.id };
    },

    async backfillBookId(accountId, bookName, bookId) {
      const { error } = await db.from("recordings").update({ book_id: bookId })
        .eq("account_id", accountId).eq("book_name", bookName).is("book_id", null);
      if (error) fail("book id backfill", error);
    },

    async chapterTakes(accountId, chapterIdx, bookId): Promise<Take[]> {
      let query = db.from("recordings").select("storage_path, duration_seconds")
        .eq("account_id", accountId).eq("chapter_idx", chapterIdx);
      if (bookId) query = query.eq("book_id", bookId);
      const { data, error } = await query
        .order("turn_index", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      if (error) fail("chapter lookup", error);
      return data.map((r) => ({
        storagePath: r.storage_path,
        durationSeconds: r.duration_seconds,
      }));
    },

    async deleteRecordings(accountId) {
      const { count, error } = await db.from("recordings").delete({ count: "exact" })
        .eq("account_id", accountId);
      if (error) fail("delete recordings", error);
      return count ?? 0;
    },
  };
}
