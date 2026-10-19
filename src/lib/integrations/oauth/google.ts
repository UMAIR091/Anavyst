// Google OAuth backend — shared by every Google data source. Each product
// family gets a scope-specific variant (same app, same callback, same token
// machinery — only the consent scopes differ), mirroring how instagramOAuth
// varies metaOAuth. Wraps the pure helpers in lib/google.ts so the redirect
// URI stays in one place.
import { getAuthUrl, exchangeCode, refreshAccessToken, getGoogleEmail, getGoogleSubject, revokeGoogleToken } from "@/lib/google";
import type { OAuthProvider } from "../types";

// openid+email are always included so identity() can label the connection.
function googleVariant(id: string, extraScopes: string[]): OAuthProvider {
  const scopes = ["openid", "email", ...extraScopes];
  return {
    id,
    authUrl: (state) => getAuthUrl(state, scopes),
    exchangeCode: (code) => exchangeCode(code),
    refresh: (refreshToken) => refreshAccessToken(refreshToken),
    identity: (accessToken) => getGoogleEmail(accessToken),
    subject: (accessToken) => getGoogleSubject(accessToken),
    // Revoke the whole grant via the refresh token when present (falls back to
    // the access token). Best-effort — disconnect proceeds even if this fails.
    revoke: ({ accessToken, refreshToken }) => {
      const token = refreshToken ?? accessToken;
      return token ? revokeGoogleToken(token) : Promise.resolve();
    },
    // Every Google variant runs on the same OAuth client, so all connections
    // made by one Google account share a single grant — and revoking is
    // grant-wide. The account email is what identity() stored as display_name.
    grantKey: ({ display_name }) => (display_name ? `google:${display_name}` : null),
    // Registered in Google Cloud Console — do not change without updating it there.
    callbackPath: "/api/google/callback",
  };
}

export const googleOAuth: OAuthProvider = {
  ...googleVariant("google", [
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/analytics.readonly",
  ]),
  // Keep the historical default (uses lib/google.ts SCOPES) for GSC + GA4.
  authUrl: (state) => getAuthUrl(state),
};

export const googleAdsOAuth = googleVariant("google_ads", ["https://www.googleapis.com/auth/adwords"]);
export const youtubeOAuth = googleVariant("youtube_analytics", [
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
]);
export const bigqueryOAuth = googleVariant("bigquery", ["https://www.googleapis.com/auth/bigquery.readonly"]);
export const gbpOAuth = googleVariant("gbp", ["https://www.googleapis.com/auth/business.manage"]);
// Sheets deliberately asks for NO Drive scope. Listing a user's spreadsheets
// needs drive.metadata.readonly, which Google classes as restricted and only
// approves after an annual third-party security assessment. The agency pastes
// the sheet's link instead (IntegrationDef.connectField), and spreadsheets.
// readonly — merely sensitive — reads that one sheet.
export const sheetsOAuth = googleVariant("sheets", ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
