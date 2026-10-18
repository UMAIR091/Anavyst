// Unified integration architecture. Every data source (Search Console, GA4, and
// future ad platforms) is described by an IntegrationDef; generic services
// (OAuth, token refresh, sync, UI) consume the registry so adding a source means
// writing a descriptor, not new plumbing.

export type TokenSet = { access_token: string; refresh_token?: string; expires_in: number };

// Optional per-connection context threaded into token operations so an
// integration that supports more than one identity provider (e.g. Microsoft Ads
// via Microsoft *or* Google sign-in) can route code exchange and refresh to the
// right provider's endpoints. Absent/empty for single-provider integrations,
// which ignore it — so adding this arg is backwards compatible.
// `connectValue` carries the one value some integrations collect before OAuth
// starts (IntegrationDef.connectField) — e.g. the Google Sheet to read, which
// lets Sheets ask for the sheet itself instead of a Drive-wide scope.
export type AuthContext = { provider?: string; connectValue?: string };

// A pluggable OAuth backend, shared by every integration that authenticates
// through the same provider (e.g. all Google sources share one).
/** The stored columns a provider needs to identify which grant a row sits on. */
export type GrantOwner = { display_name: string | null; config: Record<string, unknown> | null };

export type OAuthProvider = {
  id: string;
  authUrl(state: string): string;
  exchangeCode(code: string, ctx?: AuthContext): Promise<TokenSet>;
  refresh(refreshToken: string, ctx?: AuthContext): Promise<TokenSet>;
  identity(accessToken: string, ctx?: AuthContext): Promise<string>;
  // Best-effort revocation of the grant at the provider on disconnect. Optional:
  // only providers with an official revoke endpoint implement it. Never blocks
  // disconnect — callers treat a thrown error as non-fatal.
  revoke?(tokens: { accessToken: string | null; refreshToken: string | null }): Promise<void>;
  // Identifies the PROVIDER-SIDE GRANT a connection belongs to, when several
  // connections can share one.
  //
  // Google issues a single grant per (OAuth client, Google account), holding
  // every scope the account has approved for the app across consents — so
  // Search Console, GA4, Google Ads, Business Profile, Sheets, BigQuery,
  // YouTube and a Google-signed-in Microsoft Ads connection can all sit on one
  // grant. Revocation is grant-wide, so revoking on one disconnect silently
  // kills the others. Disconnect therefore revokes only when no sibling
  // connection returns the same key (see api/google/disconnect).
  //
  // Return null when the grant can't be identified — the caller then falls back
  // to revoking, which is the safer default: a grant that outlives a disconnect
  // is a hygiene problem, but revoking a shared one destroys working
  // integrations. Undefined (the default) means each connection has its own
  // grant and disconnect can always revoke.
  grantKey?(row: GrantOwner): string | null;
  // How this connection's access outlives its token expiry (default "refresh").
  // See TokenRenewal.
  renewal?(ctx?: AuthContext): TokenRenewal;
  // Where the provider redirects back to (must match the OAuth app config).
  callbackPath: string;
};

// - "refresh": a refresh token mints new access tokens whenever needed (Google,
//   LinkedIn, Microsoft…). Renewed when the access token is about to expire.
// - "extend": the long-lived token renews itself, but only while still valid
//   (Business Login for Instagram, +60 days). Renewed well ahead of expiry,
//   because a once-a-day sync would otherwise find it already expired.
// - "reconnect": the token can't be extended at all (Facebook Login: re-
//   exchanging a long-lived token returns one with the SAME expiry, checked
//   17 Oct 2026), so the user must sign in again before it expires. The UI
//   warns ahead of the date.
export type TokenRenewal = "refresh" | "extend" | "reconnect";

// A selectable account/property/site exposed after connecting.
export type IntegrationAccount = { id: string; name: string };

export type IntegrationStatus = "live" | "soon";

// One sign-in choice on the consent screen (IntegrationDef.identityProviders).
export type IdentityProviderOption = {
  id: string;
  label: string;
  // Shown above the buttons when the sign-in isn't what the integration's
  // name suggests (Instagram through Facebook), so the redirect doesn't look
  // like a mistake.
  note?: string;
  // False hides the option, e.g. while its credentials aren't configured.
  enabled?: () => boolean;
  // Offered to platform admins only (ADMIN_EMAILS): for a sign-in the
  // provider hasn't approved for public use yet, which outside users would hit
  // as an error. Remove once the approval lands.
  adminsOnly?: boolean;
  // A fallback route that stands in for the option above it: its button reads
  // this instead of `label` (and is drawn as secondary) whenever another
  // option comes first, and plain `label` when it is the only one offered.
  alternativeLabel?: string;
  // How a saved sign-in made this way is described ("· via …"). Defaults to
  // the label without its "Continue with ".
  via?: string;
  // Sign-ins saved with no identity_provider (made before the choice existed)
  // were made this way, so they reconnect through it.
  legacy?: boolean;
};

export type IntegrationConfig = Record<string, unknown>;

export type IntegrationDef = {
  id: string; // matches data_sources.type
  name: string;
  description: string;
  icon: string; // lucide icon name (serializable for client components)
  accent: string; // theme key: emerald | amber | sky | rose | blue | cyan | fuchsia
  status: IntegrationStatus;
  oauthProviderId: string | null; // null until an OAuth backend exists
  connectPath: string | null; // route that starts the connect flow
  accountNoun: string; // "property" | "site" | "account"
  accountConfigKey: string; // config key that stores the selected account id
  snapshotTable: string | null; // where synced data is cached
  // What the integration reads and why — shown on the pre-OAuth consent screen.
  dataAccess?: { item: string; why: string }[];
  // Extra input the connect flow needs before OAuth can start (e.g. Shopify's
  // shop domain). Rendered on the consent screen and passed to connectPath.
  connectField?: { name: string; label: string; placeholder: string; hint?: string };
  // Identity providers the user can pick between at connect time (e.g. Microsoft
  // Ads accepts Microsoft or Google sign-in). When present the consent screen
  // renders one "Continue with …" button per provider and passes ?provider= to
  // the connect route, which carries it through OAuth state to code exchange and
  // stores it on the connection for provider-aware refresh. Absent = single
  // default provider (existing behavior).
  identityProviders?: IdentityProviderOption[];

  // How the connection authenticates. "oauth" (default) uses the redirect flow;
  // "apikey" collects secret(s) on the consent screen and verifies them directly
  // (no provider redirect) — for providers like Klaviyo/CallRail/Ahrefs/Semrush.
  authKind?: "oauth" | "apikey";
  // Fields an "apikey" provider collects (posted securely, never in a URL).
  connectFields?: { name: string; label: string; placeholder: string; hint?: string; secret?: boolean }[];
  // Validate collected api-key fields, returning the token to store, a display
  // name, and the selectable accounts. Called by the generic api-key connect route.
  verifyApiKey?(fields: Record<string, string>): Promise<{ displayName: string; token: string; accounts: IntegrationAccount[] }>;

  // ── server-only behavior (omit on "soon" providers) ──
  // List the accounts the authenticated user can pick from. `ctx` carries the
  // connection's identity provider for integrations that need it (e.g. Microsoft
  // Ads adds an IdentityProvider header for Google-authenticated accounts);
  // single-provider integrations ignore it.
  listAccounts?(accessToken: string, ctx?: AuthContext): Promise<IntegrationAccount[]>;
  // Fetch + shape the cached snapshot for one account and period. `ctx` carries
  // the connection's identity provider (see listAccounts). `config` is the
  // connection's stored config, threaded through for integrations that select
  // more than one level (e.g. BigQuery: project → dataset → table); single-key
  // integrations ignore it, so passing it is backwards compatible.
  fetchSnapshot?(accessToken: string, accountId: string, periodDays: number, ctx?: AuthContext, config?: IntegrationConfig): Promise<unknown>;
  // Build the initial config stored at connect time from the account list.
  buildConfig?(accounts: IntegrationAccount[]): IntegrationConfig;
  // Read the picklist and current selection back out of a stored config.
  readAccounts?(config: IntegrationConfig): IntegrationAccount[];
  readSelected?(config: IntegrationConfig): string | null;
};

// Serializable subset safe to pass into client components.
export type IntegrationDescriptor = {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  status: IntegrationStatus;
  connectPath: string | null;
  accountNoun: string;
  /** Registry verdict from isConnectable() — true for api-key providers too,
      which are live but carry no connectPath. Never re-derive this in the UI. */
  connectable: boolean;
};
