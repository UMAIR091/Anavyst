// Classifies integration/sync failures so the sync pipeline can tell a genuine
// "the user must reconnect" auth failure apart from a temporary provider/network
// blip. Getting this wrong in either direction is costly: marking a transient
// 5xx as "revoked" nags the user to reconnect a perfectly good connection, while
// treating a real revocation as transient leaves a dead source silently failing
// forever. So we ONLY report "reauth" on unambiguous token/authorization
// failures and default everything else to "transient".

export type IntegrationErrorKind = "reauth" | "transient";

// Signals that the stored OAuth grant is no longer usable and the user must
// re-authorize. Drawn from what Google, Meta, and the other providers actually
// return on a dead/withdrawn grant.
const REAUTH_SIGNALS: RegExp[] = [
  /invalid_grant/i, // Google: refresh token expired/revoked
  /invalid_token/i,
  /token (?:has been )?(?:expired|revoked)/i,
  /revoked/i,
  /unauthorized_client/i,
  /invalid_client/i,
  /\boauthexception\b/i, // Meta wraps auth failures in OAuthException
  /code\D*190\b/i, // Meta error code 190 = access token invalid/expired
  /session (?:has )?(?:expired|been invalidated)/i,
  /reconnect/i,
  /no (?:access|refresh) token/i, // our own "please reconnect" throws
  /please reconnect/i,
];

// Explicitly transient — checked FIRST so a "429 ... invalid" style body can't
// be misread as an auth failure. Network resets, timeouts, rate limits and 5xx
// are all retry-later, never reconnect.
const TRANSIENT_SIGNALS: RegExp[] = [
  /\b(?:429|500|502|503|504)\b/,
  /rate.?limit/i,
  /too many requests/i,
  /timed? ?out|timeout|ETIMEDOUT/i,
  /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|fetch failed/i,
  /temporar/i,
  /try again/i,
  /internal (?:server )?error/i,
  /service unavailable/i,
];

export function classifyIntegrationError(err: unknown): IntegrationErrorKind {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (TRANSIENT_SIGNALS.some((re) => re.test(message))) return "transient";
  if (REAUTH_SIGNALS.some((re) => re.test(message))) return "reauth";

  // A bare 401/403 with no transient marker means the credential was rejected.
  if (/\b401\b|\bunauthorized\b/i.test(message)) return "reauth";

  // Unknown → treat as transient. Safer to retry than to wrongly nag a reconnect.
  return "transient";
}

// The provider has locked or checkpointed the ACCOUNT behind a sign-in (Meta:
// "You cannot access the app till you log in to www.facebook.com and follow
// the instructions given", or a security checkpoint), seen 19 Oct 2026 on a
// live Instagram source. The token isn't dead: once the person clears the
// check on the platform the same sign-in works again, so this is not a
// reconnect, and saying so stops agencies reconnecting for nothing.
const ACCOUNT_LOCK_SIGNALS: RegExp[] = [
  /log in to www\.facebook\.com and follow the instructions/i,
  /\bcheckpoint/i,
  /error_subcode\D*(?:459|464)\b/i, // Meta: user checkpointed / unconfirmed
];

export function isAccountLockedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return ACCOUNT_LOCK_SIGNALS.some((re) => re.test(message));
}

export function accountLockedMessage(providerName: string, identity?: string | null): string {
  const platform = providerName.startsWith("Instagram") || providerName.startsWith("Meta") ? "Facebook" : providerName;
  return (
    `${platform} has locked the account behind this sign-in${identity ? ` (${identity})` : ""} until it completes a security check. ` +
    `Log in at ${platform === "Facebook" ? "facebook.com" : `${platform}`} and follow the steps there, then click Refresh now. No reconnect is needed.`
  );
}

// A short, safe, user-facing sentence for the dashboard. Never leaks tokens or
// raw provider payloads — the detailed provider text stays in last_sync_error
// for the owner's own diagnostics only when it's not sensitive.
export function reconnectMessage(providerName: string): string {
  return `${providerName} access has expired or was revoked. Reconnect to resume syncing.`;
}
