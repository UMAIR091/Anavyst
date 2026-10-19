import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./testing/fakeSupabase";

// Meta's deauthorize and data deletion callbacks: only requests signed with
// our own app secret count, and they reach exactly the sign-ins made by that
// person (matched on the stable id recorded at sign-in, never a name).

vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => s }));
vi.mock("@/lib/billing/limits", () => ({ checkIntegrationLimit: async () => ({ allowed: true }) }));

import { deauthorizeMetaSignIns, deleteMetaSignIns, parseSignedRequest, verifyMetaSignIn } from "./metaCallbacks";
import { subjectHash } from "./connections";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function signed(payload: object, secret: string) {
  const body = b64url(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: 1, ...payload }));
  return `${b64url(crypto.createHmac("sha256", secret).update(body).digest())}.${body}`;
}

beforeEach(() => {
  process.env.META_APP_SECRET = "fb-secret";
  process.env.INSTAGRAM_APP_SECRET = "ig-secret";
});

describe("signed_request", () => {
  it("accepts only our own apps' signatures, and says which app signed", () => {
    expect(verifyMetaSignIn(signed({ user_id: "10" }, "fb-secret"))).toEqual({ route: "facebook", userId: "10" });
    expect(verifyMetaSignIn(signed({ user_id: "20" }, "ig-secret"))).toEqual({ route: "instagram", userId: "20" });
    expect(verifyMetaSignIn(signed({ user_id: "10" }, "someone-else"))).toBeNull();
    expect(verifyMetaSignIn("garbage")).toBeNull();
    expect(verifyMetaSignIn(null)).toBeNull();
  });

  it("rejects a payload altered after signing", () => {
    const [sig] = signed({ user_id: "10" }, "fb-secret").split(".");
    const forged = b64url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "99" }));
    expect(parseSignedRequest(`${sig}.${forged}`, "fb-secret")).toBeNull();
  });
});

describe("acting on a request", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    const add = (id: string, type: string, subject: string | null) =>
      db.rows("connections").push({ id, agency_id: "ag-1", type, client_id: null, status: "connected", subject_hash: subject && subjectHash(type, subject) });
    add("fb-ads", "meta_ads", "meta-user:10");
    add("fb-ig", "instagram", "meta-user:10");
    add("ig", "instagram", "instagram:10");
    add("other", "meta_ads", "meta-user:11");
    add("legacy", "meta_ads", null);
    for (const c of ["fb-ads", "fb-ig", "ig", "other", "legacy"]) {
      db.rows("data_sources").push({
        id: `ds-${c}`, agency_id: "ag-1", client_id: "c-1", type: c === "fb-ig" || c === "ig" ? "instagram" : "meta_ads",
        connection_id: c, status: "connected", config: { account_id: c },
      });
    }
  });

  it("deauthorize stops that person's Facebook sign-ins and nobody else's", async () => {
    const res = await deauthorizeMetaSignIns(db.client(), { route: "facebook", userId: "10" });
    expect(res).toEqual({ signIns: 2, agencies: ["ag-1"] });
    const status = Object.fromEntries(db.rows("connections").map((c) => [c.id, c.status]));
    expect(status).toEqual({ "fb-ads": "revoked", "fb-ig": "revoked", ig: "connected", other: "connected", legacy: "connected" });
    expect(db.rows("data_sources").filter((r) => r.status === "revoked").map((r) => r.id)).toEqual(["ds-fb-ads", "ds-fb-ig"]);
  });

  it("deletion removes that person's Instagram-login sign-in and its data only", async () => {
    const res = await deleteMetaSignIns(db.client(), { route: "instagram", userId: "10" });
    expect(res).toEqual({ signIns: 1, sources: 1, agencies: ["ag-1"] });
    expect(db.rows("connections").map((c) => c.id)).toEqual(["fb-ads", "fb-ig", "other", "legacy"]);
    expect(db.rows("data_sources").map((r) => r.id)).toEqual(["ds-fb-ads", "ds-fb-ig", "ds-other", "ds-legacy"]);
  });
});
