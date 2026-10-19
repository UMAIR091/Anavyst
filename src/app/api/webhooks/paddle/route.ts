import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventEntity } from "@paddle/paddle-node-sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { planForPrice, planName, getPlan, normalizeInterval, PAID_TRIAL_DAYS, type PlanId } from "@/lib/billing/config";
import { emailConfigured, sendEmailWithRetry, welcomeEmailHtml } from "@/lib/email";
import { agencyContact } from "@/lib/agencyContact";
import {
  verifyWebhook,
  webhookConfigured,
  readSubscription,
  isStaleSubscriptionEvent,
  type SubscriptionFacts,
  type SubscriptionLike,
  type TransactionLike,
} from "@/lib/billing/paddle";
import { recordTrialGrant } from "@/lib/billing/trial";
import { LIVE_SUBSCRIPTION_STATUSES as LIVE } from "@/lib/billing/subscription";
import { captureServer } from "@/lib/analyticsServer";
import { ANALYTICS } from "@/lib/analytics";
import { reportFirstPurchase } from "@/lib/metaCapi";
import { applyAdjustment, recordCommission } from "@/lib/affiliates/commissions";

// The auth user id behind an agency — used as the analytics distinct id so
// server money-events stitch to the same person as client-side events.
async function agencyOwnerId(admin: SupabaseClient, agencyId: string): Promise<string | null> {
  const { data } = await admin.from("agencies").select("owner_id").eq("id", agencyId).maybeSingle();
  return (data?.owner_id as string | undefined) ?? null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Paddle webhook — the source of truth for subscription state.
//
// Signature-verified against the raw body by the Paddle SDK (timestamped
// HMAC-SHA256 with a replay window). Uses the admin client because webhooks
// carry no user session. Every handler is an idempotent upsert keyed on
// agency_id, so replays and out-of-order deliveries settle to the same row.
//
// Subscribe this endpoint (Paddle → Developer tools → Notifications) to:
//   transaction.completed
//   subscription.created, subscription.updated, subscription.canceled,
//   subscription.paused, subscription.resumed, subscription.past_due
//   adjustment.created, adjustment.updated   (affiliate commission refunds)
//
// Retry contract: a 2xx acknowledges the event. Anything we can't attribute is
// acknowledged (retrying won't supply missing data); genuine failures return
// 500 so Paddle retries with backoff.

type Handled = { ok: true; ignored?: string };

export async function POST(req: Request) {
  if (!webhookConfigured()) {
    console.error("Paddle webhook received but PADDLE_WEBHOOK_SECRET is not set.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  // Raw body is required for signature verification — read text before parsing.
  const rawBody = await req.text();
  const signature = req.headers.get("paddle-signature");

  const event = await verifyWebhook(rawBody, signature);
  if (!event) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  const admin = createAdminClient();

  try {
    const result = await handleEvent(admin, event);
    return NextResponse.json(result);
  } catch (err) {
    // 500 → Paddle retries with backoff, which is what we want for transient
    // database failures.
    console.error(`Paddle webhook ${event.eventType} failed:`, (err as Error).message);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

async function handleEvent(admin: SupabaseClient, event: EventEntity): Promise<Handled> {
  switch (event.eventType) {
    case "subscription.created":
    case "subscription.updated":
    case "subscription.canceled":
    case "subscription.paused":
    case "subscription.resumed":
    case "subscription.past_due":
    case "subscription.activated":
    case "subscription.trialing":
      return syncSubscription(admin, event.data);

    case "transaction.completed":
      return recordPayment(admin, event.data);

    // Refunds and chargebacks. Billing state is already handled by the
    // subscription.* events; these only correct affiliate commissions, and
    // never fail the webhook (lib/affiliates/commissions.ts).
    case "adjustment.created":
    case "adjustment.updated":
      await applyAdjustment(admin, event.data);
      return { ok: true };

    default:
      // Acknowledge everything else so Paddle stops retrying events we don't
      // subscribe to logically (transaction.created, product.updated, …).
      return { ok: true, ignored: event.eventType };
  }
}

// ── subscription.* ───────────────────────────────────────────
// Writes the full subscription picture. This is what grants and revokes
// premium access: the access layer (lib/billing/subscription.ts) reads these
// columns on every request, so a status change here takes effect immediately.
async function syncSubscription(admin: SupabaseClient, sub: SubscriptionLike): Promise<Handled> {
  const facts = readSubscription(sub);
  const agencyId = await resolveAgencyId(admin, facts);
  if (!agencyId) {
    console.error(`Paddle webhook: no agency for subscription ${facts.subscriptionId} (customer ${facts.customerId})`);
    return { ok: true, ignored: "unattributed subscription" };
  }

  // Previous state, read before the write: it decides whether this event is a
  // first activation (welcome email) or just a lifecycle update.
  const { data: prevRow } = await admin
    .from("subscriptions")
    .select("status, provider_subscription_id, provider_updated_at")
    .eq("agency_id", agencyId)
    .maybeSingle();

  // An out-of-order delivery of an older state of this same subscription.
  if (isStaleSubscriptionEvent(prevRow, facts)) {
    console.warn(`Paddle webhook: ignoring stale ${facts.status} for ${facts.subscriptionId} (updated ${facts.updatedAt}, stored ${prevRow?.provider_updated_at})`);
    return { ok: true, ignored: "stale event" };
  }

  // After a resubscribe the row points at the NEW subscription. A late or
  // replayed event for the old, ended one must not overwrite it — that would
  // flip a paying customer back to "cancelled".
  if (
    prevRow?.provider_subscription_id &&
    prevRow.provider_subscription_id !== facts.subscriptionId &&
    LIVE.has(prevRow.status as string) &&
    !LIVE.has(facts.status)
  ) {
    console.warn(`Paddle webhook: ignoring ${facts.status} for superseded subscription ${facts.subscriptionId}`);
    return { ok: true, ignored: "superseded subscription" };
  }

  const mapped = facts.priceId ? planForPrice(facts.priceId) : null;

  const row: Record<string, unknown> = {
    agency_id: agencyId,
    provider: "paddle",
    provider_customer_id: facts.customerId,
    provider_subscription_id: facts.subscriptionId,
    price_id: facts.priceId,
    status: facts.status,
    current_period_end: facts.currentPeriodEnd,
    ends_at: facts.endsAt,
    cancel_at_period_end: facts.cancelAtPeriodEnd,
    trial_ends_at: facts.trialEndsAt,
    provider_updated_at: facts.updatedAt,
    updated_at: new Date().toISOString(),
  };

  // Only overwrite plan/interval when the price is one we recognise — an
  // unknown price (e.g. sold before an env change) shouldn't silently
  // downgrade someone to the default plan.
  if (mapped) {
    row.plan = mapped.plan;
    row.billing_interval = mapped.interval;
  } else if (facts.priceId) {
    console.warn(`Paddle webhook: price ${facts.priceId} is not in the catalog — plan left unchanged.`);
  }

  // A healthy lifecycle event clears any earlier payment failure.
  if (facts.status === "active" || facts.status === "on_trial") row.payment_failed_at = null;

  const { error } = await admin.from("subscriptions").upsert(row, { onConflict: "agency_id" });
  if (error) throw new Error(error.message);

  // Product analytics — the money funnel (launch audit P0-4). Best-effort.
  const firstActivation = !prevRow || prevRow.status === "inactive";
  const ownerId = await agencyOwnerId(admin, agencyId);
  if (facts.status === "on_trial" && firstActivation) {
    await captureServer(ownerId, ANALYTICS.trialStarted, { plan: row.plan ?? null });
  } else if (facts.status === "active" && firstActivation) {
    await captureServer(ownerId, ANALYTICS.trialConverted, { plan: row.plan ?? null });
  } else if (facts.status === "active" && prevRow?.status === "past_due") {
    await captureServer(ownerId, ANALYTICS.subscriptionUpgraded, { plan: row.plan ?? null });
  } else if (facts.status === "canceled" || facts.status === "cancelled") {
    await captureServer(ownerId, ANALYTICS.subscriptionCancelled, { plan: row.plan ?? null });
  }

  // Burn the one-time paid trial the moment Paddle confirms a trialing
  // subscription. Recording it here (rather than at checkout) means it is only
  // spent on a subscription that actually exists — an abandoned checkout
  // leaves the customer's trial intact. The grant is keyed on email and
  // idempotent, so replays and later resubscribes can't mint a second one.
  if (facts.status === "on_trial") {
    await recordTrialGrant(admin, {
      agencyId,
      email: (await agencyContact(admin, agencyId)).email,
      plan: (row.plan as string | undefined) ?? null,
      interval: (row.billing_interval as string | undefined) ?? null,
      customerId: facts.customerId,
      subscriptionId: facts.subscriptionId,
    });
  }

  // First activation → welcome email. "First" means the row didn't exist or
  // was inactive; a past_due→active recovery or plan change never re-welcomes.
  // The prev-status guard also makes webhook replays a no-op, since after the
  // first processing the stored status is already active/on_trial.
  if ((facts.status === "active" || facts.status === "on_trial") && (!prevRow || prevRow.status === "inactive")) {
    await sendWelcomeEmail(admin, {
      agencyId,
      plan: (row.plan as string | null) ?? null,
      interval: (row.billing_interval as string | null) ?? null,
      trial: facts.status === "on_trial",
      renewsAt: facts.trialEndsAt ?? facts.currentPeriodEnd,
    });
  }

  return { ok: true };
}

// ── Welcome email ────────────────────────────────────────────
// Anavyst → agency, sent once when their subscription first activates.
// Complements (never replaces) Paddle's receipt — Paddle is merchant of record
// and owns the tax invoice; this is the product's own onboarding touch.
// Best-effort: a mail failure must never fail the webhook that grants access.
async function sendWelcomeEmail(
  admin: SupabaseClient,
  args: { agencyId: string; plan: string | null; interval: string | null; trial: boolean; renewsAt: string | null }
): Promise<void> {
  try {
    if (!emailConfigured()) return;
    const { email, name } = await agencyContact(admin, args.agencyId);
    if (!email) {
      console.warn(`Welcome email skipped for agency ${args.agencyId}: no contact email`);
      return;
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://tryreportflow.com";
    const planNm = planName(args.plan);
    const subject = args.trial
      ? `Your Anavyst trial has started`
      : `Welcome to Anavyst ${planNm}`;

    const html = welcomeEmailHtml({
      agencyName: name,
      planName: planNm,
      interval: normalizeInterval(args.interval),
      maxClients: args.plan ? getPlan(args.plan as PlanId)?.limits.maxClients ?? null : null,
      renewsAt: args.renewsAt,
      trial: args.trial,
      trialDays: PAID_TRIAL_DAYS,
      dashboardUrl: `${appUrl}/dashboard`,
      billingUrl: `${appUrl}/dashboard/billing`,
    });

    const from = (process.env.EMAIL_FROM ?? "").trim();
    const { id, attempts } = await sendEmailWithRetry({ from, to: email, subject, html }, 2);

    const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
    await admin.from("email_logs").insert({
      agency_id: args.agencyId,
      report_id: null,
      to_email: email,
      subject,
      status: "sent",
      provider_id: id,
      attempts,
      from_email: fromEmail,
      from_domain: fromEmail.slice(fromEmail.lastIndexOf("@") + 1).toLowerCase(),
      sent_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Welcome email failed for agency ${args.agencyId}: ${(err as Error).message}`);
  }
}

// ── transaction.completed ────────────────────────────────────
// Fires the moment a payment succeeds — including the very first one, which
// can arrive before subscription.created. Clearing payment_failed_at here (and
// stamping the customer id) means access is granted as soon as money lands
// rather than waiting for the subscription event.
async function recordPayment(admin: SupabaseClient, tx: TransactionLike): Promise<Handled> {
  const custom = tx.customData as { agency_id?: unknown } | null | undefined;
  const agencyId =
    (typeof custom?.agency_id === "string" ? custom.agency_id : null) ??
    (tx.subscriptionId ? await agencyBySubscription(admin, tx.subscriptionId) : null) ??
    (tx.customerId ? await agencyByCustomer(admin, tx.customerId) : null);

  if (!agencyId) {
    console.error(`Paddle webhook: no agency for transaction ${tx.id}`);
    return { ok: true, ignored: "unattributed transaction" };
  }

  // A one-off transaction with no subscription (rare in this app) has nothing
  // to sync — acknowledge it without touching the row.
  if (!tx.subscriptionId) return { ok: true, ignored: "non-subscription transaction" };

  const priceId = tx.items?.[0]?.price?.id ?? null;
  const mapped = priceId ? planForPrice(priceId) : null;

  const { data: existing } = await admin
    .from("subscriptions")
    .select("status, provider_subscription_id")
    .eq("agency_id", agencyId)
    .maybeSingle();

  const row: Record<string, unknown> = {
    agency_id: agencyId,
    provider: "paddle",
    provider_subscription_id: tx.subscriptionId,
    payment_failed_at: null,
    updated_at: new Date().toISOString(),
  };

  // Money landed, so grant access here rather than waiting for
  // subscription.created — Paddle often delivers that event *after* this one,
  // and on a first purchase the row would otherwise be inserted with the
  // column default ('inactive'), locking out a paying customer.
  //
  // Only promote from states a successful payment actually resolves. Webhooks
  // can arrive out of order, so a replayed transaction.completed must never
  // resurrect a subscription that has since been cancelled, paused or expired
  // — those transitions belong to the subscription.* events.
  //
  // A payment for a DIFFERENT subscription than the stored one is a customer
  // resubscribing after the old one ended: that new subscription is the live
  // one, whatever state the old row was left in.
  const PROMOTABLE = new Set(["inactive", "past_due", "unpaid"]);
  const isNewSubscription =
    Boolean(existing?.provider_subscription_id) && existing?.provider_subscription_id !== tx.subscriptionId;
  if (!existing || PROMOTABLE.has(existing.status as string) || (isNewSubscription && !LIVE.has(existing.status as string))) {
    row.status = "active";
  } else if (isNewSubscription) {
    // The stored subscription is still live and this payment is for another
    // one — don't repoint the row; the subscription.* events decide.
    return { ok: true, ignored: "payment for a non-current subscription" };
  }
  if (tx.customerId) row.provider_customer_id = tx.customerId;
  if (priceId) row.price_id = priceId;
  if (mapped) {
    row.plan = mapped.plan;
    row.billing_interval = mapped.interval;
  }

  const { error } = await admin.from("subscriptions").upsert(row, { onConflict: "agency_id" });
  if (error) throw new Error(error.message);

  // The first real payment is the conversion the ads are measured on. A trial
  // checkout completes at zero and is skipped; its first charge days later is
  // the one reported. Once per agency, and never fails the webhook.
  await reportFirstPurchase(admin, {
    agencyId,
    transactionId: tx.id,
    total: tx.details?.totals?.total,
    currency: tx.currencyCode,
  });

  // When this event performs the first activation (it usually beats
  // subscription.created), the welcome email goes out here; the later
  // subscription event then sees an active row and skips it. Recovery from
  // past_due/unpaid is deliberately not a "welcome".
  if (row.status === "active" && (!existing || existing.status === "inactive")) {
    await sendWelcomeEmail(admin, {
      agencyId,
      plan: mapped?.plan ?? null,
      interval: mapped?.interval ?? null,
      trial: false,
      renewsAt: null,
    });
  }

  // Affiliate commission for a referred agency's payment, after the billing
  // work above has succeeded. Isolated: it catches and reports its own
  // errors, so it can never fail or endlessly retry this webhook.
  await recordCommission(admin, { agencyId, tx });

  return { ok: true };
}

// ── Attribution ──────────────────────────────────────────────
// customData is the primary link (stamped at checkout). Existing rows are the
// fallback for subscriptions created outside our checkout — e.g. in the Paddle
// dashboard, or when a customer's plan is changed by support.
async function resolveAgencyId(admin: SupabaseClient, facts: SubscriptionFacts): Promise<string | null> {
  if (facts.agencyId) return facts.agencyId;
  return (
    (await agencyBySubscription(admin, facts.subscriptionId)) ??
    (await agencyByCustomer(admin, facts.customerId))
  );
}

async function agencyBySubscription(admin: SupabaseClient, subscriptionId: string): Promise<string | null> {
  const { data } = await admin
    .from("subscriptions")
    .select("agency_id")
    .eq("provider_subscription_id", subscriptionId)
    .maybeSingle();
  return (data?.agency_id as string | undefined) ?? null;
}

async function agencyByCustomer(admin: SupabaseClient, customerId: string): Promise<string | null> {
  const { data } = await admin
    .from("subscriptions")
    .select("agency_id")
    .eq("provider_customer_id", customerId)
    .maybeSingle();
  return (data?.agency_id as string | undefined) ?? null;
}
