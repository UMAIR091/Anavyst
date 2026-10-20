import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";
import { refreshAccessToken } from "@/lib/google";
import { oauthForType } from "@/lib/integrations/registry";
import { EXPIRY_BUFFER_MS, renewAheadMs } from "@/lib/integrations/tokenRenewal";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ConnectionTokens } from "@/lib/integrations/connections";
import { logError } from "@/lib/errorLog";

type DataSourceRow = {
  id: string;
  type?: string | null;
  // Carries per-connection settings such as identity_provider, used to route
  // refresh for integrations with more than one identity provider.
  config?: Record<string, unknown> | null;
  // The shared sign-in that holds this source's tokens (migrations 0046/0047).
  connection?: ConnectionTokens | null;
};

// The tokens live on the shared sign-in (connections), written with the
// service role: tenants can't. Since 0047 a source holds no tokens of its own.
type Holder = {
  table: "connections";
  db: SupabaseClient;
  id: string;
  type?: string | null;
  provider?: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
};

type TokenColumns = Pick<Holder, "access_token" | "refresh_token" | "token_expires_at">;

function holderFor(ds: DataSourceRow): Holder {
  if (!ds.connection) throw new Error("This connection has no saved sign-in. Please reconnect.");
  const sourceProvider = typeof ds.config?.identity_provider === "string" ? ds.config.identity_provider : undefined;
  return {
    table: "connections",
    db: createAdminClient(),
    id: ds.connection.id,
    type: ds.type,
    provider: ds.connection.identity_provider ?? sourceProvider,
    access_token: ds.connection.access_token,
    refresh_token: ds.connection.refresh_token,
    token_expires_at: ds.connection.token_expires_at,
  };
}

const pickTokens = (row: TokenColumns): TokenColumns => ({
  access_token: row.access_token,
  refresh_token: row.refresh_token,
  token_expires_at: row.token_expires_at,
});

const LOCK_TTL_MS = 90_000; // lease long enough to cover a refresh HTTP round-trip
const MAX_WAIT_MS = 25_000; // cap total wait for another worker's refresh (< route maxDuration)

// Valid for at least `bufferMs` more. The default treats a token as expired one
// minute early; self-extending tokens pass a much longer window (renewAheadMs).
function tokenStillValid(expiresAt: string | null, bufferMs: number = EXPIRY_BUFFER_MS): boolean {
  const ms = expiresAt ? new Date(expiresAt).getTime() : 0;
  return ms - Date.now() > bufferMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-reads just the token columns (fresh view under the lock / while waiting on
// another worker). Tokens stay server-side — never returned to callers.
async function readTokens(h: Holder): Promise<TokenColumns | null> {
  const { data } = await h.db
    .from(h.table)
    .select("access_token, refresh_token, token_expires_at")
    .eq("id", h.id)
    .maybeSingle();
  return (data as TokenColumns) ?? null;
}

// Atomically claims the refresh lease, or reclaims an expired one. Returns true
// only if THIS caller now holds the lease. The condition "lock is free or its
// lease has expired" makes stuck locks self-healing: a crashed holder's lease
// simply times out and the next caller reclaims it.
async function tryAcquireLock(h: Holder, lockId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const { data } = await h.db
    .from(h.table)
    .update({ token_lock_token: lockId, token_locked_until: untilIso })
    .eq("id", h.id)
    .or(`token_locked_until.is.null,token_locked_until.lt.${nowIso}`)
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

// Releases the lease only if we still hold it (safe against a lease that was
// already reclaimed by another worker).
async function releaseLock(h: Holder, lockId: string): Promise<void> {
  await h.db
    .from(h.table)
    .update({ token_lock_token: null, token_locked_until: null })
    .eq("id", h.id)
    .eq("token_lock_token", lockId);
}

// Returns a valid (decrypted) access token for a data source, refreshing and
// persisting a new one if the current token is expired or about to expire.
// The source's shared sign-in is what gets refreshed, so every client on it
// gets the new token.
//
// Refresh is single-flight: a short-lived DB lease ensures the cron and a manual
// "Refresh now" can't refresh the same token at the same time (which, for
// providers with rotating refresh tokens, would invalidate one of them). The
// loser of the race waits for the winner's fresh token instead of refreshing
// again. The refresh backend is resolved from the integration registry by source
// type (Google today; other OAuth providers slot in without changing this code).
export async function getValidAccessToken(ds: DataSourceRow): Promise<string> {
  const h = holderFor(ds);
  if (!h.access_token) throw new Error("This connection has no access token. Please reconnect.");
  const current = h.access_token;
  const ahead = renewAheadMs({ type: h.type, config: { identity_provider: h.provider } });
  if (tokenStillValid(h.token_expires_at, ahead)) return decrypt(current);
  // Inside an early-renewal window the current token still works, so renewing
  // is best-effort: if it can't happen now, keep using the token and try again
  // on the next sync rather than failing this one.
  const stillUsable = tokenStillValid(h.token_expires_at);
  if (!h.refresh_token) {
    if (stillUsable) return decrypt(current);
    throw new Error("Token expired and no refresh token. Please reconnect.");
  }

  const lockId = crypto.randomUUID();
  const deadline = Date.now() + MAX_WAIT_MS;

  while (true) {
    if (await tryAcquireLock(h, lockId)) {
      try {
        // Re-check under the lock: another worker may have refreshed while we
        // were queued, in which case we must NOT refresh again.
        const fresh = (await readTokens(h)) ?? pickTokens(h);
        if (fresh.access_token && tokenStillValid(fresh.token_expires_at, ahead)) {
          await releaseLock(h, lockId);
          return decrypt(fresh.access_token);
        }

        const refreshToken = fresh.refresh_token ?? h.refresh_token;
        if (!refreshToken) throw new Error("Token expired and no refresh token. Please reconnect.");

        // Route refresh to the provider that authenticated THIS sign-in (e.g.
        // Microsoft Ads may be Microsoft- or Google-authenticated).
        const oauthRefresh = oauthForType(h.type)?.refresh;
        const refreshed = oauthRefresh
          ? await oauthRefresh(decrypt(refreshToken), { provider: h.provider })
          : await refreshAccessToken(decrypt(refreshToken));
        const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

        // Persist the new token(s) AND release the lease in one write. For
        // providers that rotate the long-lived token on refresh (e.g. Meta),
        // store the new refresh token too.
        const update: Record<string, string | null> = {
          access_token: encrypt(refreshed.access_token),
          token_expires_at: newExpiry,
          token_lock_token: null,
          token_locked_until: null,
        };
        if (refreshed.refresh_token) update.refresh_token = encrypt(refreshed.refresh_token);
        // The refresh token's own end date, when the provider sends it (0052).
        const refreshExpiresIn = (refreshed as { refresh_expires_in?: number }).refresh_expires_in;
        if (refreshExpiresIn) {
          update.refresh_expires_at = new Date(Date.now() + refreshExpiresIn * 1000).toISOString();
        }
        await h.db.from(h.table).update(update).eq("id", h.id);

        return refreshed.access_token;
      } catch (err) {
        // Refresh failed — release the lease but leave the stored tokens intact
        // so a later attempt can retry. Classification (reauth vs transient) is
        // handled by the caller (syncDataSource).
        await releaseLock(h, lockId);
        if (stillUsable) {
          console.error(`[tokens] early renewal failed for ${h.type ?? "source"} ${h.table}/${h.id}: ${(err as Error).message}`);
          // Recorded for the error log too: a renewal that keeps failing would
          // otherwise only surface when the token finally expires.
          await logError({
            context: "sync",
            provider: h.type ?? null,
            errorType: "transient",
            message: `early token renewal failed (current token still valid): ${(err as Error).message}`,
            retryStatus: "will_retry",
          }).catch(() => undefined);
          return decrypt(current);
        }
        throw err;
      }
    }

    // Someone else holds the lease. An early renewal needn't wait for them:
    // the current token still works.
    if (stillUsable) return decrypt(current);

    // Otherwise wait for their refreshed token instead of piling on a second
    // refresh.
    if (Date.now() > deadline) {
      throw new Error("Token refresh is temporarily busy; please try again in a moment.");
    }
    await sleep(300 + Math.floor(Math.random() * 400)); // jittered backoff
    const latest = await readTokens(h);
    if (latest?.access_token && tokenStillValid(latest.token_expires_at)) {
      return decrypt(latest.access_token);
    }
  }
}
