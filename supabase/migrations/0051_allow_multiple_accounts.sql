-- ─────────────────────────────────────────────────────────────
-- 0051: Allow a second account of a platform per client
--
-- Drops 0023's one-source-per-platform index. 0049's
-- (client_id, type, account_key) index takes over: one source per ACCOUNT,
-- plus at most one pending source (no account chosen yet) per platform.
--
-- Apply AFTER the deploy that writes data sources by account (the code before
-- it upserts on (client_id, type) and needs this index). Until it is applied,
-- adding a second account is refused with a clear message and everything else
-- works. Safe to re-run.
-- ─────────────────────────────────────────────────────────────

drop index if exists data_sources_client_type_key;
