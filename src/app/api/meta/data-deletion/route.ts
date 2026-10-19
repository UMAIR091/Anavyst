import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteMetaSignIns, deletionCode, verifyMetaSignIn } from "@/lib/integrations/metaCallbacks";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import { logError } from "@/lib/errorLog";

export const runtime = "nodejs";

// Meta's "Data deletion request URL" (Facebook Login and Instagram business
// login settings): https://tryreportflow.com/api/meta/data-deletion. Meta
// POSTs a form with signed_request when someone asks for their data to be
// deleted. Their sign-ins and everything synced through them are deleted,
// and Meta is answered with a confirmation code and a page to check it on
// (/data-deletion?code=…). See lib/integrations/metaCallbacks.ts.
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const who = verifyMetaSignIn(form?.get("signed_request") as string | null);
  if (!who) return NextResponse.json({ error: "Invalid signed_request" }, { status: 400 });

  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  try {
    const admin = createAdminClient();
    const { signIns, sources, agencies } = await deleteMetaSignIns(admin, who);
    const code = deletionCode();
    const { error } = await admin.from("meta_deletion_requests").insert({
      code,
      route: who.route,
      sign_ins_deleted: signIns,
      sources_deleted: sources,
    });
    if (error) throw new Error(error.message);
    for (const agency of agencies) revalidateIntegrationHealth(agency);
    return NextResponse.json({ url: `${appBase}/data-deletion?code=${code}`, confirmation_code: code });
  } catch (err) {
    await logError({ context: "api_route", provider: "meta", message: `data deletion callback: ${(err as Error).message}` });
    return NextResponse.json({ error: "Couldn't process the request" }, { status: 500 });
  }
}
