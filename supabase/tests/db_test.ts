/**
 * Database tests: the real migration files, run against Postgres compiled to
 * WebAssembly (PGlite) with a minimal stand-in for the parts of Supabase they
 * use (auth, storage, API roles, the realtime publication). Queries run as the
 * `anon` or `authenticated` role with a JWT subject set, the way PostgREST
 * runs them, so row-level security and column grants are actually enforced.
 */

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

const DEVICE = { hw: "LT-A1B2C3", token: "8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d" };
const SESSION = "0123456789abcdef0123456789abcdef";

/** Just enough of a Supabase project for the migrations to run as they do there. */
const SUPABASE_STUB = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  create schema extensions;
  create extension pgcrypto with schema extensions;
  grant usage on schema extensions to anon, authenticated, service_role;

  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    unique (bucket_id, name)
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

  create publication supabase_realtime;

  -- Supabase grants the API roles broad privileges on public by default and
  -- relies on RLS; mirror that so the tests start from the same place.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

async function migrationFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  return names.sort();
}

async function applyMigrations(db: PGlite): Promise<void> {
  for (const name of await migrationFiles()) {
    await db.exec(await Deno.readTextFile(new URL(name, MIGRATIONS_DIR)));
  }
}

/** A fresh database with the stub, all migrations and two users. */
async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  await applyMigrations(db);
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'alice@example.com', '{"full_name": "Alice Moreno"}'),
       ($2, 'bob@example.com', '{}')`,
    [ALICE, BOB],
  );
  return db;
}

type Caller = string | "anon" | "service";

/** Runs `fn` in a transaction as an API caller: a signed-in user, anon, or the service role. */
function as<T>(db: PGlite, caller: Caller, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const role = caller === "anon"
      ? "anon"
      : caller === "service"
      ? "service_role"
      : "authenticated";
    await tx.exec(`set local role ${role}`);
    if (role === "authenticated") {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [caller]);
    }
    return await fn(tx);
  });
}

/** Asserts that the statement is refused for lack of privilege (SQLSTATE 42501). */
async function assertDenied(promise: Promise<unknown>): Promise<void> {
  const error = await assertRejects(() => promise);
  assertEquals((error as { code?: string }).code, "42501", String(error));
}

async function pairDevice(db: PGlite, owner = ALICE, device = DEVICE) {
  await as(db, owner, (tx) =>
    tx.query(
      `insert into public.devices (user_id, hardware_id, pairing_token, wifi_ssid)
       values ($1, $2, $3, 'HomeNet')`,
      [owner, device.hw, device.token],
    ));
}

async function insertRecording(db: PGlite, account = ALICE, session = SESSION) {
  const { rows } = await as(db, "service", (tx) =>
    tx.query<{ id: string }>(
      `insert into public.recordings (account_id, session_id, storage_path, duration_seconds)
       values ($1::uuid, $2, $1::text || '/' || $2 || '.wav', 42) returning id`,
      [account, session],
    ));
  return rows[0].id;
}

// ── Schema ───────────────────────────────────────────────────────────────────

Deno.test("migrations apply to an empty database and can be applied again", async () => {
  const db = await freshDb();
  await applyMigrations(db);
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.profiles");
  assertEquals(rows[0].n, 2);
});

Deno.test("signup creates a profile with an 8-character family code", async () => {
  const db = await freshDb();
  const { rows } = await db.query<{ id: string; display_name: string; family_code: string }>(
    "select id, display_name, family_code from public.profiles order by id",
  );
  assertEquals(rows.map((r) => r.display_name), ["Alice Moreno", "bob"]);
  for (const row of rows) assertMatch(row.family_code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert(rows[0].family_code !== rows[1].family_code);
});

Deno.test("family codes are forgiving about case, spacing and look-alike letters", async () => {
  const db = await freshDb();
  const { rows } = await db.query<{ a: string; b: string; c: string }>(
    `select public.normalize_family_code(' 7kq4-m2xd ') as a,
            public.normalize_family_code('O1IL') as b,
            public.normalize_family_code(null) as c`,
  );
  assertEquals(rows[0], { a: "7KQ4M2XD", b: "0111", c: "" });
});

Deno.test("checks reject malformed device ids, tokens and session ids", async () => {
  const db = await freshDb();
  await assertRejects(() => pairDevice(db, ALICE, { hw: "LT-12345Z", token: DEVICE.token }));
  await assertRejects(() => pairDevice(db, ALICE, { hw: DEVICE.hw, token: "not-a-token" }));
  await assertRejects(() => insertRecording(db, ALICE, "../../etc/passwd"));
});

// ── Owner-only access ────────────────────────────────────────────────────────

Deno.test("books and chapters are visible only to their owner", async () => {
  const db = await freshDb();
  await as(db, ALICE, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "insert into public.books (user_id, title) values ($1, 'Growing up in Tucson') returning id",
      [ALICE],
    );
    await tx.query(
      "insert into public.chapters (book_id, title, transcript) values ($1, 'The house', 'We had a fig tree.')",
      [rows[0].id],
    );
  });

  await as(db, BOB, async (tx) => {
    const books = await tx.query("select * from public.books");
    const chapters = await tx.query("select * from public.chapters");
    assertEquals([books.rows.length, chapters.rows.length], [0, 0]);
  });
  await as(db, ALICE, async (tx) => {
    const chapters = await tx.query("select transcript from public.chapters");
    assertEquals(chapters.rows, [{ transcript: "We had a fig tree." }]);
  });
});

Deno.test("nobody can add a chapter to someone else's book or create a book for them", async () => {
  const db = await freshDb();
  const { rows } = await as(db, ALICE, (tx) =>
    tx.query<{ id: string }>(
      "insert into public.books (user_id, title) values ($1, 'Mine') returning id",
      [ALICE],
    ));
  await assertDenied(
    as(
      db,
      BOB,
      (tx) =>
        tx.query("insert into public.chapters (book_id, title) values ($1, 'Intruder')", [
          rows[0].id,
        ]),
    ),
  );
  await assertDenied(
    as(
      db,
      BOB,
      (tx) => tx.query("insert into public.books (user_id, title) values ($1, 'Planted')", [ALICE]),
    ),
  );
});

Deno.test("anonymous callers cannot read any table", async () => {
  const db = await freshDb();
  for (const table of ["profiles", "books", "chapters", "devices", "recordings"]) {
    await assertDenied(as(db, "anon", (tx) => tx.query(`select * from public.${table}`)));
  }
});

Deno.test("profiles: own only, and the family code cannot be chosen", async () => {
  const db = await freshDb();
  await as(db, BOB, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("select id from public.profiles");
    assertEquals(rows, [{ id: BOB }]);
    await tx.query("update public.profiles set display_name = 'Bobby' where id = $1", [BOB]);
  });
  await assertDenied(
    as(
      db,
      BOB,
      (tx) => tx.query("update public.profiles set family_code = 'AAAAAAAA' where id = $1", [BOB]),
    ),
  );
  // The app's ensureProfile() upsert (id + display_name) works for the owner.
  await as(db, BOB, (tx) =>
    tx.query(
      `insert into public.profiles (id, display_name) values ($1, 'Robert')
       on conflict (id) do update set id = excluded.id, display_name = excluded.display_name`,
      [BOB],
    ));
});

// ── Devices ──────────────────────────────────────────────────────────────────

Deno.test("a device belongs to the first account that pairs it", async () => {
  const db = await freshDb();
  await pairDevice(db, ALICE);

  // The app pairs with an upsert on hardware_id; another account is refused...
  await assertDenied(as(db, BOB, (tx) =>
    tx.query(
      `insert into public.devices (user_id, hardware_id, pairing_token) values ($1, $2, $3)
       on conflict (hardware_id) do update
       set user_id = excluded.user_id, pairing_token = excluded.pairing_token`,
      [BOB, DEVICE.hw, "f".repeat(32)],
    )));
  // ...and cannot see it.
  await as(db, BOB, async (tx) => {
    assertEquals((await tx.query("select * from public.devices")).rows.length, 0);
  });

  // The owner can re-pair after the device made a new token.
  await as(db, ALICE, (tx) =>
    tx.query(
      `insert into public.devices (user_id, hardware_id, pairing_token) values ($1, $2, $3)
       on conflict (hardware_id) do update
       set user_id = excluded.user_id, pairing_token = excluded.pairing_token`,
      [ALICE, DEVICE.hw, "e".repeat(32)],
    ));
  const { rows } = await db.query<{ pairing_token: string }>(
    "select pairing_token from public.devices",
  );
  assertEquals(rows, [{ pairing_token: "e".repeat(32) }]);
});

Deno.test("an owner cannot hand a device to another account", async () => {
  const db = await freshDb();
  await pairDevice(db, ALICE);
  await assertDenied(
    as(db, ALICE, (tx) => tx.query("update public.devices set user_id = $1", [BOB])),
  );
});

// ── Recordings ───────────────────────────────────────────────────────────────

Deno.test("only the service role can create recordings", async () => {
  const db = await freshDb();
  await assertDenied(as(db, ALICE, (tx) =>
    tx.query(
      `insert into public.recordings (account_id, session_id, storage_path)
       values ($1, $2, 'x.wav')`,
      [ALICE, SESSION],
    )));
  await insertRecording(db, ALICE);
});

Deno.test("owners can write back transcripts and chapter names, nothing else", async () => {
  const db = await freshDb();
  const id = await insertRecording(db, ALICE);
  await as(db, ALICE, (tx) =>
    tx.query(
      `update public.recordings
       set transcription = 'It was 1962.', transcribed_at = now(), chapter_name = 'Moving west'
       where id = $1`,
      [id],
    ));
  await assertDenied(
    as(
      db,
      ALICE,
      (tx) =>
        tx.query("update public.recordings set storage_path = 'b/other.wav' where id = $1", [id]),
    ),
  );
  await assertDenied(
    as(
      db,
      ALICE,
      (tx) => tx.query("update public.recordings set account_id = $2 where id = $1", [id, BOB]),
    ),
  );
});

Deno.test("other accounts cannot read, change or delete someone's recordings", async () => {
  const db = await freshDb();
  const id = await insertRecording(db, ALICE);
  await as(db, BOB, async (tx) => {
    assertEquals((await tx.query("select * from public.recordings")).rows.length, 0);
    const updated = await tx.query(
      "update public.recordings set transcription = 'x' where id = $1",
      [id],
    );
    const deleted = await tx.query("delete from public.recordings where id = $1", [id]);
    assertEquals([updated.affectedRows, deleted.affectedRows], [0, 0]);
  });
  await as(db, ALICE, async (tx) => {
    const deleted = await tx.query("delete from public.recordings where id = $1", [id]);
    assertEquals(deleted.affectedRows, 1);
  });
});

Deno.test("storage: owners read and delete their own WAVs, never chunks or others' files", async () => {
  const db = await freshDb();
  await db.query(
    `insert into storage.objects (bucket_id, name) values
       ('recordings', $1 || '/a.wav'), ('recordings', $2 || '/b.wav'),
       ('recording_chunks', 'LT-A1B2C3/' || $3 || '/0.pcm')`,
    [ALICE, BOB, SESSION],
  );
  await as(db, ALICE, async (tx) => {
    const { rows } = await tx.query<{ name: string }>("select name from storage.objects");
    assertEquals(rows, [{ name: `${ALICE}/a.wav` }]);
    const others = await tx.query("delete from storage.objects where bucket_id <> 'recordings'");
    const bobs = await tx.query("delete from storage.objects where name like $1", [`${BOB}/%`]);
    const own = await tx.query("delete from storage.objects where name like $1", [`${ALICE}/%`]);
    assertEquals([others.affectedRows, bobs.affectedRows, own.affectedRows], [0, 0, 1]);
  });
});

// ── RPCs ─────────────────────────────────────────────────────────────────────

Deno.test("device_status answers only to the right hardware id and token", async () => {
  const db = await freshDb();
  await pairDevice(db);
  await as(db, "anon", async (tx) => {
    const ok = await tx.query("select * from public.device_status($1, $2)", [
      DEVICE.hw,
      DEVICE.token,
    ]);
    const wrong = await tx.query("select * from public.device_status($1, $2)", [
      DEVICE.hw,
      "0".repeat(32),
    ]);
    assertEquals(ok.rows, [{ onboarding_complete: false }]);
    assertEquals(wrong.rows, []);
  });
});

Deno.test("device_config returns the chapter settings and records a heartbeat", async () => {
  const db = await freshDb();
  await pairDevice(db);
  await as(
    db,
    ALICE,
    (tx) => tx.query("update public.devices set chapter_mode = 'auto', chapter_auto_minutes = 15"),
  );

  const wrong = await as(
    db,
    "anon",
    (tx) => tx.query("select * from public.device_config($1, $2)", [DEVICE.hw, "0".repeat(32)]),
  );
  assertEquals(wrong.rows, []);
  const before = await db.query<{ last_seen_at: string | null }>(
    "select last_seen_at from public.devices",
  );
  assertEquals(before.rows[0].last_seen_at, null);

  const ok = await as(
    db,
    "anon",
    (tx) => tx.query("select * from public.device_config($1, $2)", [DEVICE.hw, DEVICE.token]),
  );
  assertEquals(ok.rows, [{
    onboarding_complete: false,
    chapter_mode: "auto",
    chapter_auto_minutes: 15,
  }]);
  const after = await db.query<{ last_seen_at: string | null }>(
    "select last_seen_at from public.devices",
  );
  assert(after.rows[0].last_seen_at !== null);
});

Deno.test("family_story returns a storyteller's books by code, and nothing else", async () => {
  const db = await freshDb();
  await as(db, ALICE, async (tx) => {
    const older = await tx.query<{ id: string }>(
      "insert into public.books (user_id, title, created_at) values ($1, 'Letters', now() - interval '1 day') returning id",
      [ALICE],
    );
    const newer = await tx.query<{ id: string }>(
      "insert into public.books (user_id, title) values ($1, 'Growing up') returning id",
      [ALICE],
    );
    await tx.query(
      `insert into public.chapters (book_id, title, order_index, transcript) values
         ($1, 'School', 1, 'Second.'), ($1, 'Home', 0, 'First.'), ($2, 'To my grandkids', 0, 'Dear all,')`,
      [newer.rows[0].id, older.rows[0].id],
    );
  });
  const { rows: codes } = await db.query<{ family_code: string }>(
    "select family_code from public.profiles where id = $1",
    [ALICE],
  );
  const typed = codes[0].family_code.toLowerCase().replace(/^(.{4})/, "$1-");

  const story = await as(db, BOB, async (tx) => {
    const { rows } = await tx.query<{ s: Record<string, unknown> }>(
      "select public.family_story($1) as s",
      [typed],
    );
    return rows[0].s as {
      name: string;
      books: { title: string; chapters: { title: string; transcript: string }[] }[];
    };
  });
  assertEquals(story.name, "Alice");
  assertEquals(story.books.map((b) => b.title), ["Growing up", "Letters"]);
  assertEquals(story.books[0].chapters.map((c) => c.title), ["Home", "School"]);
  const serialized = JSON.stringify(story);
  assert(!serialized.includes(ALICE) && !serialized.includes("alice@example.com"));

  const unknown = await as(
    db,
    BOB,
    (tx) => tx.query<{ s: unknown }>("select public.family_story('ZZZZZZZZ') as s"),
  );
  assertEquals(unknown.rows[0].s, null);
  await assertDenied(as(db, "anon", (tx) => tx.query("select public.family_story('x')")));
});

Deno.test("helper functions are not callable through the API", async () => {
  const db = await freshDb();
  await assertDenied(as(db, "anon", (tx) => tx.query("select public.new_family_code()")));
  await assertDenied(as(db, ALICE, (tx) => tx.query("select public.normalize_family_code('x')")));
});
