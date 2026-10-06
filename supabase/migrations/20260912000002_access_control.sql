-- Who can read and write what.
--
-- * Signed-in users see and change only their own rows. Row-level security
--   picks the rows; column grants limit what can be changed on them.
-- * Anonymous callers get no table access at all.
-- * Devices never touch tables directly. They call the edge functions, which
--   check hardware_id + pairing_token and then act with the service role, and
--   two RPCs (rpc.sql) that check the same pair.
-- * Followers read a storyteller's books only through family_story(), which
--   needs the family code.
--
-- This migration owns every policy on these tables: it drops whatever exists
-- and recreates the set below, so it can be re-applied safely.

alter table public.profiles   enable row level security;
alter table public.books      enable row level security;
alter table public.chapters   enable row level security;
alter table public.devices    enable row level security;
alter table public.recordings enable row level security;

do $$
declare
  p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles', 'books', 'chapters', 'devices', 'recordings')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end;
$$;

revoke all on public.profiles, public.books, public.chapters, public.devices, public.recordings
  from anon, authenticated;

-- ── profiles ─────────────────────────────────────────────────────────────────
-- Created by the signup trigger. The app may also create a missing profile
-- (upsert of id + display_name), but the family code is never client-chosen.
grant select on public.profiles to authenticated;
grant insert (id, display_name), update (id, display_name) on public.profiles to authenticated;

create policy "Own profile: read" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "Own profile: create" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "Own profile: update" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ── books and chapters (phone recordings) ────────────────────────────────────
grant select, insert, update, delete on public.books, public.chapters to authenticated;

create policy "Own books" on public.books
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Chapters of own books" on public.chapters
  for all to authenticated
  using (exists (
    select 1 from public.books b where b.id = chapters.book_id and b.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.books b where b.id = chapters.book_id and b.user_id = (select auth.uid())
  ));

-- ── devices ──────────────────────────────────────────────────────────────────
-- The first account to pair a device owns its row; another account's insert
-- or upsert for the same hardware_id fails until the owner removes it.
grant select, insert, update, delete on public.devices to authenticated;

create policy "Own devices" on public.devices
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ── recordings ───────────────────────────────────────────────────────────────
-- Rows are inserted only by finalize_recording (service role). Owners can
-- read and delete their takes, write back the transcript the phone produced,
-- and rename a chapter; storage paths and ownership are not editable.
grant select, delete on public.recordings to authenticated;
grant update (transcription, transcribed_at, chapter_name) on public.recordings to authenticated;

create policy "Own recordings: read" on public.recordings
  for select to authenticated using (account_id = (select auth.uid()));
create policy "Own recordings: update" on public.recordings
  for update to authenticated
  using (account_id = (select auth.uid()))
  with check (account_id = (select auth.uid()));
create policy "Own recordings: delete" on public.recordings
  for delete to authenticated using (account_id = (select auth.uid()));

-- ── helper functions ─────────────────────────────────────────────────────────
-- Not part of the API. new_family_code() stays executable by signed-in users
-- because it is the default for profiles.family_code.
revoke all on function public.new_family_code() from public, anon, authenticated;
grant execute on function public.new_family_code() to authenticated;
revoke all on function public.normalize_family_code(text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ── storage ──────────────────────────────────────────────────────────────────
-- WAVs live at recordings/<account_id>/<session_id>.wav: the first folder is
-- the owner. Owners can read them (signed URLs for playback and on-phone
-- transcription) and delete them. The raw chunk bucket has no client policy.
drop policy if exists "Users read own recording objects" on storage.objects;
drop policy if exists "Owners read their recordings" on storage.objects;
drop policy if exists "Owners delete their recordings" on storage.objects;

create policy "Owners read their recordings" on storage.objects
  for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Owners delete their recordings" on storage.objects
  for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
