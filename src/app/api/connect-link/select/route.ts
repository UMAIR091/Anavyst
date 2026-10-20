import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getIntegration } from "@/lib/integrations/registry";
import { loadOneSyncable } from "@/lib/integrations/connections";
import { syncDataSource } from "@/lib/sync";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import { logConnectionEvent } from "@/lib/integrations/connectionEvents";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { isLinkToken, linkConnectable, loadConnectLink } from "@/lib/connectLinks";
import type { IntegrationConfig } from "@/lib/integrations/types";

export const runtime = "nodejs";

type Row = {
  id: string;
  config: IntegrationConfig | null;
  account_key: string;
  connection_id: string | null;
  display_name: string | null;
  connection: { client_id: string | null } | { client_id: string | null }[] | null;
};

// On a client connect link, after signing in: the client picks which of the
// accounts their sign-in can see is theirs. Allowed only on a source the
// client made through a link (its own sign-in), never on one the agency
// connected, so a link can't re-point the agency's own setup. A client can
// connect several accounts of one platform (migration 0049): the pick lands
// on the client's own source waiting for an account.
export async function POST(req: Request) {
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  const type = String(form.get("type") ?? "");
  const accountId = String(form.get("accountId") ?? "");
  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const page = (query: string) =>
    NextResponse.redirect(`${appBase}/connect/${isLinkToken(token) ? token : "invalid"}?${query}`, 303);

  const limited = await rateLimit(`connect-link:${clientIp(req)}`, { limit: 30, windowSeconds: 600 });
  if (!limited.allowed) return page(`error=${encodeURIComponent("Too many attempts. Please wait a few minutes.")}`);

  const admin = createAdminClient();
  const found = await loadConnectLink(admin, token);
  if (!found.ok) return page("");
  const { link } = found;

  const def = getIntegration(type);
  if (!link.types.includes(type) || !linkConnectable(def) || !def.readAccounts) {
    return page(`error=${encodeURIComponent("That platform isn't part of this link.")}`);
  }

  const { data } = await admin
    .from("data_sources")
    .select("id, config, account_key, connection_id, display_name, connection:connections!data_sources_connection_fkey(client_id)")
    .eq("client_id", link.clientId)
    .eq("type", def.id);
  const rows = (data ?? []) as unknown as Row[];
  const ownerOf = (r: Row) => (Array.isArray(r.connection) ? r.connection[0]?.client_id : r.connection?.client_id) ?? null;
  const pending = rows.find((r) => r.account_key === "" && ownerOf(r) === link.clientId);
  if (!pending) return page(`error=${encodeURIComponent(`Connect ${def.name} first.`)}`);

  const config = (pending.config ?? {}) as IntegrationConfig;
  if (!def.readAccounts(config).some((a) => a.id === accountId)) {
    return page(`error=${encodeURIComponent("Please choose one of the listed accounts.")}`);
  }

  let syncId = pending.id;
  const taken = rows.find((r) => r.id !== pending.id && r.account_key === accountId);
  if (taken) {
    // The agency already connects this account itself: leave its setup alone.
    if (ownerOf(taken) !== link.clientId) {
      return page(`error=${encodeURIComponent(`${link.agency.name} already has that ${def.accountNoun} connected. Choose another.`)}`);
    }
    // The client connected it before: move it onto this newer sign-in,
    // keeping its history, and drop the waiting source.
    const { error } = await admin
      .from("data_sources")
      .update({
        connection_id: pending.connection_id,
        display_name: pending.display_name,
        config: { ...(taken.config ?? {}), ...config, [def.accountConfigKey]: accountId },
        status: "connected",
        last_sync_error: null,
      })
      .eq("id", taken.id)
      .eq("client_id", link.clientId);
    if (error) return page(`error=${encodeURIComponent("Couldn't save that. Please try again.")}`);
    await admin.from("data_sources").delete().eq("id", pending.id).eq("client_id", link.clientId);
    syncId = taken.id;
  } else {
    const next: IntegrationConfig = { ...config, [def.accountConfigKey]: accountId };
    const { error } = await admin
      .from("data_sources")
      .update({ config: next, last_sync_error: null })
      .eq("id", pending.id)
      .eq("client_id", link.clientId);
    if (error) return page(`error=${encodeURIComponent("Couldn't save that. Please try again.")}`);
  }

  const source = await loadOneSyncable(syncId);
  if (source) await syncDataSource(admin, source);
  revalidateIntegrationHealth(link.agencyId);
  await logConnectionEvent({
    agencyId: link.agencyId, action: "select_account", actor: "client", clientId: link.clientId,
    connectionId: pending.connection_id, dataSourceId: syncId, platform: def.id,
    detail: { account: def.readAccounts(config).find((a) => a.id === accountId)?.name ?? accountId, mergedIntoExisting: Boolean(taken) },
  });
  return page(`connected=${encodeURIComponent(def.id)}`);
}
