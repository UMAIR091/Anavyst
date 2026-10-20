// Cancelling a saved sign-in's access at the platform, when it is removed
// from Anavyst. Only where the platform has an official revoke API
// (OAuthProvider.revoke: Google and Meta today); elsewhere the person removes
// Anavyst in their own account (registry accessSettingsFor), and the UI says
// so. Best-effort: a platform that's down never traps the user's data here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { oauthForType } from "./registry";
import type { GrantOwner } from "./types";

export type RevokeOutcome = "revoked" | "not_supported" | "shared_grant" | "failed";

// Google issues ONE grant per (OAuth client, Google account), holding every
// scope the account approved across Search Console, GA4, Google Ads, Business
// Profile, Sheets, BigQuery, YouTube and a Google-signed-in Microsoft Ads, and
// revoking is grant-wide. So a grant another of the agency's sources still sits
// on is never revoked (OAuthProvider.grantKey).
export async function sharesProviderGrant(
  supabase: SupabaseClient,
  agencyId: string,
  type: string,
  owner: GrantOwner,
  excludeSourceIds: string[]
): Promise<boolean> {
  const provider = oauthForType(type);
  const grantKey = provider?.grantKey?.(owner) ?? null;
  if (!grantKey) return false;
  const { data: siblings } = await supabase
    .from("data_sources")
    .select("id, type, display_name, config")
    .eq("agency_id", agencyId);
  return ((siblings ?? []) as (GrantOwner & { id: string; type: string })[]).some(
    (s) => !excludeSourceIds.includes(s.id) && oauthForType(s.type)?.grantKey?.(s) === grantKey
  );
}

// Revokes the sign-in's grant when the platform supports it and no other
// source of the agency depends on the same grant. Tokens are read with the
// service role and never leave the server.
export async function revokeSignIn(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  args: { agencyId: string; connectionId: string; type: string; owner: GrantOwner; excludeSourceIds: string[] }
): Promise<RevokeOutcome> {
  const provider = oauthForType(args.type);
  if (!provider?.revoke) return "not_supported";
  if (await sharesProviderGrant(supabase, args.agencyId, args.type, args.owner, args.excludeSourceIds)) return "shared_grant";

  const { data: conn } = await admin
    .from("connections")
    .select("access_token, refresh_token")
    .eq("id", args.connectionId)
    .eq("agency_id", args.agencyId)
    .maybeSingle();
  if (!conn) return "failed";
  try {
    await provider.revoke({
      accessToken: conn.access_token ? decrypt(conn.access_token as string) : null,
      refreshToken: conn.refresh_token ? decrypt(conn.refresh_token as string) : null,
    });
    return "revoked";
  } catch {
    // Swallowed: deleting our copy below still ends Anavyst's access.
    return "failed";
  }
}
