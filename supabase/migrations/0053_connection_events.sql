-- ─────────────────────────────────────────────────────────────
-- 0053: Connection activity log
--
-- What happened to each saved sign-in and data source, by whom, and whether
-- it worked: connect, reconnect, reuse for another client, account choice,
-- combine, disconnect, remove everywhere, access cancelled at the provider,
-- and what the platforms told us (expired, deauthorized, data deletion).
-- Shown on the agency's Connections page.
--
-- No secrets: ids, platform, names and a small detail object only, never
-- tokens. connection_id and data_source_id carry no foreign key on purpose,
-- so the history outlives a removed sign-in. Members of the workspace read
-- it; only server code (service role) writes it.
--
-- Additive. Apply before the deploy that writes it. Safe to re-run.
-- ─────────────────────────────────────────────────────────────

create table if not exists connection_events (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies (id) on delete cascade,
  connection_id uuid,
  data_source_id uuid,
  client_id uuid references clients (id) on delete set null,
  user_id uuid references auth.users (id) on delete set null,
  -- Who caused it: a team member, the agency's client (connect link), the
  -- platform (deauthorize, expiry) or Anavyst itself (sync, cleanup).
  actor text not null default 'user' check (actor in ('user', 'client', 'provider', 'system')),
  action text not null,
  outcome text not null default 'ok' check (outcome in ('ok', 'failed')),
  platform text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists connection_events_agency_idx on connection_events (agency_id, created_at desc);
create index if not exists connection_events_connection_idx on connection_events (connection_id, created_at desc);

alter table connection_events enable row level security;
drop policy if exists "members read connection events" on connection_events;
create policy "members read connection events" on connection_events
  for select using (agency_id in (select auth_agency_ids()));

revoke all on connection_events from anon, authenticated;
grant select on connection_events to authenticated;
