// When a connection's token gets renewed, and when the user has to reconnect.
// One place, so the sync (googleTokens.getValidAccessToken), the health page
// and the client's data-source cards all agree. See TokenRenewal in types.ts.
import { oauthForType } from "./registry";
import type { TokenRenewal } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

// "refresh" tokens are renewed just before they expire.
export const EXPIRY_BUFFER_MS = 60_000;
// "extend" tokens are renewed this far ahead: comfortably more than the daily
// sync interval, and late enough that the token is past Instagram's 24-hour
// minimum age (its tokens last 60 days).
export const EXTEND_AHEAD_MS = 10 * DAY_MS;
// "reconnect" tokens start warning this far ahead of their expiry.
export const RECONNECT_WARN_MS = 14 * DAY_MS;

type Connection = { type?: string | null; config?: Record<string, unknown> | null };

export function renewalFor(conn: Connection): TokenRenewal {
  const p = conn.config?.identity_provider;
  return oauthForType(conn.type)?.renewal?.({ provider: typeof p === "string" ? p : undefined }) ?? "refresh";
}

// How long before expiry the sync should renew this connection's token.
export function renewAheadMs(conn: Connection): number {
  return renewalFor(conn) === "extend" ? EXTEND_AHEAD_MS : EXPIRY_BUFFER_MS;
}

export type SignInDates = Connection & { token_expires_at?: string | null; refresh_expires_at?: string | null };

// Expiries this far out are sentinels for "never" (API keys, OAuth 1.0a,
// Meta business system-user tokens), not dates anyone has to act on.
const NO_REAL_EXPIRY_MS = 10 * 365 * DAY_MS;

// The date a sign-in must be signed in to again by, whatever forces it: a token
// that can't be extended (Facebook Login) at its own expiry; any other when its
// refresh token runs out, where the provider says when (LinkedIn's fixed year,
// Pinterest's rolling 60 days; migration 0052). Null when nothing forces a
// fresh sign-in.
export function signInDeadline(conn: SignInDates, now: number = Date.now()): string | null {
  const real = (iso: string | null | undefined) => {
    if (!iso) return null;
    const at = new Date(iso).getTime();
    return Number.isNaN(at) || at - now >= NO_REAL_EXPIRY_MS ? null : iso;
  };
  return renewalFor(conn) === "reconnect" ? real(conn.token_expires_at) : real(conn.refresh_expires_at);
}

// The date the user must reconnect by, once it is within the warning window
// (or already past). Null when nothing is due yet.
export function reconnectDeadline(conn: SignInDates, now: number = Date.now()): string | null {
  const deadline = signInDeadline(conn, now);
  if (!deadline) return null;
  return new Date(deadline).getTime() - now <= RECONNECT_WARN_MS ? deadline : null;
}
