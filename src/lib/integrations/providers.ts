// Integration descriptors. Live providers carry the full server behavior;
// "soon" providers are one-liners — adding one for real means filling in
// listAccounts/fetchSnapshot (+ an OAuth backend if non-Google) and flipping
// status to "live". No route, sync, or UI code changes are required.
import {
  listGscSites, fetchGscReportWithComparison, listGa4Properties, fetchGa4ReportWithComparison,
} from "@/lib/google";
import {
  listMetaAdAccounts, fetchMetaAdsReport, metaConfigured, metaBusinessLoginConfigured, META_BUSINESS, META_PERSONAL,
} from "./oauth/meta";
import {
  listInstagramAccounts, fetchInstagramReport, instagramLoginConfigured, INSTAGRAM_PROVIDER, FACEBOOK_PROVIDER,
} from "./oauth/instagram";
import { listGoogleAdsAccounts, fetchGoogleAdsReport } from "./oauth/googleAds";
import { listGbpLocations, fetchGbpReport } from "./oauth/gbp";
import { fetchShopifyReport, shopifyConfigured } from "./oauth/shopify";
import { fetchWooReport } from "./oauth/woocommerce";
import { listMailchimpAudiences, fetchMailchimpReport, mailchimpConfigured } from "./oauth/mailchimp";
import { verifyKlaviyoKey, fetchKlaviyoReport } from "./oauth/klaviyo";
import { verifyCallRailKey, fetchCallRailReport } from "./oauth/callrail";
import { listMicrosoftAdsAccounts, fetchMicrosoftAdsReport, microsoftAdsConfigured } from "./oauth/microsoftAds";
import { verifyAhrefsKey, fetchAhrefsReport } from "./oauth/ahrefs";
import { verifySemrushKey, fetchSemrushReport } from "./oauth/semrush";
import { verifyMozKey, fetchMozReport } from "./oauth/moz";
import { listStripeAccounts, fetchStripeReport, stripeConfigured } from "./oauth/stripe";
import { listYoutubeChannels, fetchYoutubeReport } from "./oauth/youtube";
import { verifyBigQueryAccess, fetchBigQuerySnapshot } from "./oauth/bigquery";
import { resolveSpreadsheet, fetchSheetTable } from "./oauth/sheets";
import { listHubspotAccounts, fetchHubspotReport, hubspotConfigured } from "./oauth/hubspot";
import { listLinkedinAdAccounts, fetchLinkedinAdsReport, linkedinConfigured } from "./oauth/linkedin";
import { listTiktokAdvertisers, fetchTiktokAdsReport, tiktokConfigured } from "./oauth/tiktok";
import { listPinterestAdAccounts, fetchPinterestAdsReport, pinterestConfigured } from "./oauth/pinterest";
import { listSnapchatAdAccounts, fetchSnapchatAdsReport, snapchatConfigured } from "./oauth/snapchat";
import { listRedditAdAccounts, fetchRedditAdsReport, redditConfigured } from "./oauth/reddit";
import { listAmazonProfiles, fetchAmazonAdsReport, amazonConfigured } from "./oauth/amazon";
import { listXAdsAccounts, fetchXAdsReport, xAdsConfigured } from "./oauth/xads";
import { listAdobeReportSuites, fetchAdobeReport, adobeConfigured } from "./oauth/adobe";
import { listSalesforceOrgs, fetchSalesforceReport, salesforceConfigured } from "./oauth/salesforce";
import { verifyActiveCampaignKey, fetchActiveCampaignReport } from "./oauth/activecampaign";
import { listConstantContactAccounts, fetchConstantContactReport, constantContactConfigured } from "./oauth/constantcontact";
import { listCampaignMonitorClients, fetchCampaignMonitorReport, campaignMonitorConfigured } from "./oauth/campaignmonitor";
import type { IntegrationDef, IntegrationConfig, IntegrationAccount } from "./types";

// Providers that need their own app credentials stay "soon" until the env
// vars exist, so the UI never offers a Connect that would 500.
const gated = (configured: boolean) => (configured ? ("live" as const) : ("soon" as const));

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export const gscDef: IntegrationDef = {
  id: "gsc",
  name: "Google Search Console",
  description: "Clicks, impressions, queries & pages",
  icon: "Search",
  accent: "emerald",
  status: "live",
  oauthProviderId: "google",
  connectPath: "/api/google/connect",
  accountNoun: "property",
  accountConfigKey: "site_url",
  snapshotTable: "gsc_snapshots",
  dataAccess: [
    { item: "Search performance metrics (read-only)", why: "Clicks, impressions, CTR and average position power the SEO sections of your reports." },
    { item: "Top queries, pages, countries & devices", why: "Shows what your client ranks for and where their organic traffic comes from." },
    { item: "Your list of verified properties", why: "So you can pick which website this client's reports are built from." },
  ],
  listAccounts: async (at) => (await listGscSites(at)).map((s) => ({ id: s, name: s })),
  fetchSnapshot: (at, id, days) => fetchGscReportWithComparison(at, id, days),
  buildConfig: (accounts) => ({ sites: accounts.map((a) => a.id), site_url: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<string>(cfg.sites).map((s) => ({ id: s, name: s })),
  readSelected: (cfg) => (cfg.site_url as string | null) ?? null,
};

export const ga4Def: IntegrationDef = {
  id: "ga4",
  name: "Google Analytics 4",
  description: "Traffic, engagement & conversions",
  icon: "BarChart3",
  accent: "amber",
  status: "live",
  oauthProviderId: "google",
  connectPath: "/api/google/connect",
  accountNoun: "property",
  accountConfigKey: "property_id",
  snapshotTable: "ga4_snapshots",
  dataAccess: [
    { item: "Traffic & engagement metrics (read-only)", why: "Users, sessions, engagement and conversions power the website-performance sections of your reports." },
    { item: "Landing pages, channels, devices & countries", why: "Shows where visitors come from and which pages perform best." },
    { item: "Your list of GA4 properties", why: "So you can pick which property this client's reports are built from." },
  ],
  listAccounts: async (at) => (await listGa4Properties(at)).map((p) => ({ id: p.id, name: p.account ? `${p.name} · ${p.account}` : p.name })),
  fetchSnapshot: (at, id, days) => fetchGa4ReportWithComparison(at, id, days),
  buildConfig: (accounts) => ({ properties: accounts.map((a) => ({ id: a.id, name: a.name })), property_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>(cfg.properties),
  readSelected: (cfg) => (cfg.property_id as string | null) ?? null,
};

// Future sources — generic snapshot home, generic account config key. Google
// ones reuse the existing OAuth backend + callback; others get their own later.
function soon(
  id: string, name: string, description: string, icon: string, accent: string,
  oauthProviderId: string | null = null, connectPath: string | null = null
): IntegrationDef {
  return {
    id, name, description, icon, accent, status: "soon",
    oauthProviderId, connectPath,
    accountNoun: "account", accountConfigKey: "account_id", snapshotTable: "integration_snapshots",
    readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
    readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
  };
}

export const metaAdsDef: IntegrationDef = {
  id: "meta_ads",
  name: "Meta Ads",
  description: "Reach, spend, CPC & ROAS",
  icon: "Facebook",
  accent: "blue",
  status: gated(metaConfigured()),
  oauthProviderId: "meta",
  connectPath: "/api/meta/connect",
  // Business login first: the user picks the Business portfolio and ad
  // accounts to share, and the connection never expires. The personal login
  // stays next to it for ad accounts outside any portfolio, or anyone who
  // can't share from one. Connections made before 18 Oct 2026 are personal.
  identityProviders: [
    {
      id: META_BUSINESS,
      label: "Continue with Facebook",
      via: "Facebook (business)",
      note: "With Facebook, choose the Business portfolio that owns the client's ad account, then pick the ad account. This connection never expires.",
      enabled: () => metaBusinessLoginConfigured("ads"),
    },
    {
      id: META_PERSONAL,
      label: "Continue with Facebook",
      alternativeLabel: "Use a personal Facebook account instead",
      via: "personal Facebook",
      note: "Ad account not in a Business portfolio, or can't share it from there? Use a personal Facebook account instead. That sign-in lasts about 60 days, and you'll be reminded to reconnect before it ends.",
      legacy: true,
    },
  ],
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks, CPC, reach and conversions power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of ad accounts", why: "So you can pick which ad account this client's reports are built from." },
  ],
  listAccounts: (at) => listMetaAdAccounts(at),
  fetchSnapshot: (at, id, days) => fetchMetaAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// First social platform on the generic SocialReport shape (src/lib/integrations/
// social.ts). TikTok, LinkedIn, Pinterest, Facebook Pages etc. follow the same
// pattern: an OAuth backend + a fetcher that fills SocialReport, nothing else.
export const instagramDef: IntegrationDef = {
  id: "instagram",
  name: "Instagram",
  description: "Followers, reach, posts & engagement",
  icon: "Instagram",
  accent: "fuchsia",
  status: gated(metaConfigured()),
  oauthProviderId: "instagram",
  connectPath: "/api/meta/connect",
  // Three ways in. Instagram sign-in (Business Login for Instagram) logs in to
  // the account itself and needs no Facebook Page. The two Facebook sign-ins
  // reach accounts through the Facebook Page they're linked to: the business
  // one through a Business portfolio (never expires), the personal one under
  // whichever Facebook profile the browser is signed in to (~60 days).
  // Connections made before 17 Oct 2026 have no identity_provider and are
  // personal Facebook ones.
  identityProviders: [
    {
      id: INSTAGRAM_PROVIDER,
      label: "Continue with Instagram",
      note: "With Instagram, sign in to the client's Instagram business or creator account itself. No Facebook Page needed.",
      enabled: instagramLoginConfigured,
      // Business Login for Instagram is on Standard access until Meta approves
      // instagram_business_basic + instagram_business_manage_insights, so only
      // accounts with a role on the app can sign in. Remove once approved.
      adminsOnly: true,
    },
    {
      id: META_BUSINESS,
      label: "Continue with Facebook",
      via: "Facebook (business)",
      note: "With Facebook, choose the Business portfolio that owns the Facebook Page this Instagram account is linked to, then pick the Page and the Instagram account. This connection never expires.",
      enabled: () => metaBusinessLoginConfigured("instagram"),
    },
    {
      id: FACEBOOK_PROVIDER,
      label: "Continue with Facebook",
      alternativeLabel: "Use a personal Facebook account instead",
      via: "personal Facebook",
      note: "Page not in a Business portfolio? Use a personal Facebook account instead: sign in with the Facebook profile that manages the Page (if Facebook shows someone else's name, choose “Log in to another account”). That sign-in lasts about 60 days, and you'll be reminded to reconnect before it ends.",
      legacy: true,
    },
  ],
  accountNoun: "account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Profile & audience metrics (read-only)", why: "Followers, follower growth, reach, impressions, profile visits and website clicks power the social sections of your reports." },
    { item: "Posts, reels & story counts with engagement", why: "Likes, comments, shares and saves show which content performs for your client." },
    { item: "Your list of Instagram professional accounts", why: "So you can pick which account this client's reports are built from." },
  ],
  listAccounts: (at, ctx) => listInstagramAccounts(at, ctx?.provider),
  fetchSnapshot: (at, id, days, ctx) => fetchInstagramReport(at, id, days, ctx?.provider),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Normalized paid-media source on the shared AdsReport shape (metrics.ts) —
// LinkedIn Ads and TikTok Ads fill the same shape, and AdsAnalytics renders all.
export const googleAdsDef: IntegrationDef = {
  id: "google_ads",
  name: "Google Ads",
  description: "Spend, clicks, conversions & ROAS",
  icon: "Megaphone",
  accent: "sky",
  // Rides on the shared Google OAuth app like GSC/GA4: since developer tokens
  // were sunset, nothing Ads-specific needs configuring.
  status: "live",
  oauthProviderId: "google_ads",
  connectPath: "/api/google/connect",
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks, CPC, conversions and conversion value power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of Google Ads accounts", why: "So you can pick which ad account this client's reports are built from." },
  ],
  listAccounts: (at) => listGoogleAdsAccounts(at),
  fetchSnapshot: (at, id, days) => fetchGoogleAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Local-presence metrics. Uses the shared Google OAuth app; the Google Cloud
// project needs the three Business Profile APIs enabled (access is approval-
// gated by Google — see .env.example notes).
export const gbpDef: IntegrationDef = {
  id: "gbp",
  name: "Google Business Profile",
  description: "Profile views, calls, directions & clicks",
  icon: "MapPin",
  accent: "rose",
  status: "live",
  oauthProviderId: "gbp",
  connectPath: "/api/google/connect",
  accountNoun: "location",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Business Profile performance metrics (read-only)", why: "Profile impressions, website clicks, calls, direction requests and bookings power the local-presence sections of your reports." },
    { item: "Your list of business locations", why: "So you can pick which location this client's reports are built from." },
  ],
  listAccounts: (at) => listGbpLocations(at),
  fetchSnapshot: (at, id, days) => fetchGbpReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Commerce source on the normalized CommerceReport shape. Shopify's OAuth is
// per-shop, so it uses dedicated connect/callback routes and a consent-screen
// input (connectField) for the store domain; the account IS the shop.
export const shopifyDef: IntegrationDef = {
  id: "shopify",
  name: "Shopify",
  description: "Orders, revenue & top products",
  icon: "ShoppingBag",
  accent: "emerald",
  status: gated(shopifyConfigured()),
  oauthProviderId: "shopify",
  connectPath: "/api/shopify/connect",
  accountNoun: "store",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Orders & sales metrics (read-only)", why: "Order counts, revenue and average order value power the e-commerce sections of your reports." },
    { item: "Product line items", why: "Shows which products drive revenue in the client's report." },
  ],
  connectField: {
    name: "shop",
    label: "Store domain",
    placeholder: "your-store.myshopify.com",
    hint: "The store's .myshopify.com domain (the store owner approves access on Shopify).",
  },
  // The account is the shop itself — set at connect time by the callback.
  listAccounts: async () => [],
  fetchSnapshot: (at, shop, days) => fetchShopifyReport(at, shop, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Second commerce source on the normalized CommerceReport shape. WooCommerce's
// per-store authorization (/wc-auth) uses dedicated connect/callback/return
// routes and a consent-screen input (connectField) for the store URL; no
// app-level credentials are needed, so it's always live. The account IS the store.
export const woocommerceDef: IntegrationDef = {
  id: "woocommerce",
  name: "WooCommerce",
  description: "Orders, revenue & top products",
  icon: "ShoppingCart",
  accent: "fuchsia",
  status: "live",
  oauthProviderId: "woocommerce",
  connectPath: "/api/woocommerce/connect",
  accountNoun: "store",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Orders & sales metrics (read-only)", why: "Order counts, revenue and average order value power the e-commerce sections of your reports." },
    { item: "Product line items", why: "Shows which products drive revenue in the client's report." },
  ],
  connectField: {
    name: "store",
    label: "Store URL",
    placeholder: "https://your-store.com",
    hint: "Your WooCommerce store's web address. You approve read-only access on your own store admin.",
  },
  // The account is the store itself — set at connect time by the callback.
  listAccounts: async () => [],
  fetchSnapshot: (at, storeUrl, days) => fetchWooReport(at, storeUrl, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Custom tabular data. The snapshot is the first worksheet as a bounded
// table — shown on the dashboard and embeddable in reports.
export const sheetsDef: IntegrationDef = {
  id: "sheets",
  name: "Google Sheets",
  description: "Custom data from your spreadsheets",
  icon: "FileSpreadsheet",
  accent: "emerald",
  status: "live",
  oauthProviderId: "sheets",
  connectPath: "/api/google/connect",
  accountNoun: "spreadsheet",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Only the spreadsheet you paste (read-only)", why: "Its first worksheet is embedded as a data table in this client's dashboard and reports." },
    { item: "Nothing else in your Google Drive", why: "Anavyst asks for no Drive access, so no other file is readable." },
  ],
  // Named by its link rather than picked from a Drive listing: that is what
  // keeps Sheets off Google's restricted Drive scopes, which would otherwise
  // require an annual third-party security assessment.
  connectField: {
    name: "sheet",
    label: "Google Sheet link",
    placeholder: "https://docs.google.com/spreadsheets/d/...",
    hint: "Open the sheet and copy the link from your browser. The Google account you connect with must be able to open it.",
  },
  listAccounts: (at, ctx) => resolveSpreadsheet(at, ctx?.connectValue ?? ""),
  fetchSnapshot: (at, id) => fetchSheetTable(at, id),
  buildConfig: (accounts) => ({ accounts: accounts.slice(0, 100), account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// First email-marketing source on the normalized EmailReport shape (metrics.ts).
// Klaviyo fills the same shape and EmailAnalytics renders both. Standard OAuth,
// so it uses the generic connect/callback routes; a connection is one audience.
export const mailchimpDef: IntegrationDef = {
  id: "mailchimp",
  name: "Mailchimp",
  description: "Audience growth, opens & clicks",
  icon: "Mail",
  accent: "amber",
  status: gated(mailchimpConfigured()),
  oauthProviderId: "mailchimp",
  connectPath: "/api/mailchimp/connect",
  accountNoun: "audience",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Audience & campaign metrics (read-only)", why: "Subscribers, growth, opens, clicks and unsubscribes power the email-marketing sections of your reports." },
    { item: "Sent campaigns with performance", why: "Shows which campaigns landed best for your client." },
    { item: "Your list of audiences", why: "So you can pick which audience this client's reports are built from." },
  ],
  listAccounts: (at) => listMailchimpAudiences(at),
  fetchSnapshot: (at, id, days) => fetchMailchimpReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Second email-marketing source on the shared EmailReport shape. Klaviyo uses a
// private API key (no OAuth app), so it connects via the generic api-key flow.
export const klaviyoDef: IntegrationDef = {
  id: "klaviyo",
  name: "Klaviyo",
  description: "Email opens, clicks & list growth",
  icon: "Send",
  accent: "sky",
  status: "live",
  authKind: "apikey",
  oauthProviderId: null,
  connectPath: null,
  accountNoun: "account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Email metrics (read-only)", why: "Emails sent, opens, clicks, subscriber growth and unsubscribes power the email-marketing sections of your reports." },
    { item: "Recent email campaigns", why: "Shows which campaigns your client sent in the period." },
  ],
  connectFields: [
    { name: "apiKey", label: "Private API key", placeholder: "pk_xxxxxxxx", secret: true,
      hint: "Klaviyo → Settings → API keys → create a read-only Private API Key." },
  ],
  verifyApiKey: (fields) => verifyKlaviyoKey(fields),
  fetchSnapshot: (at, id, days) => fetchKlaviyoReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Call-tracking source on the normalized CallReport shape. Uses an API key, so
// it connects via the generic api-key flow; a connection maps to one account.
export const callrailDef: IntegrationDef = {
  id: "callrail",
  name: "CallRail",
  description: "Calls, first-time leads & sources",
  icon: "PhoneCall",
  accent: "cyan",
  status: "live",
  authKind: "apikey",
  oauthProviderId: null,
  connectPath: null,
  accountNoun: "account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Call activity (read-only)", why: "Call volume, first-time callers (leads), answer rate and duration power the call-tracking sections of your reports." },
    { item: "Call sources", why: "Shows which channels drive phone leads for your client." },
  ],
  connectFields: [
    { name: "apiKey", label: "API key", placeholder: "your CallRail API key", secret: true,
      hint: "CallRail → Account settings → Integrations → API keys → create an API key." },
  ],
  verifyApiKey: (fields) => verifyCallRailKey(fields),
  fetchSnapshot: (at, id, days) => fetchCallRailReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// First SEO source on the normalized SeoReport shape. Ahrefs uses an API key +
// a target domain, so it connects via the generic api-key flow.
export const ahrefsDef: IntegrationDef = {
  id: "ahrefs",
  name: "Ahrefs",
  description: "Domain rating, backlinks & keywords",
  icon: "TrendingUp",
  accent: "sky",
  status: "live",
  authKind: "apikey",
  oauthProviderId: null,
  connectPath: null,
  accountNoun: "domain",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Organic search & backlink metrics (read-only)", why: "Domain Rating, organic keywords, organic traffic, backlinks and referring domains power the SEO sections of your reports." },
    { item: "Top organic keywords", why: "Shows which keywords drive your client's organic traffic." },
  ],
  connectFields: [
    { name: "apiKey", label: "API key", placeholder: "your Ahrefs API key", secret: true,
      hint: "Ahrefs → Account settings → API (requires an API-enabled plan)." },
    { name: "domain", label: "Domain", placeholder: "example.com", hint: "The website to report on." },
  ],
  verifyApiKey: (fields) => verifyAhrefsKey(fields),
  fetchSnapshot: (at, id, days) => fetchAhrefsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Second SEO source on the shared SeoReport shape. Semrush also uses an API key
// + a target domain via the generic api-key flow.
export const semrushDef: IntegrationDef = {
  id: "semrush",
  name: "Semrush",
  description: "Organic keywords, traffic & backlinks",
  icon: "Search",
  accent: "rose",
  status: "live",
  authKind: "apikey",
  oauthProviderId: null,
  connectPath: null,
  accountNoun: "domain",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Organic search & backlink metrics (read-only)", why: "Organic keywords, organic traffic, authority score, backlinks and referring domains power the SEO sections of your reports." },
    { item: "Top organic keywords", why: "Shows which keywords drive your client's organic traffic." },
  ],
  connectFields: [
    { name: "apiKey", label: "API key", placeholder: "your Semrush API key", secret: true,
      hint: "Semrush → Subscription info → API units → API key." },
    { name: "domain", label: "Domain", placeholder: "example.com", hint: "The website to report on." },
  ],
  verifyApiKey: (fields) => verifySemrushKey(fields),
  fetchSnapshot: (at, id, days) => fetchSemrushReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Third SEO source on the shared SeoReport shape. Moz authenticates with the
// official Moz Links API v2 Access ID + Secret Key (HTTP Basic), collected via
// the generic api-key flow; a connection maps to one target domain. The Links
// API provides Domain Authority, backlinks and referring domains — not organic
// traffic/keywords (a separate Moz product) — so those SeoTotals stay 0.
export const mozDef: IntegrationDef = {
  id: "moz",
  name: "Moz",
  description: "Domain Authority, backlinks & referring domains",
  icon: "Gauge",
  accent: "emerald",
  status: "live",
  authKind: "apikey",
  oauthProviderId: null,
  connectPath: null,
  accountNoun: "domain",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Link & authority metrics (read-only)", why: "Domain Authority, backlinks and referring domains power the SEO sections of your reports." },
  ],
  connectFields: [
    { name: "accessId", label: "Access ID", placeholder: "mozscape-xxxxxxxxxx", secret: true,
      hint: "Moz → API → Links API → your Access ID." },
    { name: "secretKey", label: "Secret Key", placeholder: "your Moz Secret Key", secret: true,
      hint: "Moz → API → Links API → your Secret Key (shown once when generated)." },
    { name: "domain", label: "Domain", placeholder: "example.com", hint: "The website to report on." },
  ],
  verifyApiKey: (fields) => verifyMozKey(fields),
  fetchSnapshot: (at, id, days) => fetchMozReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Third commerce source on the shared CommerceReport shape. Stripe uses Connect
// OAuth (read-only) so agencies connect a client's account without keys.
export const stripeDef: IntegrationDef = {
  id: "stripe",
  name: "Stripe",
  description: "Payments, revenue & customers",
  icon: "CreditCard",
  accent: "blue",
  status: gated(stripeConfigured()),
  oauthProviderId: "stripe",
  connectPath: "/api/stripe/connect",
  accountNoun: "account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Payments & revenue (read-only)", why: "Successful charge counts, net revenue and average order value power the payments sections of your reports." },
    { item: "Customer counts", why: "Shows how many distinct customers paid in the period." },
  ],
  listAccounts: (at) => listStripeAccounts(at),
  fetchSnapshot: (at, id, days) => fetchStripeReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Video source on the normalized VideoReport shape. Reuses the shared Google
// OAuth app (youtube scopes), so it uses the existing /api/google connect flow.
export const youtubeAnalyticsDef: IntegrationDef = {
  id: "youtube_analytics",
  name: "YouTube Analytics",
  description: "Views, watch time & subscribers",
  icon: "Youtube",
  accent: "rose",
  status: "live",
  oauthProviderId: "youtube_analytics",
  connectPath: "/api/google/connect",
  accountNoun: "channel",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Channel metrics (read-only)", why: "Views, watch time, subscriber growth, likes and comments power the video sections of your reports." },
    { item: "Your list of channels", why: "So you can pick which channel this client's reports are built from." },
  ],
  listAccounts: (at) => listYoutubeChannels(at),
  fetchSnapshot: (at, id, days) => fetchYoutubeReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Data-warehouse source. Reuses the shared Google OAuth app (bigquery scope).
// The snapshot is a bounded overview of the project's datasets/tables as a
// SheetTable (reusing SheetsAnalytics), so warehouse contents show on the
// dashboard and embed in reports without force-fitting them into ad metrics.
export const bigqueryDef: IntegrationDef = {
  id: "bigquery",
  name: "Google BigQuery",
  description: "Datasets & tables from your warehouse",
  icon: "Database",
  accent: "sky",
  status: "live",
  oauthProviderId: "bigquery",
  connectPath: "/api/google/connect",
  accountNoun: "project",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Read-only warehouse access", why: "Datasets, tables, schema, row counts and a bounded read-only preview of the selected table are shown in this client's dashboard and reports. No data is ever modified." },
    { item: "Your list of BigQuery projects", why: "So you can pick which project, dataset and table this client's data comes from." },
  ],
  // Validate at connect time: confirms BigQuery is reachable and the account has
  // at least one accessible project, with provider-specific errors on failure.
  listAccounts: (at) => verifyBigQueryAccess(at),
  fetchSnapshot: (at, id, _days, _ctx, cfg) => fetchBigQuerySnapshot(at, id, cfg),
  buildConfig: (accounts) => ({
    accounts: accounts.slice(0, 100),
    account_id: accounts.length === 1 ? accounts[0].id : null,
    dataset_id: null,
    table_id: null,
  }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// CRM source on the normalized CrmReport shape (leads, deals, won revenue).
export const hubspotDef: IntegrationDef = {
  id: "hubspot",
  name: "HubSpot",
  description: "Leads, deals & won revenue",
  icon: "Magnet",
  accent: "amber",
  status: gated(hubspotConfigured()),
  oauthProviderId: "hubspot",
  connectPath: "/api/hubspot/connect",
  accountNoun: "portal",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Contacts & deals activity (read-only)", why: "New leads, deals created and closed-won revenue power the pipeline sections of your reports." },
    { item: "Your HubSpot account id", why: "So the connection is tied to the right portal." },
  ],
  listAccounts: (at) => listHubspotAccounts(at),
  fetchSnapshot: (at, id, days) => fetchHubspotReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Second paid-media source on the shared AdsReport shape. Requires a LinkedIn
// app approved for the Marketing Developer Platform (see .env.example).
export const linkedinAdsDef: IntegrationDef = {
  id: "linkedin_ads",
  name: "LinkedIn Ads",
  description: "B2B spend, clicks & conversions",
  icon: "Linkedin",
  accent: "sky",
  status: gated(linkedinConfigured()),
  oauthProviderId: "linkedin",
  connectPath: "/api/linkedin/connect",
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks and conversions power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of LinkedIn ad accounts", why: "So you can pick which ad account this client's reports are built from." },
  ],
  listAccounts: (at) => listLinkedinAdAccounts(at),
  fetchSnapshot: (at, id, days) => fetchLinkedinAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Third paid-media source on the shared AdsReport shape.
export const tiktokAdsDef: IntegrationDef = {
  id: "tiktok_ads",
  name: "TikTok Ads",
  description: "Spend, views, clicks & conversions",
  icon: "Music",
  accent: "fuchsia",
  status: gated(tiktokConfigured()),
  oauthProviderId: "tiktok",
  connectPath: "/api/tiktok/connect",
  accountNoun: "advertiser account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks and conversions power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of advertiser accounts", why: "So you can pick which advertiser account this client's reports are built from." },
  ],
  listAccounts: (at) => listTiktokAdvertisers(at),
  fetchSnapshot: (at, id, days) => fetchTiktokAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Paid-media source on the shared AdsReport shape. Pinterest REST API v5 with
// standard OAuth 2.0 (refreshable tokens), reusing the generic connect flow.
export const pinterestAdsDef: IntegrationDef = {
  id: "pinterest_ads",
  name: "Pinterest Ads",
  description: "Spend, impressions, clicks & conversions",
  icon: "Megaphone",
  accent: "rose",
  // Launched: the connector is complete and the Pinterest app (1591007) now has
  // its redirect URI registered, so the OAuth flow completes end to end. Still
  // subject to the LIVE_INTEGRATIONS allowlist, which is what keeps an
  // environment without Pinterest credentials from advertising it.
  status: gated(pinterestConfigured()),
  oauthProviderId: "pinterest",
  connectPath: "/api/pinterest/connect",
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks and conversions power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of ad accounts", why: "So you can pick which Pinterest ad account this client's reports are built from." },
  ],
  listAccounts: (at) => listPinterestAdAccounts(at),
  fetchSnapshot: (at, id, days) => fetchPinterestAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Paid-media source on the shared AdsReport shape. Snapchat Marketing API v1 with
// OAuth 2.0 short-lived tokens (refreshed on nearly every sync). "Swipes" are
// Snapchat's clicks; spend arrives in micro-currency and is normalized here.
export const snapchatAdsDef: IntegrationDef = {
  id: "snapchat_ads",
  name: "Snapchat Ads",
  description: "Spend, impressions, swipes & conversions",
  icon: "Ghost",
  accent: "amber",
  status: gated(snapchatConfigured()),
  oauthProviderId: "snapchat",
  connectPath: "/api/snapchat/connect",
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, swipes and conversions power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of ad accounts", why: "So you can pick which Snapchat ad account this client's reports are built from." },
  ],
  listAccounts: (at) => listSnapchatAdAccounts(at),
  fetchSnapshot: (at, id, days) => fetchSnapchatAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Paid-media source on the shared AdsReport shape. Reddit Ads API v3 with
// Reddit's standard OAuth 2.0 (refreshable via duration=permanent).
export const redditAdsDef: IntegrationDef = {
  id: "reddit_ads",
  name: "Reddit Ads",
  description: "Spend, impressions, clicks & conversions",
  icon: "Megaphone",
  accent: "rose",
  status: gated(redditConfigured()),
  oauthProviderId: "reddit",
  connectPath: "/api/reddit/connect",
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks and conversions power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of ad accounts", why: "So you can pick which Reddit ad account this client's reports are built from." },
  ],
  listAccounts: (at) => listRedditAdAccounts(at),
  fetchSnapshot: (at, id, days) => fetchRedditAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Paid-media source on the shared AdsReport shape. Amazon Advertising API v3 with
// Login with Amazon OAuth (region-specific) and async Sponsored Products
// reporting (create → poll → download), surfaced through the same contract.
export const amazonAdsDef: IntegrationDef = {
  id: "amazon_ads",
  name: "Amazon Ads",
  description: "Spend, clicks, purchases & sales",
  icon: "ShoppingBag",
  accent: "amber",
  status: gated(amazonConfigured()),
  oauthProviderId: "amazon",
  connectPath: "/api/amazon/connect",
  accountNoun: "profile",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks, purchases and sales power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which Sponsored Products campaigns drive results in the client's report." },
    { item: "Your list of advertising profiles", why: "So you can pick which Amazon Ads profile this client's reports are built from." },
  ],
  listAccounts: (at) => listAmazonProfiles(at),
  fetchSnapshot: (at, id, days) => fetchAmazonAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Paid-media source on the shared AdsReport shape. X's Ads API uses OAuth 1.0a,
// which doesn't fit the shared OAuthProvider contract — so oauthProviderId stays
// null and connectPath points at dedicated /api/x/* routes that run the 1.0a
// dance. Everything downstream (storage, sync, dashboard, disconnect) is shared.
export const xAdsDef: IntegrationDef = {
  id: "x_ads",
  name: "X Ads",
  description: "Spend, impressions & engagements",
  icon: "Twitter",
  accent: "ink",
  status: gated(xAdsConfigured()),
  oauthProviderId: null,
  connectPath: "/api/x/connect",
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions and clicks power the paid-media sections of your reports." },
    { item: "Campaign-level results", why: "Shows which campaigns drive results in the client's report." },
    { item: "Your list of ad accounts", why: "So you can pick which X ad account this client's reports are built from." },
  ],
  listAccounts: (at) => listXAdsAccounts(at),
  fetchSnapshot: (at, id, days) => fetchXAdsReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Web analytics source. Adobe Analytics 2.0 API via Adobe IMS OAuth. An account
// is a "<globalCompanyId>:<rsid>" report suite; metrics normalize onto the same
// Ga4ReportData shape GA4 fills, so it reuses Ga4Analytics.
export const adobeAnalyticsDef: IntegrationDef = {
  id: "adobe_analytics",
  name: "Adobe Analytics",
  description: "Visitors, visits, page views & revenue",
  icon: "BarChart3",
  accent: "rose",
  status: gated(adobeConfigured()),
  oauthProviderId: "adobe",
  connectPath: "/api/adobe/connect",
  accountNoun: "report suite",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Analytics metrics (read-only)", why: "Visitors, visits, page views, bounce rate, orders and revenue power the web-analytics sections of your reports." },
    { item: "Top pages, sources, countries & devices", why: "Shows where your client's traffic comes from and what it engages with." },
    { item: "Your list of report suites", why: "So you can pick which report suite this client's reports are built from." },
  ],
  listAccounts: (at) => listAdobeReportSuites(at),
  fetchSnapshot: (at, id, days) => fetchAdobeReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Second CRM source on the shared CrmReport shape (the same one HubSpot fills,
// so it reuses CrmAnalytics). Salesforce is per-org: the connection's instance_url
// is packed into the stored token, so a connection maps to exactly one org.
export const salesforceDef: IntegrationDef = {
  id: "salesforce",
  name: "Salesforce",
  description: "Leads, opportunities & won revenue",
  icon: "Magnet",
  accent: "sky",
  status: gated(salesforceConfigured()),
  oauthProviderId: "salesforce",
  connectPath: "/api/salesforce/connect",
  accountNoun: "org",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Leads & opportunities (read-only)", why: "New leads, new and won opportunities and won revenue power the CRM sections of your reports." },
    { item: "Top opportunities", why: "Shows the biggest deals in the period in the client's report." },
  ],
  listAccounts: (at) => listSalesforceOrgs(at),
  fetchSnapshot: (at, id, days) => fetchSalesforceReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Email-marketing source on the shared EmailReport shape (the same one Mailchimp
// and Klaviyo fill, so it reuses EmailAnalytics). ActiveCampaign has no public
// OAuth — an account-specific API URL + token, collected via the api-key flow.
export const activecampaignDef: IntegrationDef = {
  id: "activecampaign",
  name: "ActiveCampaign",
  description: "Campaigns, opens, clicks & contacts",
  icon: "Send",
  accent: "blue",
  status: "live",
  authKind: "apikey",
  oauthProviderId: null,
  connectPath: null,
  accountNoun: "account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Email metrics (read-only)", why: "Emails sent, opens, clicks, contact growth and unsubscribes power the email-marketing sections of your reports." },
    { item: "Recent campaigns", why: "Shows which campaigns your client sent in the period." },
  ],
  connectFields: [
    { name: "apiUrl", label: "API URL", placeholder: "https://youraccount.api-us1.com",
      hint: "ActiveCampaign → Settings → Developer → API Access → URL." },
    { name: "apiKey", label: "API key", placeholder: "your ActiveCampaign API key", secret: true,
      hint: "ActiveCampaign → Settings → Developer → API Access → Key." },
  ],
  verifyApiKey: (fields) => verifyActiveCampaignKey(fields),
  fetchSnapshot: (at, id, days) => fetchActiveCampaignReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts[0]?.id ?? null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Email-marketing source on the shared EmailReport shape (reuses EmailAnalytics).
// Constant Contact v3 with OAuth 2.0; offline_access provides the refresh token.
export const constantContactDef: IntegrationDef = {
  id: "constantcontact",
  name: "Constant Contact",
  description: "Campaigns, opens, clicks & contacts",
  icon: "Send",
  accent: "amber",
  status: gated(constantContactConfigured()),
  oauthProviderId: "constantcontact",
  connectPath: "/api/constantcontact/connect",
  accountNoun: "account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Email metrics (read-only)", why: "Emails sent, opens, clicks, contact growth and unsubscribes power the email-marketing sections of your reports." },
    { item: "Recent campaigns", why: "Shows which campaigns your client sent in the period." },
  ],
  listAccounts: (at) => listConstantContactAccounts(at),
  fetchSnapshot: (at, id, days) => fetchConstantContactReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Email-marketing source on the shared EmailReport shape (reuses EmailAnalytics).
// Campaign Monitor nests clients under an account, so an "account" here is a
// Campaign Monitor client — the granularity an agency reports on.
export const campaignMonitorDef: IntegrationDef = {
  id: "campaignmonitor",
  name: "Campaign Monitor",
  description: "Campaigns, opens, clicks & subscribers",
  icon: "Send",
  accent: "cyan",
  status: gated(campaignMonitorConfigured()),
  oauthProviderId: "campaignmonitor",
  connectPath: "/api/campaignmonitor/connect",
  accountNoun: "client",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Email metrics (read-only)", why: "Emails sent, opens, clicks, subscribers and unsubscribes power the email-marketing sections of your reports." },
    { item: "Recent campaigns", why: "Shows which campaigns your client sent in the period." },
    { item: "Your list of Campaign Monitor clients", why: "So you can pick which client this report is built from." },
  ],
  listAccounts: (at) => listCampaignMonitorClients(at),
  fetchSnapshot: (at, id, days) => fetchCampaignMonitorReport(at, id, days),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Fourth paid-media source on the shared AdsReport shape. Microsoft's API is
// SOAP with asynchronous reporting; the backend hides that behind the same
// listAccounts/fetchSnapshot contract every other ad platform uses.
export const microsoftAdsDef: IntegrationDef = {
  id: "microsoft_ads",
  name: "Microsoft Ads",
  description: "Bing search spend, clicks & conversions",
  icon: "Search",
  accent: "cyan",
  status: gated(microsoftAdsConfigured()),
  oauthProviderId: "microsoft",
  connectPath: "/api/microsoft/connect",
  // Microsoft Advertising accounts sign in with either a Microsoft identity
  // (personal MSA or work/school) or a Google account. Both are valid; the user
  // picks whichever they use, and each routes to the matching OAuth provider.
  identityProviders: [
    { id: "microsoft", label: "Continue with Microsoft" },
    { id: "google", label: "Continue with Google" },
  ],
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  snapshotTable: "integration_snapshots",
  dataAccess: [
    { item: "Ad performance metrics (read-only)", why: "Spend, impressions, clicks, conversions and revenue power the paid-media sections of your reports." },
    { item: "Your list of ad accounts", why: "So you can pick which ad account this client's reports are built from." },
  ],
  // ctx.provider is the stored identity_provider (microsoft | google); the
  // backend uses it to add the IdentityProvider header for Google connections.
  listAccounts: (at, ctx) => listMicrosoftAdsAccounts(at, ctx?.provider),
  fetchSnapshot: (at, id, days, ctx) => fetchMicrosoftAdsReport(at, id, days, ctx?.provider),
  buildConfig: (accounts) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg) => arr<IntegrationAccount>((cfg as IntegrationConfig).accounts),
  readSelected: (cfg) => ((cfg as IntegrationConfig).account_id as string | null) ?? null,
};

// Placeholders for platforms nothing is built for yet. "YouTube" and
// "X (Twitter)" used to live here and were removed once youtubeAnalyticsDef and
// xAdsDef shipped: keeping them listed a second, unconnectable copy of a
// platform the app already supports.
export const soonDefs: IntegrationDef[] = [];
