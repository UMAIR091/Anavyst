import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncDataSource } from "@/lib/sync";
import { loadOneSyncable } from "@/lib/integrations/connections";
import { getIntegration } from "@/lib/integrations/registry";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import type { IntegrationConfig } from "@/lib/integrations/types";

export const runtime = "nodejs";

type Row = { id: string; agency_id: string; client_id: string; type: string; config: IntegrationConfig | null; connection_id: string | null; display_name: string | null; account_key: string };

// Saves which account/property a data source reports on. Accepts a generic
// `accountId` (keyed by the provider's config field) and keeps the legacy
// `siteUrl`/`propertyId` fields for backward compatibility.
//
// A client can have several accounts of one platform (migration 0049), each
// its own source, so:
//   - the account must be one the source's sign-in listed;
//   - choosing, on a source still waiting for one, an account the client
//     already has moves that account onto this newer sign-in rather than
//     creating a second copy of it;
//   - switching a working source to an account the client already has is
//     refused (that account has its own source).
// Switching a source's account clears what it stored for the old one
// (database trigger, 0049), so a report never mixes two accounts.
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { dataSourceId, siteUrl, propertyId, accountId } = body ?? {};
  const value: string | undefined = accountId ?? propertyId ?? siteUrl;
  if (!dataSourceId || !value) {
    return NextResponse.json({ error: "dataSourceId and an account/property are required" }, { status: 400 });
  }

  // RLS: the caller's own workspace only.
  const { data } = await supabase
    .from("data_sources")
    .select("id, agency_id, client_id, type, config, connection_id, display_name, account_key")
    .eq("id", dataSourceId)
    .maybeSingle();
  const ds = data as Row | null;
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const def = getIntegration(ds.type);
  const current = (ds.config ?? {}) as IntegrationConfig;
  // Store under the integration's account-config key (e.g. site_url, property_id).
  const key = def?.accountConfigKey ?? (propertyId ? "property_id" : "site_url");
  const listed = def?.readAccounts?.(current) ?? [];
  if (listed.length && !listed.some((a) => a.id === value)) {
    return NextResponse.json(
      { error: `Choose one of the listed ${def?.accountNoun ?? "account"}s. If it's missing, click Refresh now.` },
      { status: 400 }
    );
  }
  const name = listed.find((a) => a.id === value)?.name ?? value;

  const { data: others } = await supabase
    .from("data_sources")
    .select("id, config, connection_id, account_key")
    .eq("client_id", ds.client_id)
    .eq("type", ds.type)
    .neq("id", ds.id);
  const taken = ((others ?? []) as Pick<Row, "id" | "config" | "connection_id" | "account_key">[]).find(
    (o) => o.account_key === value
  );

  let syncId = ds.id;
  let merged = false;
  if (taken) {
    if (ds.account_key !== "") {
      return NextResponse.json({ error: `“${name}” is already connected for this client.` }, { status: 409 });
    }
    // This source was waiting for an account, and the client already has
    // this one: move it onto this (newer) sign-in, keeping its history, and
    // drop the waiting source.
    const { error } = await supabase
      .from("data_sources")
      .update({
        connection_id: ds.connection_id,
        display_name: ds.display_name,
        config: { ...(taken.config ?? {}), ...current, [key]: value },
        status: "connected",
        last_sync_error: null,
      })
      .eq("id", taken.id);
    if (error) return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 400 });
    await supabase.from("data_sources").delete().eq("id", ds.id);
    syncId = taken.id;
    merged = true;
  } else {
    const config = { ...current, [key]: value };
    const { error } = await supabase.from("data_sources").update({ config, last_sync_error: null }).eq("id", ds.id);
    if (error) {
      // Another request took this account for the client a moment ago.
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ error: `“${name}” is already connected for this client.` }, { status: 409 });
      }
      return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 400 });
    }
  }

  // Sync immediately so cached analytics are available without waiting for cron.
  // Already authorized by the RLS-scoped read above.
  const full = await loadOneSyncable(syncId);
  if (full) await syncDataSource(supabase, full);
  revalidateIntegrationHealth(ds.agency_id);

  return NextResponse.json({ ok: true, merged });
}
