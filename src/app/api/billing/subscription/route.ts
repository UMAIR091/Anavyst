import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndAgency, isAdminRole } from "@/lib/agency";
import { findPrice, getPlan, planForPrice, planRank, BILLING_INTERVALS, normalizeInterval, type BillingInterval, type PlanId } from "@/lib/billing/config";
import { reconcileMissingSubscription } from "@/lib/billing/reconcile";
import {
  cancelSubscription,
  changeSubscriptionPrice,
  resumeSubscription,
  unpauseSubscription,
  readSubscription,
  PaddleError,
} from "@/lib/billing/paddle";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/billing/subscription";

export const runtime = "nodejs";

// Plan changes and cancellation for an existing Paddle subscription.
//
//   { action: "change", plan, interval }  upgrade or downgrade
//   { action: "cancel" }                  cancel at period end
//   { action: "resume" }                  undo a scheduled cancellation
//
// Paddle is authoritative, so after each call we write the returned
// subscription straight back to the database. The webhook will deliver the
// same facts moments later — both paths are idempotent upserts, so whichever
// lands first wins and the other is a no-op.

type Body = { action?: string; plan?: string; interval?: string; reason?: string; comment?: string };

const INTERVALS: BillingInterval[] = BILLING_INTERVALS;

// Upgrade vs downgrade is decided by catalog order (client capacity), not by
// a price literal — prices live in Paddle and must not be duplicated here.

export async function POST(req: Request) {
  const { user, agency, role } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(role)) {
    return NextResponse.json({ error: "Only agency owners and admins can manage billing." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const action = body?.action;
  if (!action || !["change", "cancel", "resume"].includes(action)) {
    return NextResponse.json({ error: "action must be change, cancel or resume." }, { status: 400 });
  }

  const supabase = createClient();
  // Reads use the caller's session. Writes to subscriptions need the service
  // role: tenants only have read access to that table (migration 0038).
  const admin = createAdminClient();
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("provider, provider_subscription_id, price_id, plan, status")
    .eq("agency_id", agency.id)
    .maybeSingle();

  if (sub?.provider !== "paddle" || !sub.provider_subscription_id) {
    return NextResponse.json({ error: "No active subscription to manage." }, { status: 404 });
  }
  const subscriptionId = sub.provider_subscription_id as string;

  // An ended subscription is terminal at Paddle — it cannot be changed,
  // cancelled or resumed, and asking only returns an opaque provider error.
  // The way back is a new checkout, so say that.
  if (!LIVE_SUBSCRIPTION_STATUSES.has(sub.status as string)) {
    return NextResponse.json(
      { error: "Your subscription has ended. Choose a plan on this page to subscribe again.", code: "subscription_ended" },
      { status: 409 }
    );
  }

  try {
    if (action === "cancel") {
      const updated = await cancelSubscription(subscriptionId);
      await persist(admin, agency.id, updated);
      // Capture churn reason (best-effort; never blocks the cancellation).
      const reason = typeof body?.reason === "string" ? body.reason.slice(0, 120) : null;
      const comment = typeof body?.comment === "string" ? body.comment.slice(0, 1000) : null;
      if (reason || comment) {
        await supabase.from("cancellation_feedback").insert({ agency_id: agency.id, reason, comment }).then(() => {}, () => {});
      }
      return NextResponse.json({ ok: true, message: "Your subscription will end at the close of the current period." });
    }

    if (action === "resume") {
      const updated =
        sub.status === "paused" ? await unpauseSubscription(subscriptionId) : await resumeSubscription(subscriptionId);
      await persist(admin, agency.id, updated);
      return NextResponse.json({ ok: true, message: "Your subscription has been resumed." });
    }

    // action === "change"
    const plan = body?.plan as PlanId | undefined;
    const interval = normalizeInterval(body?.interval);
    if (!plan || !getPlan(plan) || !interval || !INTERVALS.includes(interval)) {
      return NextResponse.json({ error: "plan and interval (monthly/quarterly) are required." }, { status: 400 });
    }

    const priceId = findPrice(plan, interval);
    if (!priceId) return NextResponse.json({ error: "That plan isn't available." }, { status: 400 });
    if (priceId === sub.price_id) {
      return NextResponse.json({ error: "You're already on that plan." }, { status: 400 });
    }

    // Compare against the plan the current price maps to, not the stored plan
    // column, so a stale row can't misclassify the direction of the change.
    const currentPlan = (sub.price_id ? planForPrice(sub.price_id)?.plan : null) ?? (sub.plan as PlanId | null);
    const isUpgrade = planRank(plan) >= planRank(currentPlan);

    const updated = await changeSubscriptionPrice({ subscriptionId, priceId, immediate: isUpgrade });
    await persist(admin, agency.id, updated);

    return NextResponse.json({
      ok: true,
      message: isUpgrade
        ? `You're now on ${getPlan(plan)!.name}. The prorated difference has been charged.`
        : `Your plan will change to ${getPlan(plan)!.name}. The lower rate applies from your next renewal.`,
    });
  } catch (err) {
    const e = err as PaddleError;
    console.error(`Paddle subscription ${action} failed:`, e.message);

    // The subscription doesn't exist at the provider, so there is nothing to
    // cancel, resume or change. Clear the stale row rather than repeating the
    // same 404 on every click, and tell the customer what actually happened.
    if (e.notFound) {
      await reconcileMissingSubscription(admin, agency.id, `subscription ${action}: not found`);
      return NextResponse.json(
        {
          ok: true,
          reconciled: true,
          message:
            action === "cancel"
              ? "That subscription no longer exists with our payment provider, so there was nothing to cancel. Your billing details have been reset and you won't be charged."
              : "That subscription no longer exists with our payment provider, so we've reset your billing details. Choose a plan to subscribe again.",
        },
        { status: 200 }
      );
    }

    return NextResponse.json({ error: e.message }, { status: e.status ?? 502 });
  }
}

// Mirrors Paddle's response into our row so the UI reflects the change on the
// next render, without waiting for the webhook.
async function persist(
  admin: SupabaseClient,
  agencyId: string,
  subscription: Parameters<typeof readSubscription>[0]
): Promise<void> {
  const facts = readSubscription(subscription);
  const mapped = facts.priceId ? planForPrice(facts.priceId) : null;

  const row: Record<string, unknown> = {
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

  // Service role, scoped to the agency resolved from the session — never an id
  // taken from the request.
  await admin.from("subscriptions").update(row).eq("agency_id", agencyId);
}
