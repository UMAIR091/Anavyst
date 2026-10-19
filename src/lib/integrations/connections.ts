// Shared agency sign-ins (migration 0046). A connection holds one saved
// sign-in (encrypted tokens + who signed in) for an agency and integration
// type; each client's data_source points at the sign-in it uses and keeps its
// own account selection and sync state. So a second client reuses a sign-in by
// picking its account, and one reconnect renews every client on it.
//
// Since migration 0049 a data source is one ACCOUNT of a platform for a client
// (unique on client, type and account_key), so a client can report on two
// Meta ad accounts. Each client has at most one "pending" source per platform:
// signed in, no account chosen yet (account_key '').
//
// Tenants can read sign-ins but never their tokens, so everything here that
// touches tokens uses the service-role client. Callers authorize first (an
// RLS-scoped read of the client or data source) and pass verified ids in.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { UserFacingError } from "@/lib/errors";
import { checkIntegrationLimit } from "@/lib/billing/limits";
import { SINGLE_ACCOUNT_TYPES } from "./registry";
import type { IntegrationAccount, IntegrationConfig, IntegrationDef } from "./types";
import type { SyncableSource } from "@/lib/sync";

export type ConnectionTokens = {
  id: string;
  identity_provider: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  status?: string | null;
  // Which workspace, platform and (for a connect-link sign-in) client the
  // sign-in belongs to, so the sync can refuse a mismatched pairing.
  agency_id?: string | null;
  type?: string | null;
  client_id?: string | null;
  // Who signed in, hashed (migration 0049). Null on a sign-in saved before
  // it was recorded; the next successful sync fills it in.
  subject_hash?: string | null;
};

const CONNECTION_TOKEN_FIELDS =
  "id, agency_id, type, client_id, identity_provider, subject_hash, access_token, refresh_token, token_expires_at, status";

// Everything sync and token refresh need about a source, with its sign-in.
// Service role only: the joined token columns aren't readable by tenants.
export const SYNCABLE_SELECT =
  `id, agency_id, client_id, type, config, connection_id, ` +
  `connection:connections!data_sources_connection_fkey(${CONNECTION_TOKEN_FIELDS})`;

type SyncableRow = Omit<SyncableSource, "connection"> & { connection: ConnectionTokens | ConnectionTokens[] | null };

// PostgREST returns a to-one embed as an object, but normalize defensively.
export function toSyncable(row: SyncableRow): SyncableSource {
  const c = Array.isArray(row.connection) ? row.connection[0] ?? null : row.connection;
  return { ...row, connection: c };
}

// Loads sources with their sign-in tokens. Callers must already have checked
// the caller may act on these ids.
export async function loadSyncable(ids: string[]): Promise<SyncableSource[]> {
  if (ids.length === 0) return [];
  const { data, error } = await createAdminClient().from("data_sources").select(SYNCABLE_SELECT).in("id", ids);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as SyncableRow[]).map(toSyncable);
}

export async function loadOneSyncable(id: string): Promise<SyncableSource | null> {
  return (await loadSyncable([id]))[0] ?? null;
}

// Integrations whose sign-in can serve several clients. Those that collect a
// per-client value before signing in (a Shopify or WooCommerce store, a Google
// Sheet) are tied to that one value, so each client signs in for itself.
export function isShareable(def: IntegrationDef | undefined): boolean {
  return Boolean(def && !def.connectField && def.listAccounts && def.buildConfig);
}

// ── Accounts ────────────────────────────────────────────────

// The account a source reports on, as data_sources.account_key computes it
// (migration 0049): the selected id, or '' while none is chosen.
export function accountKeyOf(def: IntegrationDef, config: Record<string, unknown> | null | undefined): string {
  return def.readSelected?.(config ?? {}) ?? "";
}

function accountName(def: IntegrationDef, config: Record<string, unknown> | null | undefined, id: string): string {
  return def.readAccounts?.(config ?? {}).find((a) => a.id === id)?.name ?? id;
}

// What a source shows when its sign-in works but can't reach its account (a
// client removed the agency's access, or a different login renewed it).
export function noAccessMessage(def: IntegrationDef, account: string, identity: string | null | undefined): string {
  return (
    `${identity ? `${identity}` : "This sign-in"} can't access the ${def.accountNoun} “${account}” any more. ` +
    `Ask for access to it again and click Refresh now, or choose another ${def.accountNoun}.`
  );
}

// ── Who signed in ───────────────────────────────────────────

// connections.subject_hash: the provider's stable id for the login, hashed.
// Never derived from a display name or email.
export function subjectHash(type: string, subject: string | null | undefined): string | null {
  return subject ? crypto.createHash("sha256").update(`${type}\u0000${subject}`).digest("hex") : null;
}

export type DuplicateMatch = {
  id: string;
  displayName: string | null;
  // Same provider id: provably the same login. Otherwise only the names match
  // (the provider gives no stable id), which is a hint and never a reason to
  // combine credentials.
  strong: boolean;
};

type ConnectionRow = {
  id: string;
  client_id: string | null;
  identity_provider: string | null;
  display_name: string | null;
  subject_hash: string | null;
  status: string;
  updated_at?: string | null;
};

// Saved sign-ins that look like `conn`: same workspace, platform, sign-in
// route and owner (the agency, or the same client for a connect-link
// sign-in). Proven matches first.
export function duplicatesOf(conn: ConnectionRow, others: ConnectionRow[]): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  for (const o of others) {
    if (o.id === conn.id) continue;
    if ((o.identity_provider ?? null) !== (conn.identity_provider ?? null)) continue;
    if ((o.client_id ?? null) !== (conn.client_id ?? null)) continue;
    if (conn.subject_hash && o.subject_hash) {
      if (conn.subject_hash === o.subject_hash) matches.push({ id: o.id, displayName: o.display_name, strong: true });
      // Both known and different: different logins, whatever they're called.
      continue;
    }
    if (conn.display_name && o.display_name && conn.display_name === o.display_name) {
      matches.push({ id: o.id, displayName: o.display_name, strong: false });
    }
  }
  return matches.sort((a, b) => Number(b.strong) - Number(a.strong));
}

async function findDuplicate(
  admin: SupabaseClient,
  agencyId: string,
  type: string,
  conn: ConnectionRow
): Promise<DuplicateMatch | null> {
  const { data } = await admin
    .from("connections")
    .select("id, client_id, identity_provider, display_name, subject_hash, status, updated_at")
    .eq("agency_id", agencyId)
    .eq("type", type)
    .neq("id", conn.id);
  return duplicatesOf(conn, (data ?? []) as ConnectionRow[])[0] ?? null;
}

// ── Placing a source ────────────────────────────────────────

const SOURCE_FIELDS = "id, agency_id, client_id, type, config, connection_id, account_key";

type SourceRow = {
  id: string;
  agency_id: string;
  client_id: string;
  type: string;
  config: IntegrationConfig | null;
  connection_id: string | null;
  account_key: string;
};

type PgError = { code?: string; message?: string } | null;
const isUniqueViolation = (e: PgError) => e?.code === "23505";
// 0023's one-source-per-platform index, until 0051 drops it.
const isLegacySingleSourceConflict = (e: PgError) =>
  isUniqueViolation(e) && /data_sources_client_type_key/.test(e?.message ?? "");

// Keeps a source's own settings (BigQuery's dataset, the route it signed in
// through) and takes the sign-in's fresh account list. The account it reports
// on is kept unless `config` names one.
function mergedConfig(def: IntegrationDef, current: IntegrationConfig | null, fresh: IntegrationConfig): IntegrationConfig {
  const next: IntegrationConfig = { ...(current ?? {}), ...fresh };
  const kept = def.readSelected?.(current ?? {}) ?? null;
  if (!def.readSelected?.(fresh) && kept) next[def.accountConfigKey] = kept;
  return next;
}

export type PlaceSourceArgs = {
  agencyId: string;
  clientId: string;
  def: IntegrationDef;
  connectionId: string;
  displayName: string | null;
  config: IntegrationConfig;
  // Check the plan's per-client limit before adding a row. Off for flows that
  // already checked it with their own client (or that act for a link).
  enforceLimit?: boolean;
  // A client's own sign-in (connect link): never re-point a source the agency
  // connected with one of its own sign-ins. The account is then left for the
  // client to pick, and the pick is refused (api/connect-link/select).
  clientOwned?: boolean;
};

// Points one account of a client at a sign-in. The row is found by the
// account it reports on: an account this client already has is re-pointed in
// place, so its snapshots and history stay; no account yet lands on the
// client's one pending row for the platform. Writes go through `db`: the
// caller's RLS-scoped client in routes, the service role for connect links.
export async function placeSource(db: SupabaseClient, args: PlaceSourceArgs): Promise<SourceRow> {
  const { def } = args;
  const { data: rows, error: readError } = await db
    .from("data_sources")
    .select("id, config, account_key, connection_id, connection:connections!data_sources_connection_fkey(client_id)")
    .eq("client_id", args.clientId)
    .eq("type", def.id);
  if (readError) throw new Error(readError.message);
  type Existing = Pick<SourceRow, "id" | "config" | "account_key" | "connection_id"> & {
    connection: { client_id: string | null } | { client_id: string | null }[] | null;
  };
  const existing = (rows ?? []) as unknown as Existing[];
  const ownerOf = (r: Existing) => (Array.isArray(r.connection) ? r.connection[0]?.client_id : r.connection?.client_id) ?? null;

  let config = args.config;
  let key = accountKeyOf(def, config);
  const agencyHas = existing.find((r) => r.account_key === key && key !== "" && ownerOf(r) !== args.clientId);
  if (args.clientOwned && agencyHas) {
    config = { ...config, [def.accountConfigKey]: null };
    key = "";
  }
  const fields = {
    connection_id: args.connectionId,
    display_name: args.displayName,
    status: "connected",
    last_sync_error: null,
  };

  const update = async (id: string, config: IntegrationConfig) => {
    const { data, error } = await db
      .from("data_sources")
      .update({ ...fields, config })
      .eq("id", id)
      .select(SOURCE_FIELDS)
      .single();
    if (error) throw new Error(error.message);
    return data as SourceRow;
  };

  // One source per platform (Search Console, GA4; every platform before 0051):
  // signing in again renews that source, keeping its account when the
  // sign-in still lists it.
  const replace = (current: (typeof existing)[number]) => {
    const next = mergedConfig(def, current.config, config);
    const kept = def.readSelected?.(current.config ?? {}) ?? null;
    if (kept && !def.readSelected?.(config) && !def.readAccounts?.(next).some((a) => a.id === kept)) {
      next[def.accountConfigKey] = null;
    }
    return update(current.id, next);
  };

  let row: SourceRow;
  const same = existing.find((r) => r.account_key === key);
  if (same) {
    row = await update(same.id, mergedConfig(def, same.config, config));
  } else if (SINGLE_ACCOUNT_TYPES.has(def.id) && existing[0]) {
    row = await replace(existing[0]);
  } else {
    if (args.enforceLimit) {
      const limit = await checkIntegrationLimit(db, args.agencyId, args.clientId);
      if (!limit.allowed) throw new UserFacingError(limit.reason ?? "Integration limit reached.");
    }
    const { data, error } = await db
      .from("data_sources")
      .insert({ agency_id: args.agencyId, client_id: args.clientId, type: def.id, ...fields, config: config })
      .select(SOURCE_FIELDS)
      .single();
    if (!error) {
      row = data as SourceRow;
    } else if (isLegacySingleSourceConflict(error) && existing[0]) {
      // Before 0051 a client has one source per platform.
      row = await replace(existing[0]);
    } else if (isUniqueViolation(error)) {
      // Another request placed the same account a moment ago.
      const { data: raced } = await db
        .from("data_sources")
        .select("id, config")
        .eq("client_id", args.clientId)
        .eq("type", def.id)
        .eq("account_key", key)
        .maybeSingle();
      if (!raced) throw new Error(error?.message ?? "Couldn't save the connection.");
      row = await update(raced.id as string, mergedConfig(def, raced.config as IntegrationConfig | null, config));
    } else {
      throw new Error(error?.message ?? "Couldn't save the connection.");
    }
  }

  // An account was chosen, so an earlier unfinished attempt (signed in, no
  // account picked) is no longer what the client is connecting.
  if (row.account_key !== "") {
    const pending = existing.find((r) => r.account_key === "" && r.id !== row.id);
    if (pending) await db.from("data_sources").delete().eq("id", pending.id);
  }
  return row;
}

// ── Renewing a shared sign-in ───────────────────────────────

export type RenewalOutcome = {
  // Sources on the sign-in that can sync again.
  restored: number;
  // Sources whose account the renewed sign-in can't reach.
  lacking: { sourceId: string; clientId: string | null; account: string }[];
};

// After a sign-in is renewed: every source on it syncs again, except those
// whose account the new token can't reach, which say so instead of failing
// one by one. `accounts` is what the renewed sign-in lists (null when the
// integration has no list to check against).
export async function reviveConnectionSources(
  admin: SupabaseClient,
  args: { def: IntegrationDef; connectionId: string; accounts: IntegrationAccount[] | null; identity: string | null }
): Promise<RenewalOutcome> {
  const { def } = args;
  const { data } = await admin
    .from("data_sources")
    .select("id, client_id, config")
    .eq("connection_id", args.connectionId);
  const outcome: RenewalOutcome = { restored: 0, lacking: [] };
  const fresh = args.accounts && def.buildConfig ? def.buildConfig(args.accounts) : null;

  for (const row of (data ?? []) as { id: string; client_id: string | null; config: IntegrationConfig | null }[]) {
    const config = row.config ?? {};
    const selected = def.readSelected?.(config) ?? null;
    const listed = !selected || !args.accounts || args.accounts.some((a) => a.id === selected);
    if (listed) {
      // Fresh list, same account (or still none: picking stays the user's).
      const next: IntegrationConfig = fresh ? { ...config, ...fresh, [def.accountConfigKey]: selected } : config;
      await admin
        .from("data_sources")
        .update({ status: "connected", last_sync_error: null, config: next })
        .eq("id", row.id);
      outcome.restored += 1;
    } else {
      const account = accountName(def, config, selected);
      await admin
        .from("data_sources")
        .update({ status: "error", last_sync_error: noAccessMessage(def, account, args.identity) })
        .eq("id", row.id);
      outcome.lacking.push({ sourceId: row.id, clientId: row.client_id, account });
    }
  }
  return outcome;
}

// ── Saving a sign-in ────────────────────────────────────────

export type SignInTokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: string;
};

export type SaveSignInResult = {
  // The client's source the sign-in was placed on.
  source: SyncableSource;
  // Every source of this client on the sign-in (a renewal can cover several).
  clientSources: SyncableSource[];
  connectionId: string;
  // A fresh sign-in that looks like one already saved.
  duplicate: DuplicateMatch | null;
  // A renewal: what happened to every client on the sign-in.
  renewal: RenewalOutcome | null;
};

// Saves a sign-in and places it on one of the client's sources (see
// placeSource). With `connectionId` it renews that saved sign-in instead,
// which reconnects every client on it at once, but only with the same login:
// a different person's sign-in never replaces a shared one.
//
// `supabase` is the caller's client for the data_sources write (RLS-scoped in
// routes, so the client row is still checked as the user); the sign-in itself
// is written with the service role.
export async function saveSignIn(
  supabase: SupabaseClient,
  args: {
    agencyId: string;
    clientId: string;
    def: IntegrationDef;
    tokens: SignInTokens;
    identity: string | null;
    identityProvider?: string;
    config: IntegrationConfig;
    // The provider's stable id for who signed in (OAuthProvider.subject).
    subject?: string | null;
    // What the sign-in lists, to check a renewal against. Defaults to the
    // accounts in `config`.
    accounts?: IntegrationAccount[] | null;
    connectionId?: string;
    userId?: string | null;
    // A sign-in the client made itself (a connect link, migration 0048): it
    // serves that client only and is never offered to the agency's others.
    clientOwned?: boolean;
    enforceLimit?: boolean;
  }
): Promise<SaveSignInResult> {
  const admin = createAdminClient();
  const { def } = args;
  const hash = subjectHash(def.id, args.subject);
  const tokenColumns = {
    access_token: encrypt(args.tokens.accessToken),
    refresh_token: args.tokens.refreshToken ? encrypt(args.tokens.refreshToken) : null,
    token_expires_at: args.tokens.expiresAt,
  };
  const signIn = {
    identity_provider: args.identityProvider ?? null,
    display_name: args.identity,
    ...tokenColumns,
    status: "connected",
  };
  const accounts = args.accounts !== undefined ? args.accounts : def.readAccounts ? def.readAccounts(args.config) : null;
  const place = (connectionId: string) =>
    placeSource(supabase, {
      agencyId: args.agencyId,
      clientId: args.clientId,
      def,
      connectionId,
      displayName: args.identity,
      config: withRoute(args.config, args.identityProvider),
      enforceLimit: args.enforceLimit,
      clientOwned: args.clientOwned,
    });

  if (args.connectionId) {
    // Renew the saved sign-in, scoped to this agency and type so a forged id
    // can't touch anyone else's.
    const { data: existing, error: readError } = await admin
      .from("connections")
      .select("id, client_id, display_name, subject_hash")
      .eq("id", args.connectionId)
      .eq("agency_id", args.agencyId)
      .eq("type", def.id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) throw new UserFacingError("That sign-in no longer exists. Please connect again.");
    // A client's own sign-in is renewed through its connect link or by the
    // agency for that client, never for another one.
    if (existing.client_id && existing.client_id !== args.clientId) {
      throw new UserFacingError("That sign-in belongs to another client.");
    }
    const owner = (existing.display_name as string | null) ?? "another login";
    if (existing.subject_hash && hash && existing.subject_hash !== hash) {
      throw new UserFacingError(
        `You signed in as ${args.identity ?? "a different account"}, but this saved sign-in is ${owner}. Nothing was changed. ` +
          `Sign in as ${owner} to renew it, or use “Sign in with another account” to add the new login separately.`,
        `reconnect with a different login refused (connection ${existing.id})`
      );
    }

    const { error } = await admin
      .from("connections")
      .update({
        ...signIn,
        subject_hash: hash ?? existing.subject_hash ?? null,
        token_lock_token: null,
        token_locked_until: null,
      })
      .eq("id", existing.id)
      .eq("agency_id", args.agencyId);
    if (error) throw new Error(error.message);
    const connectionId = existing.id as string;

    // The client reconnecting may not use this sign-in yet (it came from the
    // consent screen); it does now.
    const { data: mine } = await supabase
      .from("data_sources")
      .select("id")
      .eq("client_id", args.clientId)
      .eq("connection_id", connectionId);
    const placed = (mine ?? []).length ? null : await place(connectionId);

    const renewal = await reviveConnectionSources(admin, { def, connectionId, accounts, identity: args.identity });
    const clientSources = await loadClientSources(admin, args.clientId, connectionId);
    const source = clientSources.find((s) => s.id === placed?.id) ?? primary(def, clientSources);
    if (!source) throw new Error("Couldn't load the reconnected source.");
    return { source, clientSources, connectionId, duplicate: null, renewal };
  }

  const { data: created, error } = await admin
    .from("connections")
    .insert({
      agency_id: args.agencyId,
      type: def.id,
      created_by: args.userId ?? null,
      client_id: args.clientOwned ? args.clientId : null,
      subject_hash: hash,
      ...signIn,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const connectionId = created.id as string;

  let row: SourceRow;
  try {
    row = await place(connectionId);
  } catch (err) {
    // Don't leave a fresh sign-in behind with no client on it.
    await admin.from("connections").delete().eq("id", connectionId);
    throw err;
  }

  const duplicate = await findDuplicate(admin, args.agencyId, def.id, {
    id: connectionId,
    client_id: args.clientOwned ? args.clientId : null,
    identity_provider: args.identityProvider ?? null,
    display_name: args.identity,
    subject_hash: hash,
    status: "connected",
  });

  const source: SyncableSource = {
    id: row.id,
    agency_id: row.agency_id,
    client_id: row.client_id,
    type: row.type,
    config: row.config,
    connection_id: connectionId,
    connection: {
      id: connectionId,
      agency_id: args.agencyId,
      type: def.id,
      client_id: args.clientOwned ? args.clientId : null,
      identity_provider: args.identityProvider ?? null,
      ...tokenColumns,
      status: "connected",
    },
  };
  return { source, clientSources: [source], connectionId, duplicate, renewal: null };
}

// The route a sign-in was made through also lives on each source's config
// (sync falls back to it), so a source re-pointed to another route says so.
function withRoute(config: IntegrationConfig, provider: string | undefined): IntegrationConfig {
  return provider ? { ...config, identity_provider: provider } : config;
}

async function loadClientSources(admin: SupabaseClient, clientId: string, connectionId: string): Promise<SyncableSource[]> {
  const { data, error } = await admin
    .from("data_sources")
    .select(SYNCABLE_SELECT)
    .eq("client_id", clientId)
    .eq("connection_id", connectionId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as SyncableRow[]).map(toSyncable);
}

// The source a toast names: one with an account chosen, if any.
function primary(def: IntegrationDef, sources: SyncableSource[]): SyncableSource | undefined {
  return sources.find((s) => def.readSelected?.(s.config ?? {})) ?? sources[0];
}
