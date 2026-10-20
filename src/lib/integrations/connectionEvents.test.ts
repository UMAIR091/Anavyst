import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { cleanDetail } from "./connectionEvents";

// The activity log never stores anything that looks like a credential.
describe("cleanDetail", () => {
  it("drops secret-looking fields and trims the rest", () => {
    const out = cleanDetail({
      access_token: "x", refreshToken: "y", secret: "z", apiKey: "k", code: "c",
      signedInAs: "Ali", account: "a".repeat(500), clients: ["A", "B"], restored: 2,
    });
    expect(out).toEqual({ signedInAs: "Ali", account: "a".repeat(200), clients: ["A", "B"], restored: 2 });
  });
});
