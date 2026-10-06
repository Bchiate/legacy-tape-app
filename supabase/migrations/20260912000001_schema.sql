-- Legacy Tape schema: accounts, the books recorded in the phone app, paired
-- devices, and the recordings those devices upload.
--
-- Who may read or change what is defined in the next migration
-- (access_control.sql); the RPCs the device and followers call are in rpc.sql.

create extension if not exists pgcrypto with schema extensions;

-- ── Family codes ─────────────────────────────────────────────────────────────
-- A family code lets relatives follow a storyteller's phone-recorded books.
-- Codes are 8 characters of Crockford base32 (40 random bits). The alphabet
-- has exactly 32 symbols, so each random byte maps to a symbol without bias.
create or replace function public.new_family_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', get_byte(bytes, i) % 32 + 1, 1), '' order by i)
  from extensions.gen_random_bytes(8) as bytes, generate_series(0, 7) as i
$$;

-- What people type is forgiving: case, spaces and dashes are ignored, and the
-- letters Crockford base32 leaves out (O, I, L) are read as the digits they
-- look like.
create or replace function public.normalize_family_code(code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(upper(regexp_replace(coalesce(code, ''), '[[:space:]-]', '', 'g')), 'OIL', '011')
$$;

-- ── Accounts ─────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  family_code  text not null unique default public.new_family_code(),
  created_at   timestamptz not null default now()
);

-- Every new auth user gets a profile.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Books recorded in the phone app ──────────────────────────────────────────
-- (Device recordings live in `recordings`; the app groups those into books
-- itself, by the book id the device stamps on each take.)
create table if not exists public.books (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  type       text not null default 'book' check (type in ('book', 'journal')),
  created_at timestamptz not null default now()
);

create table if not exists public.chapters (
  id               uuid primary key default gen_random_uuid(),
  book_id          uuid not null references public.books (id) on delete cascade,
  title            text not null,
  order_index      int not null default 0,
  transcript       text not null default '',
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  created_at       timestamptz not null default now()
);

create index if not exists books_user_id_idx on public.books (user_id);
create index if not exists chapters_book_id_idx on public.chapters (book_id);

-- ── Devices ──────────────────────────────────────────────────────────────────
-- A row is created by the app when the user scans the device's QR code, before
-- the Bluetooth handshake. The pairing token from the QR code is the device's
-- credential from then on: it sends hardware_id + pairing_token with every
-- call, and the edge functions and RPCs check both.
create table if not exists public.devices (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  hardware_id          text not null unique check (hardware_id ~ '^LT-[0-9A-Fa-f]{6}$'),
  pairing_token        text not null check (pairing_token ~ '^[0-9a-f]{32}$'),
  wifi_ssid            text,
  paired_at            timestamptz not null default now(),
  last_seen_at         timestamptz,
  created_at           timestamptz not null default now(),

  -- Onboarding, written by the app after the device joins WiFi. The device
  -- polls onboarding_complete and leaves its pairing screen when it turns true.
  setup_for            text check (setup_for in ('self', 'other')),
  subject_name         text,
  subject_dob          date,
  pronouns             text check (pronouns in ('he', 'she', 'they')),
  subject_speaks       boolean not null default true,
  survey_answers       jsonb,
  sync_requested       boolean not null default false,
  onboarding_complete  boolean not null default false,

  -- When the device starts a new chapter: on a control on the device
  -- ('manual'), every N minutes ('auto'), or by the interviewer ('ai').
  chapter_mode         text not null default 'manual' check (chapter_mode in ('manual', 'auto', 'ai')),
  chapter_auto_minutes int not null default 10 check (chapter_auto_minutes between 1 and 240)
);

create index if not exists devices_user_id_idx on public.devices (user_id);

-- ── Recordings ───────────────────────────────────────────────────────────────
-- One row per take: everything recorded between REC and STOP. Written only by
-- the finalize_recording edge function once every audio chunk has arrived.
--
-- Storage (both buckets private):
--   recording_chunks/<hardware_id>/<session_id>/<chunk_idx>.pcm
--       16 kHz mono 16-bit PCM, 10 s per chunk, uploaded while recording.
--       Deleted once the take is finalized.
--   recordings/<account_id>/<session_id>.wav
--       The assembled take. `storage_path` holds the path inside the bucket.
--
-- A chapter is every take with the same (account_id, book_id, chapter_idx);
-- takes play back to back in turn_index order, then created_at.
create table if not exists public.recordings (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references auth.users (id) on delete cascade,
  session_id       text not null unique check (session_id ~ '^[0-9a-f]{32}$'),
  book_id          text check (book_id ~ '^[0-9a-f]{8,64}$'),
  book_name        text,
  chapter_idx      int not null default 0 check (chapter_idx >= 0),
  chapter_name     text,
  turn_index       int check (turn_index >= 0),
  storage_path     text not null unique,
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  ai_question_text text,
  transcription    text,
  transcribed_at   timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists recordings_account_id_idx on public.recordings (account_id);
create index if not exists recordings_account_book_chapter_idx
  on public.recordings (account_id, book_id, chapter_idx);

-- The app shows new takes and finished transcripts live.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'recordings'
  ) then
    alter publication supabase_realtime add table public.recordings;
  end if;
end;
$$;

insert into storage.buckets (id, name, public)
values ('recording_chunks', 'recording_chunks', false),
       ('recordings', 'recordings', false)
on conflict (id) do nothing;
