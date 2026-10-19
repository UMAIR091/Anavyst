-- ─────────────────────────────────────────────────────────────
-- 0052: When a saved sign-in must be reconnected, and reminders about it
--
-- connections.refresh_expires_at: when the sign-in's REFRESH token itself
-- stops working, for providers that say so. LinkedIn's lasts a fixed 365 days
-- from the sign-in and refreshing doesn't extend it; Pinterest's is replaced
-- on each refresh and lasts 60 days. Past it the user must sign in again,
-- however often the access token was refreshed. Null where the provider gives
-- no date (or for a sign-in saved before this column: filled in on its next
-- refresh, as both providers send the date then too).
--
-- connection_reminders: which "reconnect by" emails went out, so each is sent
-- once per sign-in and deadline (a reconnect sets a new deadline, which can
-- be reminded about again). Server-only: RLS on, no policies, no grants.
--
-- Additive. Apply BEFORE the deploy that reads the column. Safe to re-run.
-- ─────────────────────────────────────────────────────────────

alter table connections add column if not exists refresh_expires_at timestamptz;

grant select (refresh_expires_at) on connections to authenticated;

create table if not exists connection_reminders (
  connection_id uuid not null references connections (id) on delete cascade,
  deadline timestamptz not null,
  stage text not null check (stage in ('14d', '3d', 'expired')),
  agency_id uuid not null references agencies (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (connection_id, deadline, stage)
);

create index if not exists connection_reminders_agency_idx on connection_reminders (agency_id, sent_at);

alter table connection_reminders enable row level security;
revoke all on connection_reminders from anon, authenticated;
