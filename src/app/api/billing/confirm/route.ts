import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndAgency, isAdminRole } from "@/lib/agency";
import { getTransactionFacts, getSubscription, readSubscription, PaddleError } from "@/lib/billing/paddle";
import { planForPrice } from "@/lib/billing/config";

export const runtime = "nodejs";

// Confirms a completed checkout directly with Paddle.
//
// Webhooks are the primary path and stay authoritative, but they are delivered
// by a third party to a destination we don't control at runtime: a
// misconfigured, disabled or mistyped destination means the customer pays and
// the app never finds out, leaving them locked out of what they just bought.
// This closes that gap by asking Paddle about the transaction the browser just
// completed, so activation never depends on an inbound request arriving.
//
// Both paths write the same fields and are idempotent, so whichever lands first
// wins and the other is a no-op.
export async function POST(req: Request) {
  const { user, agency, role } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(role)) {
    return NextResponse.json({ error: "Only agency owners and admins can manage billing." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { transactionId?: string } | null;
  const transactionId = typeof body?.transactionId === "string" ? body.transactionId.trim() : "";
  if (!transactionId.startsWith("txn_")) {
    return NextResponse.json({ error: "A transaction id is required." }, { status: 400 });
  }

  try {
    const tx = await getTransactionFacts(transactionId);

    // Authorisation. The transaction carries the agency it was created for in
    // customData; a caller may only confirm their OWN. Without this check any
    // signed-in user who learned a transaction id could attach someone else's
    // paid subscription to their workspace.
    if (!tx.agencyId || tx.agencyId !== agency.id) {
      console.error(
        `Confirm rejected: txn ${transactionId} attribution ${tx.agencyId ?? "missing"}, caller is ${agency.id}`
      );
      return NextResponse.json({ error: "That transaction doesn't belong to this workspace." }, { status: 403 });
    }

    // A subscription id can exist before Paddle has finished processing the
    // transaction. Only the completed state proves checkout processing ended.
    if (tx.status !== "completed" || !tx.subscriptionId) {
      return NextResponse.json({ ok: false, pending: true, message: "Payment received — still finalising." });
    }

    const subscription = await getSubscription(tx.subscriptionId);
    const facts = readSubscription(subscription);
    const mapped = facts.priceId ? planForPrice(facts.priceId) : null;

    const row: Record<string, unknown> = {
      provider: "paddle",
      provider_subscription_id: facts.subscriptionId,
      provider_customer_id: facts.customerId ?? tx.customerId,
      price_id: facts.priceId,
      status: facts.status,
      current_period_end: facts.currentPeriodEnd,
      ends_at: facts.endsAt,
      cancel_at_period_end: facts.cancelAtPeriodEnd,
      updated_at: new Date().toISOString(),
    };
    if (mapped) {
      row.plan = mapped.plan;
      row.billing_interval = mapped.interval;
    }

    // Scoped to the caller's own agency, resolved from the session above.
    const { error } = await supabaseUpdate(agency.id, row);
    if (error) {
      console.error(`Confirm failed to persist for agency ${agency.id}: ${error}`);
      return NextResponse.json({ error: "Couldn't activate your plan. Please refresh." }, { status: 500 });
    }

    return NextResponse.json({ ok: true, status: facts.status, plan: mapped?.plan ?? null });
  } catch (err) {
    const e = err as PaddleError;
    console.error(`Checkout confirm failed for ${transactionId}: ${e.message}`);
    return NextResponse.json({ error: e.message }, { status: e.status ?? 502 });
  }
}

// Upsert rather than update: an agency that has never had a subscription row
// (or whose row was cleared by reconciliation) still needs one written.
//
// Service role: tenants can read their subscription but not write it
// (migration 0038), or a browser could grant itself any plan. The agency id
// comes from the session, never from the request body.
async function supabaseUpdate(agencyId: string, row: Record<string, unknown>): Promise<{ error: string | null }> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("subscriptions")
    .select("id")
    .eq("agency_id", agencyId)
    .maybeSingle();

  const { error } = existing
    ? await admin.from("subscriptions").update(row).eq("agency_id", agencyId)
    : await admin.from("subscriptions").insert({ agency_id: agencyId, ...row });

  return { error: error?.message ?? null };
}
