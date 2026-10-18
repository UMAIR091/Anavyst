// Instagram (professional accounts) backend, producing the platform-agnostic
// SocialReport shape from src/lib/integrations/social.ts. Two sign-in routes,
// chosen on the consent screen and stored as config.identity_provider:
//
// - "facebook" (the default, and every connection made before 17 Oct 2026):
//   Facebook Login on the Meta app, shared with Meta Ads. The user grants
//   their Facebook Pages, and each Page may have a linked
//   instagram_business_account. Calls go to graph.facebook.com.
// - "instagram": Business Login for Instagram. The user signs in to the
//   Instagram account itself, no Facebook Page needed. It has its own app id
//   and secret (App Dashboard → Instagram → API setup with Instagram login),
//   and calls go to graph.instagram.com.
//
// Both reach the same IG user node, so the insights code below is shared and
// only the host differs.
import type { OAuthProvider, IntegrationAccount } from "../types";
import { graphGet, metaDialogUrl, metaEnv, metaOAuth } from "./meta";
import {
  emptySocialTotals, engagementRate,
  type SocialDay, type SocialPost, type SocialProfile, type SocialReport, type SocialTotals,
} from "../social";

export const INSTAGRAM_PROVIDER = "instagram";
export const FACEBOOK_PROVIDER = "facebook";
const viaInstagram = (provider?: string) => provider === INSTAGRAM_PROVIDER;

// Facebook route: instagram_basic + instagram_manage_insights read the profile
// and metrics; pages_show_list + pages_read_engagement let us find the Pages
// (and their linked IG accounts) the user manages; business_management covers
// accounts owned through a Business Manager.
const SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

// Instagram route (developers.facebook.com/docs/instagram-platform, checked
// 17 Oct 2026).
const IG_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];
const IG_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN = "https://api.instagram.com/oauth/access_token";
const IG_HOST = "https://graph.instagram.com";
const IG_API_VERSION = process.env.INSTAGRAM_API_VERSION || "v25.0";
const SIXTY_DAYS = 60 * 24 * 60 * 60;

// The Instagram route needs its own app credentials; the redirect URI is the
// Meta one (/api/meta/callback), registered in the Instagram login settings too.
export function instagramLoginConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET && process.env.META_OAUTH_REDIRECT_URI);
}

type InstagramError = { error?: { message?: string }; error_message?: string };

// GET against graph.instagram.com, with its error envelope surfaced as a real
// error. Token endpoints are unversioned; everything else is versioned.
async function igGet<T = Record<string, unknown>>(
  path: string, params: Record<string, string>, versioned = true
): Promise<T> {
  const base = versioned ? `${IG_HOST}/${IG_API_VERSION}` : IG_HOST;
  const res = await fetch(`${base}${path}?${new URLSearchParams(params).toString()}`);
  const data = (await res.json().catch(() => ({}))) as InstagramError;
  if (!res.ok || data.error || data.error_message) {
    throw new Error(`Instagram API error: ${data.error?.message ?? data.error_message ?? res.statusText}`);
  }
  return data as T;
}

type Get = <T = Record<string, unknown>>(path: string, params: Record<string, string>) => Promise<T>;
const getterFor = (provider?: string): Get => (viaInstagram(provider) ? igGet : graphGet);

// authUrl only receives the state string, so the provider chosen on the
// consent screen is read back out of it (handleConnect builds it).
function providerFromState(state: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return typeof parsed.provider === "string" ? parsed.provider : undefined;
  } catch {
    return undefined;
  }
}

type LongLivedToken = { access_token: string; expires_in?: number };
const asTokenSet = (t: LongLivedToken) => ({
  access_token: t.access_token,
  // Like Meta's, Instagram's long-lived token is refreshed with itself.
  refresh_token: t.access_token,
  expires_in: t.expires_in || SIXTY_DAYS,
});

// Facebook route: identical to Meta Ads except for the scope set (same app,
// code exchange, long-lived token refresh and callback; type travels in state).
export const instagramOAuth: OAuthProvider = {
  id: "instagram",
  authUrl(state) {
    if (viaInstagram(providerFromState(state))) {
      const params = new URLSearchParams({
        client_id: metaEnv("INSTAGRAM_APP_ID"),
        redirect_uri: metaEnv("META_OAUTH_REDIRECT_URI"),
        response_type: "code",
        scope: IG_SCOPES.join(","),
        state,
        // Always ask which account to sign in to, instead of silently reusing
        // the Instagram session already in the browser.
        force_reauth: "true",
        // Facebook sign-in is its own button on the consent screen.
        enable_fb_login: "false",
      });
      return `${IG_AUTHORIZE}?${params.toString()}`;
    }
    // Facebook route: the "Anavyst Instagram reporting" Login for Business
    // configuration when set (never-expiring business token), else a plain
    // login with the scopes above. See metaDialogUrl.
    return metaDialogUrl(state, SCOPES, "instagram");
  },

  // Code → short-lived token (1 hour) → long-lived token (60 days).
  async exchangeCode(code, ctx) {
    if (!viaInstagram(ctx?.provider)) return metaOAuth.exchangeCode(code);
    const res = await fetch(IG_TOKEN, {
      method: "POST",
      body: new URLSearchParams({
        client_id: metaEnv("INSTAGRAM_APP_ID"),
        client_secret: metaEnv("INSTAGRAM_APP_SECRET"),
        grant_type: "authorization_code",
        redirect_uri: metaEnv("META_OAUTH_REDIRECT_URI"),
        code,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as InstagramError & {
      data?: { access_token?: string }[];
      access_token?: string;
    };
    // Documented as { data: [{ access_token, user_id, permissions }] };
    // earlier responses were the same fields unwrapped.
    const short = data.data?.[0]?.access_token ?? data.access_token;
    if (!res.ok || !short) {
      throw new Error(`Instagram API error: ${data.error_message ?? data.error?.message ?? res.statusText}`);
    }
    const long = await igGet<LongLivedToken>("/access_token", {
      grant_type: "ig_exchange_token",
      client_secret: metaEnv("INSTAGRAM_APP_SECRET"),
      access_token: short,
    }, false);
    return asTokenSet(long);
  },

  // Instagram route: extends a still-valid long-lived token by another 60 days
  // (it must be at least 24 hours old). Facebook route: see metaOAuth.refresh,
  // which can't extend.
  async refresh(token, ctx) {
    if (!viaInstagram(ctx?.provider)) return metaOAuth.refresh(token);
    const fresh = await igGet<LongLivedToken>("/refresh_access_token", {
      grant_type: "ig_refresh_token",
      access_token: token,
    }, false);
    return asTokenSet(fresh);
  },

  // Who signed in, for the connection's label and the success toast.
  async identity(accessToken, ctx) {
    if (!viaInstagram(ctx?.provider)) return metaOAuth.identity(accessToken);
    const me = await igGet<{ username?: string; name?: string }>("/me", { fields: "username,name", access_token: accessToken });
    return me.username ? `@${me.username}` : me.name || "Instagram account";
  },

  renewal: (ctx) => (viaInstagram(ctx?.provider) ? "extend" : "reconnect"),

  callbackPath: "/api/meta/callback",
};

// ── Account discovery ────────────────────────────────────────

type PageRow = {
  name?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
};

// The Instagram professional accounts this connection can report on. The id is
// the IG user id, which every insights call needs.
//
// Instagram route: exactly the account that signed in. /me's `id` is
// app-scoped; `user_id` is the professional account id the other endpoints take.
// Facebook route: every account linked to one of the user's Facebook Pages.
export async function listInstagramAccounts(accessToken: string, provider?: string): Promise<IntegrationAccount[]> {
  if (viaInstagram(provider)) {
    const me = await igGet<{ user_id?: string | number; username?: string; name?: string }>("/me", {
      fields: "user_id,username,name",
      access_token: accessToken,
    });
    if (!me.user_id) throw new Error("Instagram API error: the account id was missing from /me");
    return [{ id: String(me.user_id), name: me.username ? `@${me.username}` : me.name || String(me.user_id) }];
  }
  const data = await graphGet<{ data?: PageRow[] }>("/me/accounts", {
    fields: "name,instagram_business_account{id,username,name}",
    limit: "100",
    access_token: accessToken,
  });
  const out: IntegrationAccount[] = [];
  for (const page of data.data ?? []) {
    const ig = page.instagram_business_account;
    if (!ig?.id) continue;
    const handle = ig.username ? `@${ig.username}` : ig.name || ig.id;
    out.push({ id: ig.id, name: page.name ? `${handle} (${page.name})` : handle });
  }
  return out;
}

// ── Insights plumbing ────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
// Account insights accept at most ~30 days per request — chunk longer periods.
const WINDOW_MS = 28 * DAY_MS;

const unix = (ms: number) => String(Math.floor(ms / 1000));
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

// Structured error log for every tolerated failure — metrics vary by API
// version and account type, so partial data must never sink the whole sync.
function logIgError(context: string, err: unknown): void {
  console.error(`[instagram] ${context}: ${(err as Error).message ?? err}`);
}

type InsightValue = { value?: unknown; end_time?: string };
type InsightRow = { name?: string; values?: InsightValue[]; total_value?: { value?: unknown } };

// Daily time series for one metric (e.g. reach, follower_count), chunked into
// ≤28-day windows. Windows the API rejects (follower_count only covers the
// last 30 days) are logged and skipped.
async function igSeries(
  get: Get, accessToken: string, igUserId: string, metric: string, sinceMs: number, untilMs: number
): Promise<{ date: string; value: number }[]> {
  const out: { date: string; value: number }[] = [];
  for (let start = sinceMs; start < untilMs; start += WINDOW_MS) {
    const end = Math.min(start + WINDOW_MS, untilMs);
    try {
      const data = await get<{ data?: InsightRow[] }>(`/${igUserId}/insights`, {
        metric, period: "day", since: unix(start), until: unix(end), access_token: accessToken,
      });
      for (const v of data.data?.[0]?.values ?? []) {
        out.push({ date: (v.end_time ?? "").slice(0, 10), value: num(v.value) });
      }
    } catch (err) {
      logIgError(`series ${metric} ${unix(start)}–${unix(end)}`, err);
    }
  }
  return out;
}

// Period total for metrics that (on newer API versions) only support
// metric_type=total_value (views, profile_views, website_clicks).
async function igTotal(
  get: Get, accessToken: string, igUserId: string, metric: string, sinceMs: number, untilMs: number
): Promise<number> {
  let total = 0;
  for (let start = sinceMs; start < untilMs; start += WINDOW_MS) {
    const end = Math.min(start + WINDOW_MS, untilMs);
    try {
      const data = await get<{ data?: InsightRow[] }>(`/${igUserId}/insights`, {
        metric, period: "day", metric_type: "total_value",
        since: unix(start), until: unix(end), access_token: accessToken,
      });
      total += num(data.data?.[0]?.total_value?.value);
    } catch (err) {
      logIgError(`total ${metric} ${unix(start)}–${unix(end)}`, err);
    }
  }
  return total;
}

// ── Media ────────────────────────────────────────────────────

type IgMedia = {
  id: string;
  caption?: string;
  media_type?: string; // IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type?: string; // FEED | REELS
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
};

// Newest-first media, paginated back until we're past `sinceIso` (or a sane cap).
async function listMediaSince(get: Get, accessToken: string, igUserId: string, sinceIso: string): Promise<IgMedia[]> {
  const out: IgMedia[] = [];
  let after: string | undefined;
  for (let page = 0; page < 4; page++) {
    const data = await get<{ data?: IgMedia[]; paging?: { cursors?: { after?: string } } }>(
      `/${igUserId}/media`,
      {
        fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count",
        limit: "50",
        access_token: accessToken,
        ...(after ? { after } : {}),
      }
    );
    const rows = data.data ?? [];
    out.push(...rows);
    const oldest = rows[rows.length - 1]?.timestamp;
    after = data.paging?.cursors?.after;
    if (!after || rows.length === 0 || (oldest && oldest < sinceIso)) break;
  }
  return out;
}

// Saves + shares live on per-media insights, not the media node. Fetched for a
// bounded set of recent media; individual failures degrade to zeros.
async function mediaSavesShares(
  get: Get, accessToken: string, media: IgMedia[]
): Promise<Map<string, { saves: number; shares: number }>> {
  const out = new Map<string, { saves: number; shares: number }>();
  const targets = media.slice(0, 30);
  await Promise.all(
    targets.map(async (m) => {
      try {
        const data = await get<{ data?: InsightRow[] }>(`/${m.id}/insights`, {
          metric: "saved,shares", access_token: accessToken,
        });
        const byName: Record<string, number> = {};
        for (const row of data.data ?? []) {
          byName[row.name ?? ""] = num(row.values?.[0]?.value ?? row.total_value?.value);
        }
        out.set(m.id, { saves: byName.saved ?? 0, shares: byName.shares ?? 0 });
      } catch (err) {
        // Some media types/API versions reject "shares" — retry with saved only.
        try {
          const data = await get<{ data?: InsightRow[] }>(`/${m.id}/insights`, {
            metric: "saved", access_token: accessToken,
          });
          out.set(m.id, { saves: num(data.data?.[0]?.values?.[0]?.value), shares: 0 });
        } catch (err2) {
          logIgError(`media insights ${m.id}`, err2);
          out.set(m.id, { saves: 0, shares: 0 });
        }
      }
    })
  );
  return out;
}

// ── Report assembly ──────────────────────────────────────────

type IgProfile = {
  id: string; username?: string; name?: string; profile_picture_url?: string;
  website?: string; followers_count?: number; follows_count?: number; media_count?: number;
};

function isReel(m: IgMedia): boolean {
  return m.media_product_type === "REELS";
}

function mediaTotals(media: IgMedia[], extras: Map<string, { saves: number; shares: number }>) {
  let posts = 0, reels = 0, likes = 0, comments = 0, saves = 0, shares = 0;
  for (const m of media) {
    if (isReel(m)) reels++; else posts++;
    likes += num(m.like_count);
    comments += num(m.comments_count);
    const extra = extras.get(m.id);
    saves += extra?.saves ?? 0;
    shares += extra?.shares ?? 0;
  }
  return { posts, reels, likes, comments, saves, shares };
}

// Fetches the full Instagram report for one professional account and period,
// plus a best-effort prior-period comparison. Metric failures degrade to zeros
// (and are logged) rather than failing the sync.
export async function fetchInstagramReport(
  accessToken: string, igUserId: string, periodDays: number, provider?: string
): Promise<SocialReport> {
  const get = getterFor(provider);
  const now = Date.now();
  const sinceMs = now - periodDays * DAY_MS;
  const prevSinceMs = now - periodDays * 2 * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const prevSinceIso = new Date(prevSinceMs).toISOString();

  // Profile is the one call that must succeed — everything else degrades.
  // graph.instagram.com's user node has no `website` field, and asking for an
  // unknown field fails the whole call.
  const p = await get<IgProfile>(`/${igUserId}`, {
    fields: viaInstagram(provider)
      ? "id,username,name,profile_picture_url,followers_count,follows_count,media_count"
      : "id,username,name,profile_picture_url,website,followers_count,follows_count,media_count",
    access_token: accessToken,
  });
  const profile: SocialProfile = {
    id: p.id,
    username: p.username ?? "",
    name: p.name ?? p.username ?? "Instagram account",
    picture: p.profile_picture_url ?? null,
    website: p.website ?? null,
    followers: num(p.followers_count),
    following: num(p.follows_count),
    mediaCount: num(p.media_count),
  };

  const [
    reachSeries, followerSeries, views, profileViews, websiteClicks,
    prevReachSeries, prevViews, prevProfileViews, prevWebsiteClicks,
    media, activeStories,
  ] = await Promise.all([
    igSeries(get, accessToken, igUserId, "reach", sinceMs, now),
    igSeries(get, accessToken, igUserId, "follower_count", sinceMs, now),
    igTotal(get, accessToken, igUserId, "views", sinceMs, now),
    igTotal(get, accessToken, igUserId, "profile_views", sinceMs, now),
    igTotal(get, accessToken, igUserId, "website_clicks", sinceMs, now),
    igSeries(get, accessToken, igUserId, "reach", prevSinceMs, sinceMs),
    igTotal(get, accessToken, igUserId, "views", prevSinceMs, sinceMs),
    igTotal(get, accessToken, igUserId, "profile_views", prevSinceMs, sinceMs),
    igTotal(get, accessToken, igUserId, "website_clicks", prevSinceMs, sinceMs),
    listMediaSince(get, accessToken, igUserId, prevSinceIso).catch((err) => {
      logIgError("media list", err);
      return [] as IgMedia[];
    }),
    get<{ data?: { id: string }[] }>(`/${igUserId}/stories`, { fields: "id", limit: "100", access_token: accessToken })
      .then((d) => (d.data ?? []).length)
      .catch((err) => {
        logIgError("stories", err);
        return 0;
      }),
  ]);

  // Older API versions expose "impressions" instead of "views" — fall back.
  const impressions = views > 0 ? views : await igTotal(get, accessToken, igUserId, "impressions", sinceMs, now);

  const currentMedia = media.filter((m) => (m.timestamp ?? "") >= sinceIso);
  const prevMedia = media.filter((m) => (m.timestamp ?? "") >= prevSinceIso && (m.timestamp ?? "") < sinceIso);
  const extras = await mediaSavesShares(get, accessToken, currentMedia);

  const cur = mediaTotals(currentMedia, extras);
  const prev = mediaTotals(prevMedia, new Map());

  const followerGrowth = followerSeries.reduce((s, v) => s + v.value, 0);
  const reach = reachSeries.reduce((s, v) => s + v.value, 0);
  const prevReach = prevReachSeries.reduce((s, v) => s + v.value, 0);

  const engagements = cur.likes + cur.comments + cur.saves + cur.shares;
  const totals: SocialTotals = {
    followers: profile.followers,
    followerGrowth,
    reach,
    impressions,
    profileViews,
    websiteClicks,
    posts: cur.posts,
    reels: cur.reels,
    stories: activeStories,
    likes: cur.likes,
    comments: cur.comments,
    shares: cur.shares,
    saves: cur.saves,
    engagements,
    engagementRate: engagementRate(engagements, profile.followers),
  };

  const prevEngagements = prev.likes + prev.comments;
  const previousTotals: SocialTotals = {
    ...emptySocialTotals(),
    reach: prevReach,
    impressions: prevViews,
    profileViews: prevProfileViews,
    websiteClicks: prevWebsiteClicks,
    posts: prev.posts,
    reels: prev.reels,
    likes: prev.likes,
    comments: prev.comments,
    engagements: prevEngagements,
    engagementRate: engagementRate(prevEngagements, profile.followers),
  };

  // Merge the daily series on date (reach is the driver; follower joins in).
  const followerByDate = new Map(followerSeries.map((v) => [v.date, v.value]));
  const byDate: SocialDay[] = reachSeries.map((v) => ({
    date: v.date,
    reach: v.value,
    followerChange: followerByDate.get(v.date) ?? 0,
  }));

  const topPosts: SocialPost[] = [...currentMedia]
    .sort((a, b) => num(b.like_count) + num(b.comments_count) - (num(a.like_count) + num(a.comments_count)))
    .slice(0, 8)
    .map((m) => ({
      id: m.id,
      type: isReel(m) ? "reel" : "post",
      caption: (m.caption ?? "").slice(0, 120),
      permalink: m.permalink ?? null,
      timestamp: m.timestamp ?? "",
      likes: num(m.like_count),
      comments: num(m.comments_count),
      saves: extras.get(m.id)?.saves ?? 0,
      shares: extras.get(m.id)?.shares ?? 0,
    }));

  const notes: string[] = ["Stories reflect the last 24 hours (the Instagram API doesn't expose older stories)."];
  if (periodDays > 30) notes.push("Follower growth covers the most recent 30 days (Instagram API limit).");

  return { platform: "instagram", profile, totals, previousTotals, byDate, topPosts, notes };
}
