// The agency's Connections page, as data: every saved sign-in with who
// authorized it, who owns it, which clients use it, its health, last good
// sync and when it must be reconnected; plus ad accounts attached to more
// than one client, and sources left waiting for an account. Pure, so it is
// tested without a database. Reads no tokens.
import { getIntegration, getOAuthProvider, signInRouteOf, accessSettingsFor } from "./registry";
import { renewalFor, signInDeadline } from "./tokenRenewal";
import { duplicatesOf, type DuplicateMatch } from "./connections";
import { sourceHealth } from "./status";

const DAY_MS = 24 * 60 * 60 * 1000;
const NEVER_MS = 10 * 365 * DAY_MS;
export const WAITING_FLAG_DAYS = 14;

export type ConnectionRow = {
  id: string;
  type: string;
  client_id: string | null;
  identity_provider: string | null;
  display_name: string | null;
  subject_hash: string | null;
  status: string;
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  created_at: string;
};
export type SourceRow = {
  id: string;
  client_id: string | null;
  type: string;
  connection_id: string | null;
  account_key: string;
  status: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  config: Record<string, unknown> | null;
  created_at: string;
};
export type ClientRow = { id: string; name: string | null; archived: boolean | null };

// How long the sign-in lasts, and whether that date came from the platform.
export type Expiry = {
  kind: "reconnect_by" | "renews_until" | "renews" | "never";
  date: string | null;
  // True when the date is the platform's own (token expiry or refresh-token
  // end). Never an estimate.
  confirmed: boolean;
  note: string;
};

export type SignInView = {
  id: string;
  type: string;
  platform: string;
  icon: string;
  accent: string;
  signedInAs: string | null;
  via: string | null;
  owner: { kind: "agency" } | { kind: "client"; clientId: string; clientName: string };
  health: "healthy" | "attention" | "expired" | "waiting";
  clients: { sourceId: string; clientId: string; clientName: string; archived: boolean; account: string | null; status: string | null; error: string | null }[];
  lastSyncedAt: string | null;
  expiry: Expiry;
  duplicateOf: DuplicateMatch | null;
  reconnectHref: string | null;
  reviewHref: string | null;
  revokesAtProvider: boolean;
  accessSettings: { label: string; url: string | null };
};

export type SharedAccount = { platform: string; account: string; clients: string[] };
export type WaitingSource = { sourceId: string; clientId: string; clientName: string; platform: string; since: string };

export function expiryOf(c: ConnectionRow, platform: string, now: number): Expiry {
  const expires = c.token_expires_at ? new Date(c.token_expires_at).getTime() : null;
  if (expires !== null && expires - now >= NEVER_MS) return { kind: "never", date: null, confirmed: true, note: "Doesn't expire" };
  const conn = { type: c.type, config: { identity_provider: c.identity_provider ?? undefined }, token_expires_at: c.token_expires_at, refresh_expires_at: c.refresh_expires_at };
  const renewal = renewalFor(conn);
  const deadline = signInDeadline(conn, now);
  if (renewal === "reconnect") {
    return { kind: "reconnect_by", date: deadline, confirmed: Boolean(deadline), note: `${platform} sign-ins can't renew on their own, so it needs a fresh sign-in by then` };
  }
  if (renewal === "extend") return { kind: "renews", date: null, confirmed: true, note: "Renews itself automatically (60 days at a time)" };
  if (deadline) {
    return { kind: "renews_until", date: deadline, confirmed: true, note: `Renews automatically until then; ${platform} then needs a fresh sign-in` };
  }
  return { kind: "renews", date: null, confirmed: false, note: `Renews automatically; ${platform} doesn't say when it ends` };
}

export function buildConnectionsView(input: {
  connections: ConnectionRow[];
  sources: SourceRow[];
  clients: ClientRow[];
  now?: number;
}): { signIns: SignInView[]; sharedAccounts: SharedAccount[]; waiting: WaitingSource[] } {
  const now = input.now ?? Date.now();
  const clientById = new Map(input.clients.map((c) => [c.id, c]));
  const nameOf = (id: string | null) => (id ? clientById.get(id)?.name ?? "a client" : "a client");
  const accountName = (s: SourceRow) => {
    const def = getIntegration(s.type);
    const id = def?.readSelected?.(s.config ?? {}) ?? null;
    return id ? def?.readAccounts?.(s.config ?? {}).find((a) => a.id === id)?.name ?? id : null;
  };

  const signIns = input.connections.map((c, i): SignInView => {
    const def = getIntegration(c.type);
    const platform = def?.name ?? c.type;
    const route = def ? signInRouteOf(def, c.identity_provider) : undefined;
    const mine = input.sources.filter((s) => s.connection_id === c.id);
    const active = mine.filter((s) => s.client_id && clientById.get(s.client_id)?.archived !== true);
    const healths = mine.map((s) =>
      sourceHealth({ status: s.status, lastSyncError: s.last_sync_error, selectedAccountId: s.account_key || null })
    );
    const health: SignInView["health"] =
      c.status === "revoked"
        ? "expired"
        : healths.some((h) => h === "needs_reconnect" || h === "sync_error")
          ? "attention"
          : healths.length && healths.every((h) => h === "needs_account")
            ? "waiting"
            : "healthy";
    const lastSyncedAt = mine.map((s) => s.last_synced_at).filter((d): d is string => Boolean(d)).sort().pop() ?? null;
    const anyClient = (active[0] ?? mine[0])?.client_id ?? c.client_id ?? null;
    const earlier = duplicatesOf(c, input.connections.slice(0, i))[0] ?? null;

    return {
      id: c.id,
      type: c.type,
      platform,
      icon: def?.icon ?? "Plug",
      accent: def?.accent ?? "ink",
      signedInAs: c.display_name,
      via: route ? route.via ?? route.label.replace(/^Continue with /, "") : null,
      owner: c.client_id ? { kind: "client", clientId: c.client_id, clientName: nameOf(c.client_id) } : { kind: "agency" },
      health,
      clients: mine
        .filter((s) => s.client_id)
        .map((s) => ({
          sourceId: s.id,
          clientId: s.client_id!,
          clientName: nameOf(s.client_id),
          archived: clientById.get(s.client_id!)?.archived === true,
          account: accountName(s),
          status: s.status,
          error: s.last_sync_error,
        })),
      lastSyncedAt,
      expiry: expiryOf(c, platform, now),
      duplicateOf: earlier,
      // The connect screen lists the sign-in with Reconnect (and, for an
      // API key, the form to enter it again). A client's own sign-in is
      // renewed by the client through a new connect link.
      reconnectHref: anyClient && !c.client_id ? `/dashboard/connect/${c.type}?clientId=${anyClient}` : null,
      reviewHref: earlier && anyClient ? `/dashboard/connect/${c.type}/review?clientId=${anyClient}&connection=${c.id}` : null,
      revokesAtProvider: Boolean(getOAuthProvider(def?.oauthProviderId)?.revoke),
      accessSettings: def ? accessSettingsFor(def) : { label: `${platform} account settings`, url: null },
    };
  });

  // One ad account on more than one client: often deliberate (a shared brand
  // account), sometimes a mistake that puts one client's figures in another's
  // report. Warned about, never blocked.
  const byAccount = new Map<string, { platform: string; account: string; clients: Set<string> }>();
  for (const s of input.sources) {
    if (!s.account_key || !s.client_id) continue;
    const key = `${s.type}\u0000${s.account_key}`;
    const entry = byAccount.get(key) ?? { platform: getIntegration(s.type)?.name ?? s.type, account: accountName(s) ?? s.account_key, clients: new Set<string>() };
    entry.clients.add(nameOf(s.client_id));
    byAccount.set(key, entry);
  }
  const sharedAccounts = [...byAccount.values()]
    .filter((e) => e.clients.size > 1)
    .map((e) => ({ platform: e.platform, account: e.account, clients: [...e.clients].sort() }));

  const waiting = input.sources
    .filter((s) => !s.account_key && s.client_id && now - new Date(s.created_at).getTime() > WAITING_FLAG_DAYS * DAY_MS)
    .map((s) => ({ sourceId: s.id, clientId: s.client_id!, clientName: nameOf(s.client_id), platform: getIntegration(s.type)?.name ?? s.type, since: s.created_at }));

  return { signIns, sharedAccounts, waiting };
}
