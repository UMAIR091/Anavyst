// Meta's two platform callbacks, for both sign-in routes on the Meta app:
//
//   Deauthorize  A person removed Anavyst in their Facebook or Instagram
//                settings. Their sign-ins stop working at once, so they are
//                marked expired (and their clients asked to reconnect).
//   Deletion     A person asked Meta to have their data deleted. Their
//                sign-ins and everything synced through them are deleted,
//                and Meta gets a confirmation code and a status URL.
//
// Both arrive as a `signed_request`: "<signature>.<payload>", base64url, the
// signature an HMAC-SHA256 of the payload with the app secret. Facebook Login
// signs with META_APP_SECRET and names the app-scoped user id; Instagram
// Login signs with INSTAGRAM_APP_SECRET and names the Instagram user id.
// Sign-ins are found by connections.subject_hash (migration 0049), the same
// stable id recorded at sign-in (OAuthProvider.subject), never by a name.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { subjectHash } from "./connections";

export type MetaSignIn = { route: "facebook" | "instagram"; userId: string };

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// The verified payload's user, or null for anything not signed by our app.
export function parseSignedRequest(signed: string | null | undefined, secret: string | undefined): { user_id?: string } | null {
  if (!signed || !secret) return null;
  const [sig, payload] = signed.split(".", 2);
  if (!sig || !payload) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const given = b64url(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(b64url(payload).toString("utf8"));
    if (typeof data?.algorithm === "string" && data.algorithm.toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch {
    return null;
  }
}

// Which app signed it, and for whom.
export function verifyMetaSignIn(signed: string | null | undefined): MetaSignIn | null {
  const fb = parseSignedRequest(signed, process.env.META_APP_SECRET);
  if (fb?.user_id) return { route: "facebook", userId: String(fb.user_id) };
  const ig = parseSignedRequest(signed, process.env.INSTAGRAM_APP_SECRET);
  if (ig?.user_id) return { route: "instagram", userId: String(ig.user_id) };
  return null;
}

// The subject hashes this person's sign-ins carry, per integration type.
export function subjectHashesFor(who: MetaSignIn): string[] {
  if (who.route === "instagram") return [subjectHash("instagram", `instagram:${who.userId}`)!];
  const subject = `meta-user:${who.userId}`;
  return [subjectHash("meta_ads", subject)!, subjectHash("instagram", subject)!];
}

async function signInsOf(admin: SupabaseClient, who: MetaSignIn): Promise<{ id: string; agency_id: string }[]> {
  const { data, error } = await admin
    .from("connections")
    .select("id, agency_id")
    .in("type", ["meta_ads", "instagram"])
    .in("subject_hash", subjectHashesFor(who));
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; agency_id: string }[];
}

const REMOVED = "Access was removed in Facebook or Instagram settings. Reconnect to resume syncing.";

// Returns the workspaces affected, so their health summaries refresh.
export async function deauthorizeMetaSignIns(admin: SupabaseClient, who: MetaSignIn): Promise<{ signIns: number; agencies: string[] }> {
  const signIns = await signInsOf(admin, who);
  for (const s of signIns) {
    await admin.from("connections").update({ status: "revoked" }).eq("id", s.id);
    await admin.from("data_sources").update({ status: "revoked", last_sync_error: REMOVED }).eq("connection_id", s.id);
  }
  return { signIns: signIns.length, agencies: [...new Set(signIns.map((s) => s.agency_id))] };
}

// Deletes the person's sign-ins and every source synced through them (their
// snapshots and history go with the sources).
export async function deleteMetaSignIns(
  admin: SupabaseClient,
  who: MetaSignIn
): Promise<{ signIns: number; sources: number; agencies: string[] }> {
  const signIns = await signInsOf(admin, who);
  let sources = 0;
  for (const s of signIns) {
    const { data, error } = await admin.from("data_sources").delete().eq("connection_id", s.id).select("id");
    if (error) throw new Error(error.message);
    sources += (data ?? []).length;
    // Already gone with its last source (migration 0046); this covers a
    // sign-in no source used.
    await admin.from("connections").delete().eq("id", s.id);
  }
  return { signIns: signIns.length, sources, agencies: [...new Set(signIns.map((s) => s.agency_id))] };
}

export function deletionCode(): string {
  return crypto.randomBytes(9).toString("base64url");
}
