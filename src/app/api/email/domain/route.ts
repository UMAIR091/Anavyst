import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndAgency, isAdminRole } from "@/lib/agency";
import { emailProvider, isReservedSendingDomain, type SendingDomain } from "@/lib/email";

export const runtime = "nodejs";

// White-label sending domain for the signed-in agency.
//   GET     current domain + fresh verification state from the provider
//   POST    { domain } — register a new sending domain
//   DELETE  remove the domain (provider + our record)
//
// One domain per agency, and one agency per domain (unique constraints).
// Reads and the delete use the RLS client, so an agency only ever sees or
// removes its own row. Writes that store domain state use the service role:
// the row's status is what lib/email/sender.ts trusts to send as that domain,
// so tenants may not write it (migration 0039), and what is written comes from
// Resend, never from the request.

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!d || d.length > 253 || !HOSTNAME_RE.test(d)) return null;
  return d;
}

type DomainView = {
  domain: string;
  status: string;
  records: SendingDomain["records"];
  region?: string | null;
  lastCheckedAt: string | null;
};

function view(row: { domain: string; status: string; dns_records: unknown; region: string | null; last_checked_at: string | null }): DomainView {
  return {
    domain: row.domain,
    status: row.status,
    records: (row.dns_records as SendingDomain["records"]) ?? [],
    region: row.region,
    lastCheckedAt: row.last_checked_at,
  };
}

export async function GET() {
  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createClient();
  const { data: row } = await supabase
    .from("email_domains")
    .select("resend_domain_id, domain, status, dns_records, region, last_checked_at")
    .eq("agency_id", agency.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ domain: null });

  // Refresh from the provider so the page always shows live status; keep the
  // cached copy when the provider is briefly unreachable.
  try {
    const fresh = await emailProvider().getDomain(row.resend_domain_id);
    const patch = {
      status: fresh.status,
      dns_records: fresh.records,
      region: fresh.region ?? row.region,
      last_checked_at: new Date().toISOString(),
    };
    await createAdminClient().from("email_domains").update(patch).eq("agency_id", agency.id);
    return NextResponse.json({ domain: view({ ...row, ...patch }) });
  } catch {
    return NextResponse.json({ domain: view(row), stale: true });
  }
}

export async function POST(req: Request) {
  const { user, agency, role } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(role)) return NextResponse.json({ error: "Only agency owners and admins can change email settings." }, { status: 403 });
  if (!emailProvider().isConfigured()) {
    return NextResponse.json({ error: "Email isn't configured on the platform yet." }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as { domain?: string } | null;
  const domain = body?.domain ? normalizeDomain(body.domain) : null;
  if (!domain) return NextResponse.json({ error: "Enter a valid domain, e.g. agency.com" }, { status: 400 });
  // The platform's own sending domain (and its subdomains) can never be claimed
  // by a tenant — that would let one agency send as the platform or as others.
  if (isReservedSendingDomain(domain)) return NextResponse.json({ error: "That domain can't be used." }, { status: 400 });

  const supabase = createClient();
  const { data: existing } = await supabase.from("email_domains").select("id").eq("agency_id", agency.id).maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "A sending domain is already configured. Remove it first to change domains." }, { status: 409 });
  }

  // One workspace per domain, checked across every agency (the RLS client only
  // sees this one) and before Resend is called, so a domain another workspace
  // registered is never looked up or handed over on this agency's behalf.
  const admin = createAdminClient();
  const { data: taken } = await admin.from("email_domains").select("id").eq("domain", domain).limit(1);
  if (taken?.length) {
    return NextResponse.json({ error: "That domain is already connected to another workspace." }, { status: 409 });
  }

  try {
    const created = await emailProvider().createDomain(domain);
    const rowData = {
      agency_id: agency.id,
      domain,
      resend_domain_id: created.id,
      status: created.status,
      dns_records: created.records,
      region: created.region ?? null,
      last_checked_at: new Date().toISOString(),
    };
    const { error } = await admin.from("email_domains").insert(rowData);
    if (error) {
      if (error.code === "23505") {
        // Lost a race for this domain. Leave the provider domain alone: it may
        // be the one the winning request just registered.
        return NextResponse.json({ error: "That domain is already connected to a workspace." }, { status: 409 });
      }
      // Roll back the provider-side domain so a DB failure doesn't leak one.
      await emailProvider().deleteDomain(created.id).catch(() => undefined);
      throw new Error(error.message);
    }
    return NextResponse.json({ domain: view({ ...rowData, last_checked_at: rowData.last_checked_at }) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function DELETE() {
  const { user, agency, role } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(role)) return NextResponse.json({ error: "Only agency owners and admins can change email settings." }, { status: 403 });

  const supabase = createClient();
  const { data: row } = await supabase
    .from("email_domains")
    .select("resend_domain_id")
    .eq("agency_id", agency.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ ok: true });

  // Provider first (best-effort — an orphaned provider domain is harmless and
  // retryable; a dangling DB row pointing nowhere is confusing).
  await emailProvider().deleteDomain(row.resend_domain_id).catch((err) =>
    console.warn(`Resend domain delete failed (continuing): ${(err as Error).message}`)
  );
  const { error } = await supabase.from("email_domains").delete().eq("agency_id", agency.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
