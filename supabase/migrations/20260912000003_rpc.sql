-- Functions called over the REST API (/rest/v1/rpc/<name>).
--
-- All are SECURITY DEFINER so they can read rows the caller has no table
-- access to, which makes each one a deliberate, narrow exception to the
-- owner-only rules: they check a secret first and return only what that
-- secret entitles the caller to. search_path is empty so every name is
-- schema-qualified and cannot be redirected.

-- ── Device: onboarding poll ──────────────────────────────────────────────────
-- Polled by the device (publishable key only, no user session) while it waits
-- on its pairing screen. Returns no row unless hardware id and token match.
create or replace function public.device_status(hw_id text, tok text)
returns table (onboarding_complete boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select d.onboarding_complete
  from public.devices d
  where d.hardware_id = hw_id and d.pairing_token = tok
$$;

-- ── Device: settings + heartbeat ─────────────────────────────────────────────
-- Like device_status, plus the chapter settings the owner chose in the app.
-- Each call records that the device was online ("Last seen" in the app).
create or replace function public.device_config(hw_id text, tok text)
returns table (onboarding_complete boolean, chapter_mode text, chapter_auto_minutes int)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.devices d
  set last_seen_at = now()
  where d.hardware_id = hw_id and d.pairing_token = tok
  returning d.onboarding_complete, d.chapter_mode, d.chapter_auto_minutes
$$;

-- Supabase grants new functions to anon and authenticated directly, not just
-- through PUBLIC, so each grant below is stated explicitly.
revoke all on function public.device_status(text, text) from public, anon, authenticated;
revoke all on function public.device_config(text, text) from public, anon, authenticated;
grant execute on function public.device_status(text, text) to anon, authenticated;
grant execute on function public.device_config(text, text) to anon, authenticated;

-- ── Followers: read a story by family code ───────────────────────────────────
-- Returns the storyteller's first name and their books with chapters, or null
-- for an unknown code. Never returns account ids or emails. Followers must be
-- signed in; with 40-bit codes, guessing one is impractical.
create or replace function public.family_story(code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'name', split_part(coalesce(p.display_name, ''), ' ', 1),
    'books', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'title', b.title,
          'type', b.type,
          'created_at', b.created_at,
          'chapters', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', c.id,
                'title', c.title,
                'order_index', c.order_index,
                'transcript', c.transcript,
                'duration_seconds', c.duration_seconds,
                'created_at', c.created_at
              )
              order by c.order_index
            )
            from public.chapters c
            where c.book_id = b.id
          ), '[]'::jsonb)
        )
        order by b.created_at desc
      )
      from public.books b
      where b.user_id = p.id
    ), '[]'::jsonb)
  )
  from public.profiles p
  where p.family_code = public.normalize_family_code(code)
$$;

revoke all on function public.family_story(text) from public, anon, authenticated;
grant execute on function public.family_story(text) to authenticated;
