import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GrantOwner } from "@/lib/integrations/types";
import { revokeSignIn } from "@/lib/integrations/revocation";
import { logConnectionEvent } from "@/lib/integrations/connectionEvents";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";

export const runtime = "nodejs";

// Disconnects one client's integration and deletes its row (cached snapshots
// cascade). Generic + RLS-scoped despite the /api/google path.
//
// Sign-ins are shared across the agency's clients (migration 0046), so this
// only removes THIS client's use of one. When it was the last source on the
// sign-in, the database deletes the sign-in's tokens along with it and the
// grant is revoked at the provider first, where the provider supports that
// and no other source sits on the same grant (lib/integrations/revocation).
// Tokens are read server-side only and never returned to the client.
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { dataSourceId } = body ?? {};
  if (!dataSourceId) return NextResponse.json({ error: "dataSourceId required" }, { status: 400 });

  // RLS scopes this to the caller's own sources.
  const { data: ds } = await supabase
    .from("data_sources")
    .select("id, type, agency_id, client_id, connection_id, display_name, config")
    .eq("id", dataSourceId)
    .maybeSingle();
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Is this the last source on its sign-in? Only then do the tokens go, and
  // only then is the grant a candidate for revoking.
  let lastOnSignIn = false;
  if (ds.connection_id) {
    const { count } = await supabase
      .from("data_sources")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", ds.connection_id as string)
      .neq("id", dataSourceId);
    lastOnSignIn = !count;
  }

  const revoke =
    lastOnSignIn && ds.connection_id
      ? await revokeSignIn(supabase, createAdminClient(), {
          agencyId: ds.agency_id as string,
          connectionId: ds.connection_id as string,
          type: ds.type as string,
          owner: ds as GrantOwner,
          excludeSourceIds: [dataSourceId],
        })
      : null;

  // Deleting the row also deletes the sign-in when no other client uses it
  // (trigger trg_data_sources_orphan_connection, migration 0046).
  const { error } = await supabase.from("data_sources").delete().eq("id", dataSourceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await logConnectionEvent({
    agencyId: ds.agency_id as string,
    action: "disconnect",
    userId: user.id,
    clientId: (ds.client_id as string | null) ?? null,
    connectionId: (ds.connection_id as string | null) ?? null,
    dataSourceId,
    platform: ds.type as string,
    detail: { signInRemoved: lastOnSignIn, revokedAtProvider: revoke ?? "kept (other clients use it)" },
  });
  if (ds.agency_id) revalidateIntegrationHealth(ds.agency_id as string);
  return NextResponse.json({ ok: true, signInRemoved: lastOnSignIn, revoked: revoke });
}
