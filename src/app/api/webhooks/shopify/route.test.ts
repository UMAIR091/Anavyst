import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/integrations/testing/fakeSupabase";

// Shopify's compliance webhooks: signed with the app secret or refused, and
// acting on exactly the store named.

const state = vi.hoisted(() => ({ db: null as unknown as import("@/lib/integrations/testing/fakeSupabase").FakeDb }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client() }));
vi.mock("@/lib/integrationHealth", () => ({ revalidateIntegrationHealth: () => undefined }));
vi.mock("@/lib/errorLog", () => ({ logError: async () => undefined }));

import { POST } from "./route";

let db: FakeDb;
beforeEach(() => {
  process.env.SHOPIFY_API_SECRET = "shp-secret";
  db = new FakeDb();
  state.db = db;
  for (const [id, shop] of [["a", "acme.myshopify.com"], ["b", "other.myshopify.com"]]) {
    db.rows("connections").push({ id: `conn-${id}`, agency_id: "ag-1", type: "shopify", client_id: null, status: "connected" });
    db.rows("data_sources").push({
      id: `ds-${id}`, agency_id: "ag-1", client_id: `c-${id}`, type: "shopify", connection_id: `conn-${id}`, status: "connected",
      config: { accounts: [{ id: shop, name: shop }], account_id: shop },
    });
  }
});

function hook(topic: string, body: object, secret = "shp-secret") {
  const raw = JSON.stringify(body);
  return POST(
    new Request("https://app.test/api/webhooks/shopify", {
      method: "POST",
      body: raw,
      headers: {
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": "acme.myshopify.com",
        "x-shopify-hmac-sha256": crypto.createHmac("sha256", secret).update(raw).digest("base64"),
      },
    })
  );
}

describe("Shopify webhooks", () => {
  it("refuses anything not signed with the app secret", async () => {
    const res = await hook("shop/redact", { shop_domain: "acme.myshopify.com" }, "wrong");
    expect(res.status).toBe(401);
    expect(db.rows("data_sources")).toHaveLength(2);
  });

  it("answers customer requests: no customer records are stored", async () => {
    expect((await hook("customers/data_request", { shop_domain: "acme.myshopify.com", customer: { id: 1 } })).status).toBe(200);
    expect((await hook("customers/redact", { shop_domain: "acme.myshopify.com", customer: { id: 1 } })).status).toBe(200);
    expect(db.rows("data_sources")).toHaveLength(2);
  });

  it("shop/redact deletes that store's data and sign-in, and no other store's", async () => {
    expect((await hook("shop/redact", { shop_domain: "acme.myshopify.com" })).status).toBe(200);
    expect(db.rows("data_sources").map((r) => r.id)).toEqual(["ds-b"]);
    expect(db.rows("connections").map((r) => r.id)).toEqual(["conn-b"]);
  });

  it("app/uninstalled stops that store's syncing", async () => {
    await hook("app/uninstalled", { myshopify_domain: "acme.myshopify.com" });
    expect(db.rows("data_sources").map((r) => r.status)).toEqual(["revoked", "connected"]);
    expect(db.connection("conn-a")!.status).toBe("revoked");
  });
});
