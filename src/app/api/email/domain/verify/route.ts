import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndAgency, isAdminRole } from "@/lib/agency";
import { emailProvider } from "@/lib/email";

export const runtime = "nodejs";

// Triggers a DNS (re)verification for the agency's sending domain, then
// returns the fresh state. Safe to call repeatedly — Resend just re-checks.
export async function POST() {
  const { user, agency, role } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(role)) return NextResponse.json({ error: "Only agency owners and admins can change email settings." }, { status: 403 });

  const supabase = createClient();
  const { data: row } = await supabase
    .from("email_domains")
    .select("resend_domain_id, domain, region")
    .eq("agency_id", agency.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "No sending domain configured yet." }, { status: 404 });

  try {
    const provider = emailProvider();
    await provider.verifyDomain(row.resend_domain_id);
    // Verification is async on Resend's side; fetch the current state (often
    // "pending" immediately after) so the UI reflects reality.
    const fresh = await provider.getDomain(row.resend_domain_id);
    const patch = {
      status: fresh.status,
      dns_records: fresh.records,
      region: fresh.region ?? row.region,
      last_checked_at: new Date().toISOString(),
    };
    // Service role: this is the only way a domain becomes verified. Tenants
    // can't write email_domains (migration 0039), and the status stored is
    // exactly what Resend just reported.
    await createAdminClient().from("email_domains").update(patch).eq("agency_id", agency.id);

    return NextResponse.json({
      domain: {
        domain: row.domain,
        status: patch.status,
        records: patch.dns_records,
        region: patch.region,
        lastCheckedAt: patch.last_checked_at,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
