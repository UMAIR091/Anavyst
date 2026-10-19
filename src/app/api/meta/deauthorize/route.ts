import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deauthorizeMetaSignIns, verifyMetaSignIn } from "@/lib/integrations/metaCallbacks";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import { logError } from "@/lib/errorLog";

export const runtime = "nodejs";

// Meta's "Deauthorize callback URL" (Facebook Login and Instagram business
// login settings): https://tryreportflow.com/api/meta/deauthorize. Meta POSTs
// a form with signed_request when someone removes Anavyst from their
// Facebook or Instagram settings. See lib/integrations/metaCallbacks.ts.
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const who = verifyMetaSignIn(form?.get("signed_request") as string | null);
  if (!who) return NextResponse.json({ error: "Invalid signed_request" }, { status: 400 });

  try {
    const { agencies } = await deauthorizeMetaSignIns(createAdminClient(), who);
    for (const agency of agencies) revalidateIntegrationHealth(agency);
    return NextResponse.json({ ok: true });
  } catch (err) {
    await logError({ context: "api_route", provider: "meta", message: `deauthorize callback: ${(err as Error).message}` });
    return NextResponse.json({ error: "Couldn't process the request" }, { status: 500 });
  }
}
