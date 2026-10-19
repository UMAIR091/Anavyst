-- ─────────────────────────────────────────────────────────────
-- 0049: Several accounts of one platform per client (additive)
--
-- Until now a client had at most one data source per platform (0023's unique
-- index on (client_id, type)), so a client running ads from two Meta ad
-- accounts could only report on one. A data source is now one ACCOUNT of a
-- platform for a client: unique on (client_id, type, account_key), where
-- account_key is the account the source reports on, computed by the database
-- from its config so it can never disagree with what the sync reads:
--
--   gsc  → config.site_url      ga4 → config.property_id
--   everything else → config.account_id
--   none chosen yet → ''  (one "pending" source per client and platform:
--                          signed in, waiting for an account to be picked)
--
-- Search Console and GA4 stay one per client: their report sections are built
-- for a single site / property.
--
-- Rollout, so neither the old nor the new code breaks in between:
--   1. this migration and 0050 (both additive; the old (client_id, type)
--      index stays, so the current deploy keeps working, and the new code
--      finds account_key),
--   2. the deploy,
--   3. 0051, which drops the old index and so allows the second account.
--
-- Also:
--   - connections.subject_hash: a hash of the provider's stable id for who
--     signed in (a Google account id, a Facebook user or business id …), so
--     the same login signed in twice can be recognised without trusting a
--     display name or email. Null where the provider gives no stable id.
--   - Changing a source's account clears the cached data and daily history
--     that belonged to the previous account, so a report never mixes them.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────

alter table data_sources
  add column if not exists account_key text
  generated always as (
    coalesce(
      case type
        when 'gsc' then config->>'site_url'
        when 'ga4' then config->>'property_id'
        else config->>'account_id'
      end,
      ''
    )
  ) stored;

-- Non-partial, so PostgREST can use it as an ON CONFLICT target.
create unique index if not exists data_sources_client_type_account_key
  on data_sources (client_id, type, account_key);

create unique index if not exists data_sources_single_account_types_key
  on data_sources (client_id, type)
  where type in ('gsc', 'ga4');

-- ── Who signed in, recognisably ───────────────────────────────
alter table connections add column if not exists subject_hash text;

grant select (subject_hash) on connections to authenticated;

create index if not exists connections_agency_type_subject_idx
  on connections (agency_id, type, subject_hash)
  where subject_hash is not null;

-- ── A source's history belongs to its account ─────────────────
-- Snapshots and metric_daily are keyed by data_source_id. When the account a
-- source reports on changes, everything stored under it described the old
-- account, so it goes. Choosing the first account (from '') keeps nothing to
-- clear. Security definer: tenants can switch their source's account, and the
-- cleanup must reach every cache table whatever their own grants. AFTER, not
-- BEFORE: a generated column isn't computed yet when BEFORE triggers run.
create or replace function clear_data_source_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.account_key <> '' and new.account_key is distinct from old.account_key then
    delete from integration_snapshots where data_source_id = new.id;
    delete from gsc_snapshots where data_source_id = new.id;
    delete from ga4_snapshots where data_source_id = new.id;
    delete from metric_daily where data_source_id = new.id;
    -- Not "update of config", so this doesn't fire the trigger again.
    update data_sources set last_synced_at = null where id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_data_sources_clear_history on data_sources;
create trigger trg_data_sources_clear_history
  after update of config, type on data_sources
  for each row execute function clear_data_source_history();
