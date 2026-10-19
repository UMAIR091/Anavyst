import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getValidAccessToken } from "@/lib/googleTokens";
import { syncDataSource } from "@/lib/sync";
import { loadOneSyncable } from "@/lib/integrations/connections";
import { getIntegration } from "@/lib/integrations/registry";
import type { IntegrationAccount, IntegrationConfig } from "@/lib/integrations/types";

export const runtime = "nodejs";

// "Refresh now" on a connection that has no account chosen: asks the provider
// for the account list again. The list was otherwise fetched only once, at
// connect time, so an account created or shared after connecting (a Google Ads
// account added under a manager, an Instagram account linked to a Page later)
// never appeared without disconnecting and reconnecting. An account already
// chosen stays chosen. RLS scopes the lookup to the user's own data sources.
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const dataSourceId: string | undefined = body?.dataSourceId;
  if (!dataSourceId) return NextResponse.json({ error: "dataSourceId required" }, { status: 400 });

  // The RLS-scoped read is the permission check; the sign-in's tokens are then
  // loaded with the service role (tenants can't read them).
  const { data: visible } = await supabase.from("data_sources").select("id").eq("id", dataSourceId).maybeSingle();
  const ds = visible ? await loadOneSyncable(dataSourceId) : null;
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const def = getIntegration(ds.type as string);
  if (!def?.listAccounts || !def.buildConfig) {
    return NextResponse.json({ error: "This integration has no account list to refresh" }, { status: 400 });
  }

  const current = (ds.config ?? {}) as IntegrationConfig;
  const provider =
    ds.connection?.identity_provider ??
    (typeof current.identity_provider === "string" ? current.identity_provider : undefined);
  // Integrations named by a pasted value (Sheets) have no list to browse, so
  // re-listing means re-reading the same one: hand back what was chosen.
  const chosen = def.readSelected?.(current) ?? null;
  let accounts: IntegrationAccount[];
  try {
    const accessToken = await getValidAccessToken(ds);
    accounts = await def.listAccounts(accessToken, { provider, connectValue: chosen ?? undefined });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }

  const config: IntegrationConfig = { ...current, ...def.buildConfig(accounts) };
  if (chosen) config[def.accountConfigKey] = chosen;
  // buildConfig picks a lone account; not one this client already reports on
  // through another source (migration 0049): leave the choice to the user.
  const auto = chosen ? null : def.readSelected?.(config) ?? null;
  if (auto && ds.client_id) {
    const { data: taken } = await supabase
      .from("data_sources")
      .select("id")
      .eq("client_id", ds.client_id)
      .eq("type", def.id)
      .eq("account_key", auto)
      .neq("id", ds.id)
      .limit(1);
    if (taken?.length) config[def.accountConfigKey] = null;
  }

  const { error } = await supabase.from("data_sources").update({ config }).eq("id", dataSourceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // buildConfig picks the account when there is only one, so sync right away,
  // as Save does, rather than leaving the source empty until the next cron run.
  if (def.readSelected?.(config)) await syncDataSource(supabase, { ...ds, config });

  return NextResponse.json({ ok: true, accounts: accounts.length });
}
