// The integration registry — single source of truth that generic services and
// UI read from. Adding a source = add a descriptor in providers.ts.
import { gscDef, ga4Def, metaAdsDef, instagramDef, googleAdsDef, gbpDef, shopifyDef, woocommerceDef, mailchimpDef, klaviyoDef, callrailDef, microsoftAdsDef, ahrefsDef, semrushDef, mozDef, stripeDef, youtubeAnalyticsDef, bigqueryDef, sheetsDef, hubspotDef, linkedinAdsDef, tiktokAdsDef, pinterestAdsDef, snapchatAdsDef, redditAdsDef, amazonAdsDef, xAdsDef, adobeAnalyticsDef, salesforceDef, activecampaignDef, constantContactDef, campaignMonitorDef, soonDefs } from "./providers";
import { googleOAuth, googleAdsOAuth, gbpOAuth, sheetsOAuth, youtubeOAuth, bigqueryOAuth } from "./oauth/google";
import { metaOAuth } from "./oauth/meta";
import { instagramOAuth } from "./oauth/instagram";
import { shopifyOAuth } from "./oauth/shopify";
import { woocommerceOAuth } from "./oauth/woocommerce";
import { mailchimpOAuth } from "./oauth/mailchimp";
import { hubspotOAuth } from "./oauth/hubspot";
import { linkedinOAuth } from "./oauth/linkedin";
import { tiktokOAuth } from "./oauth/tiktok";
import { microsoftAdsOAuth } from "./oauth/microsoftAds";
import { pinterestOAuth } from "./oauth/pinterest";
import { snapchatOAuth } from "./oauth/snapchat";
import { redditOAuth } from "./oauth/reddit";
import { amazonOAuth } from "./oauth/amazon";
import { adobeOAuth } from "./oauth/adobe";
import { salesforceOAuth } from "./oauth/salesforce";
import { constantContactOAuth } from "./oauth/constantcontact";
import { campaignMonitorOAuth } from "./oauth/campaignmonitor";
import { stripeOAuth } from "./oauth/stripe";
import type { IntegrationDef, OAuthProvider, IntegrationDescriptor, IdentityProviderOption } from "./types";

const DEFS: IntegrationDef[] = [gscDef, ga4Def, googleAdsDef, metaAdsDef, instagramDef, gbpDef, shopifyDef, woocommerceDef, mailchimpDef, klaviyoDef, callrailDef, microsoftAdsDef, ahrefsDef, semrushDef, mozDef, stripeDef, youtubeAnalyticsDef, bigqueryDef, sheetsDef, hubspotDef, linkedinAdsDef, tiktokAdsDef, pinterestAdsDef, snapchatAdsDef, redditAdsDef, amazonAdsDef, xAdsDef, adobeAnalyticsDef, salesforceDef, activecampaignDef, constantContactDef, campaignMonitorDef, ...soonDefs];

const BY_ID: Record<string, IntegrationDef> = {};
for (const d of DEFS) BY_ID[d.id] = d;

const OAUTH: Record<string, OAuthProvider> = {
  google: googleOAuth,
  google_ads: googleAdsOAuth,
  gbp: gbpOAuth,
  sheets: sheetsOAuth,
  youtube_analytics: youtubeOAuth,
  bigquery: bigqueryOAuth,
  meta: metaOAuth,
  instagram: instagramOAuth,
  shopify: shopifyOAuth,
  woocommerce: woocommerceOAuth,
  mailchimp: mailchimpOAuth,
  hubspot: hubspotOAuth,
  linkedin: linkedinOAuth,
  tiktok: tiktokOAuth,
  microsoft: microsoftAdsOAuth,
  pinterest: pinterestOAuth,
  snapchat: snapchatOAuth,
  reddit: redditOAuth,
  amazon: amazonOAuth,
  adobe: adobeOAuth,
  salesforce: salesforceOAuth,
  constantcontact: constantContactOAuth,
  campaignmonitor: campaignMonitorOAuth,
  stripe: stripeOAuth,
};

export function listIntegrations(): IntegrationDef[] {
  return DEFS;
}

// Integration honesty (launch audit P0-2). An integration is only truly
// connectable in production if its provider credentials are actually configured.
// LIVE_INTEGRATIONS is an explicit allowlist of ids that are production-ready in
// THIS environment; anything coded as "live" but not on the list is presented as
// "coming soon" and cannot be connected. When the var is unset, all coded-live
// integrations are treated as live (dev/preview convenience).
function liveAllowlist(): Set<string> | null {
  const raw = process.env.LIVE_INTEGRATIONS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// Coded and credentialled, but the PROVIDER has not yet approved public use, so
// an outside agency cannot actually connect it. Held at "coming soon"
// everywhere — homepage grid, live count, connect pages — whatever
// LIVE_INTEGRATIONS says, because that env var is edited by hand in Vercel and
// had drifted into advertising these as "Live" (launch audit 2026-09-28, P1-1).
// Remove an id only once its approval is confirmed AND a production sync has
// returned real data. Syncing of sources already connected is unaffected.
// On 30 Sep the owner confirmed every other integration works in production and
// narrowed the hold to these:
//   bigquery           scope not Google-verified
//   callrail           held by the owner
// Added 15 Oct 2026 at the owner's request:
//   sheets             spreadsheets.readonly not submitted for Google
//                      verification, so connecting showed "Google hasn't
//                      verified this app"
//   hubspot            HubSpot app not approved/listed for public use
// Released 15 Oct 2026: pinterest_ads, once Pinterest granted Standard access
// (owner-confirmed). Its ad data has still never been read in production:
// Pinterest doesn't allow ad accounts in Pakistan, so the owner can't test it.
export const AWAITING_PROVIDER_APPROVAL = new Set([
  "bigquery",
  "callrail",
  "sheets",
  "hubspot",
]);

// The status a user actually sees/experiences, after applying the allowlist.
export function effectiveStatus(def: IntegrationDef): IntegrationDef["status"] {
  if (def.status !== "live") return def.status;
  if (AWAITING_PROVIDER_APPROVAL.has(def.id)) return "soon";
  const allow = liveAllowlist();
  return !allow || allow.has(def.id) ? "live" : "soon";
}

// True only when the integration is genuinely connectable here. The single guard
// every connect path and the UI use — so a half-configured provider can never be
// connected.
export function isLive(id: string | null | undefined): boolean {
  const def = getIntegration(id);
  return !!def && effectiveStatus(def) === "live";
}

export function liveIntegrations(): IntegrationDef[] {
  return DEFS.filter((d) => effectiveStatus(d) === "live");
}

// Can a user actually start connecting this today? Live is necessary but not
// sufficient: OAuth providers need a `connectPath`, while api-key providers
// (Klaviyo, CallRail, Ahrefs, Semrush, Moz, ActiveCampaign) have none and
// collect their key on the consent screen instead.
//
// This rule already existed, inlined in the connect consent page, while
// IntegrationCard tested `status === "live" && connectPath` and the
// integrations page tested only `status === "live"`. That split is why the same
// six api-key integrations offered a "Connect" button on Integrations and read
// "Coming soon" on the client page. All three now call this.
export function isConnectable(def: IntegrationDef | undefined | null): boolean {
  if (!def || effectiveStatus(def) !== "live") return false;
  return def.authKind === "apikey" || !!def.connectPath;
}

export function connectableIntegrations(): IntegrationDef[] {
  return DEFS.filter(isConnectable);
}

// Types the background sync can process (live + fetchable + has a snapshot
// table). The cron uses this so new integrations are synced automatically —
// hard-coding type lists in routes is how Meta Ads got silently skipped.
export function syncableTypes(): string[] {
  return liveIntegrations()
    .filter((d) => d.fetchSnapshot && d.snapshotTable)
    .map((d) => d.id);
}

export function getIntegration(id: string | null | undefined): IntegrationDef | undefined {
  return id ? BY_ID[id] : undefined;
}

export function getOAuthProvider(id: string | null | undefined): OAuthProvider | undefined {
  return id ? OAUTH[id] : undefined;
}

// The sign-in options this viewer may use: configured ones, minus admin-only
// previews for anyone but a platform admin. The consent screen renders these
// and handleConnect accepts only these, so a hidden option can't be reached
// by typing ?provider= by hand.
export function availableIdentityProviders(def: IntegrationDef, viewerIsAdmin: boolean): IdentityProviderOption[] {
  return (def.identityProviders ?? []).filter((p) => (p.enabled?.() ?? true) && (!p.adminsOnly || viewerIsAdmin));
}

// Search Console and GA4 report one site / property per client: their report
// sections are built for a single one. The database holds the same line
// (migration 0049).
export const SINGLE_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["gsc", "ga4"]);

// Whether a client can connect more than one account of this platform (two
// Meta ad accounts, two Google Ads accounts …), each its own data source.
export function allowsMultipleAccounts(def: IntegrationDef | undefined): boolean {
  return Boolean(def && def.readSelected && !SINGLE_ACCOUNT_TYPES.has(def.id));
}

// A sign-in button's text and weight, by its place among the options shown.
export function signInButton(p: IdentityProviderOption, index: number): { label: string; secondary: boolean } {
  const alternative = index > 0 && Boolean(p.alternativeLabel);
  return { label: alternative ? p.alternativeLabel! : p.label, secondary: alternative };
}

// The route a saved sign-in was made through: its stored identity_provider, or
// for one saved before the integration offered a choice, the legacy option.
export function signInRouteOf(def: IntegrationDef, identityProvider: string | null): IdentityProviderOption | undefined {
  const options = def.identityProviders ?? [];
  return identityProvider ? options.find((p) => p.id === identityProvider) : options.find((p) => p.legacy);
}

// The OAuth backend for a given data source type (used by token refresh + callback).
export function oauthForType(type: string | null | undefined): OAuthProvider | undefined {
  const def = getIntegration(type);
  return def ? getOAuthProvider(def.oauthProviderId) : undefined;
}

// Client-safe view (no functions) for passing into client components.
export function descriptor(d: IntegrationDef): IntegrationDescriptor {
  return {
    id: d.id, name: d.name, description: d.description, icon: d.icon,
    // Surface the EFFECTIVE status so the UI shows "coming soon" for anything
    // not on the production allowlist, plus the connectable verdict so client
    // components don't have to re-derive it from status + connectPath.
    accent: d.accent, status: effectiveStatus(d), connectPath: d.connectPath, accountNoun: d.accountNoun,
    connectable: isConnectable(d),
  };
}

export type { IntegrationDef, IntegrationDescriptor, IntegrationAccount } from "./types";
