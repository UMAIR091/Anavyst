import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeShopDomain, verifyShopifyWebhook } from "@/lib/integrations/oauth/shopify";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import { logError } from "@/lib/errorLog";
import { logConnectionEvent } from "@/lib/integrations/connectionEvents";

export const runtime = "nodejs";

// Shopify's mandatory compliance webhooks, plus app/uninstalled, all at
// https://tryreportflow.com/api/webhooks/shopify (set in the app's
// configuration). Each is verified against the app secret before anything
// is read from it.
//
//   customers/data_request, customers/redact
//     Anavyst stores a store's totals, its product names and a COUNT of
//     customers, never a customer's id, name, email or address. So there is
//     nothing to hand over or erase; Shopify only needs the 200.
//   shop/redact (48 hours after uninstall)
//     Everything stored for the store goes: its data sources (their
//     snapshots and history with them) and their sign-ins.
//   app/uninstalled
//     The store's token is dead, so its sources say so and stop syncing.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyShopifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  const topic = req.headers.get("x-shopify-topic") ?? "";
  let bodyShop = "";
  try {
    bodyShop = String(JSON.parse(raw)?.shop_domain ?? JSON.parse(raw)?.myshopify_domain ?? "");
  } catch {
    // Header below.
  }
  const shop = normalizeShopDomain(req.headers.get("x-shopify-shop-domain") ?? bodyShop);

  if (topic === "customers/data_request" || topic === "customers/redact") return NextResponse.json({ ok: true });
  if (!shop) return NextResponse.json({ ok: true });

  try {
    const admin = createAdminClient();
    const { data: sources } = await admin
      .from("data_sources")
      .select("id, agency_id, connection_id")
      .eq("type", "shopify")
      .eq("account_key", shop);
    const rows = (sources ?? []) as { id: string; agency_id: string; connection_id: string | null }[];

    if (topic === "shop/redact") {
      if (rows.length) {
        const { error } = await admin.from("data_sources").delete().in("id", rows.map((r) => r.id));
        if (error) throw new Error(error.message);
      }
    } else if (topic === "app/uninstalled") {
      if (rows.length) {
        await admin
          .from("data_sources")
          .update({ status: "revoked", last_sync_error: "The Anavyst app was uninstalled from this store. Reconnect to resume syncing." })
          .in("id", rows.map((r) => r.id));
        const signIns = rows.map((r) => r.connection_id).filter((id): id is string => Boolean(id));
        if (signIns.length) await admin.from("connections").update({ status: "revoked" }).in("id", signIns);
      }
    } else {
      return NextResponse.json({ ok: true });
    }
    for (const r of rows) {
      await logConnectionEvent({
        agencyId: r.agency_id, action: topic === "shop/redact" ? "store_data_deleted" : "store_uninstalled", actor: "provider",
        connectionId: r.connection_id, dataSourceId: r.id, platform: "shopify", detail: { store: shop },
      });
    }
    for (const agency of new Set(rows.map((r) => r.agency_id))) revalidateIntegrationHealth(agency);
    return NextResponse.json({ ok: true });
  } catch (err) {
    await logError({ context: "api_route", provider: "shopify", message: `${topic} webhook: ${(err as Error).message}` });
    return NextResponse.json({ error: "Couldn't process the webhook" }, { status: 500 });
  }
}
