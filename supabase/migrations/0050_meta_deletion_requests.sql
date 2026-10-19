-- ─────────────────────────────────────────────────────────────
-- 0050: Meta data deletion requests
--
-- Meta's data deletion callback (/api/meta/data-deletion) must answer with a
-- confirmation code and a URL where the person can check their request. Each
-- request is recorded here: when it arrived, through which sign-in route,
-- and what was deleted. No personal data: the person is identified to Meta
-- by the code alone, and their sign-ins are already gone when it is written.
--
-- Server-only (service role): RLS on, no policies, no grants. Apply BEFORE
-- the deploy that adds the callback. Safe to re-run.
-- ─────────────────────────────────────────────────────────────

create table if not exists meta_deletion_requests (
  code text primary key,
  route text not null check (route in ('facebook', 'instagram')),
  sign_ins_deleted integer not null default 0,
  sources_deleted integer not null default 0,
  created_at timestamptz not null default now()
);

alter table meta_deletion_requests enable row level security;
revoke all on meta_deletion_requests from anon, authenticated;
