import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokeSignIn } from "@/lib/integrations/revocation";
import { logConnectionEvent } from "@/lib/integrations/connectionEvents";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import type { GrantOwner } from "@/lib/integrations/types";

export const runtime = "nodejs";

// "Remove everywhere" on the Connections page: takes a saved sign-in off
// every client that uses it, deletes its stored access (snapshots and history
// go with the sources), and cancels the access at the platform where that is
// officially supported and no other source shares the grant.
//
// The page asks for confirmation naming every affected client, and this
// route requires the client count it was shown (`expectedClients`): if more
// clients started using the sign-in since the page loaded, nothing is removed
// and the page reloads with the new count.
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
  const expected = Number(body?.expectedClients);
  if (!connectionId || !Number.isFinite(expected)) {
    return NextResponse.json({ error: "connectionId and expectedClients are required" }, { status: 400 });
  }

  // RLS: the caller's own workspace only.
  const { data: conn } = await supabase
    .from("connections")
    .select("id, agency_id, type, client_id, display_name, identity_provider")
    .eq("id", connectionId)
    .maybeSingle();
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const agencyId = conn.agency_id as string;

  const { data: rows } = await supabase
    .from("data_sources")
    .select("id, client_id, type, display_name, config")
    .eq("connection_id", connectionId)
    .eq("agency_id", agencyId);
  const sources = (rows ?? []) as (GrantOwner & { id: string; client_id: string | null; type: string })[];
  const clients = new Set(sources.map((s) => s.client_id).filter(Boolean)).size;
  if (clients !== expected) {
    return NextResponse.json(
      { error: `This sign-in is now used by ${clients} client${clients === 1 ? "" : "s"}. Review it again before removing.`, clients },
      { status: 409 }
    );
  }

  const admin = createAdminClient();
  const owner: GrantOwner = sources[0] ?? {
    display_name: (conn.display_name as string | null) ?? null,
    config: { identity_provider: conn.identity_provider },
  };
  const revoked = await revokeSignIn(supabase, admin, {
    agencyId,
    connectionId,
    type: conn.type as string,
    owner,
    excludeSourceIds: sources.map((s) => s.id),
  });

  if (sources.length) {
    const { error } = await supabase.from("data_sources").delete().eq("connection_id", connectionId).eq("agency_id", agencyId);
    if (error) return NextResponse.json({ error: "Couldn't remove that sign-in. Please try again." }, { status: 400 });
  }
  // The last source's deletion removes the sign-in (migration 0046); this also
  // covers a sign-in no source used.
  await admin.from("connections").delete().eq("id", connectionId).eq("agency_id", agencyId);

  await logConnectionEvent({
    agencyId,
    action: "remove_sign_in",
    userId: user.id,
    connectionId,
    clientId: (conn.client_id as string | null) ?? null,
    platform: conn.type as string,
    detail: { signedInAs: (conn.display_name as string | null) ?? null, clients, sources: sources.length, revokedAtProvider: revoked },
  });
  revalidateIntegrationHealth(agencyId);
  return NextResponse.json({ ok: true, removedSources: sources.length, revoked });
}
