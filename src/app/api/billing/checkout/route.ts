import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndAgency, isAdminRole } from "@/lib/agency";
import { billingConfigured, findPrice, trialPricingConfigured, PAID_TRIAL_DAYS, BILLING_INTERVALS, normalizeInterval, type BillingInterval, type PlanId } from "@/lib/billing/config";
import { usableTrialPriceId, standardPriceStartsTrial } from "@/lib/billing/prices";
import { createCheckoutSession, PaddleError } from "@/lib/billing/paddle";
import { checkTrialEligibility } from "@/lib/billing/trial";
import { captureAdAttribution } from "@/lib/metaCapi";

export const runtime = "nodejs";

const INTERVALS: BillingInterval[] = BILLING_INTERVALS;

// Side-effect-free probe used by the public pricing page to decide where a
// plan button should lead: straight to the dashboard checkout for a signed-in
// customer, or through signup first. Deliberately creates nothing — probing
// with POST would litter Paddle with abandoned transactions.
export async function GET() {
  const { user, agency } = await getCurrentUserAndAgency().catch(() => ({ user: null, agency: null }));
  return NextResponse.json(
    {
      authenticated: Boolean(user && agency),
      configured: billingConfigured(),
      // Whether trial-enabled prices are configured in this runtime. Public
      // and harmless (a boolean, no ids) — and the only direct way to see
      // what the deployed environment actually resolves, which matters
      // because static pages bake this at build time where it can't be
      // observed after the fact.
      trialConfigured: trialPricingConfigured(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// Creates a Paddle transaction for the requested plan + interval and returns
// the ids Paddle.js needs to open the checkout overlay.
//
// The price is resolved server-side from our catalog, so the browser never
// chooses what it is buying — it only opens the transaction we created. The
// agency id is stamped into customData so every downstream webhook can be
// attributed even if the user closes the tab mid-payment.
export async function POST(req: Request) {
  const { user, agency, role } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(role)) {
    return NextResponse.json({ error: "Only agency owners and admins can manage billing." }, { status: 403 });
  }

  if (!billingConfigured()) {
    return NextResponse.json(
      { error: "Billing isn't configured yet. Set PADDLE_API_KEY, PADDLE_CLIENT_TOKEN and the PADDLE_PRICE_* variables." },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => null)) as { plan?: string; interval?: string } | null;
  const plan = body?.plan as PlanId | undefined;
  // Legacy "annual" callers (a bookmarked /signup?interval=annual link, a stale
  // cached page) resolve to the quarterly plan rather than failing the request.
  const interval = normalizeInterval(body?.interval);
  if (!plan || !interval || !INTERVALS.includes(interval)) {
    return NextResponse.json({ error: "plan and interval (monthly/quarterly) are required." }, { status: 400 });
  }

  const priceId = findPrice(plan, interval);
  if (!priceId) return NextResponse.json({ error: "That plan isn't available." }, { status: 400 });

  // Reuse the existing Paddle customer when we have one, so a returning
  // customer keeps a single billing identity instead of spawning duplicates.
  // Everything checkout needs to decide is read in parallel: the database is
  // a cross-region round trip away, and doing these one after another was
  // most of the wait between the click and Paddle's payment form. The trial
  // lookups read the cached catalog and are harmless if the 409 below wins.
  const supabase = createClient();
  const [{ data: sub }, trialPriceId, standardTrial, eligibility] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("provider_customer_id, provider, provider_subscription_id, status")
      .eq("agency_id", agency.id)
      .maybeSingle(),
    usableTrialPriceId(plan, interval),
    standardPriceStartsTrial(plan, interval),
    checkTrialEligibility(createAdminClient(), { agencyId: agency.id, email: user.email }),
  ]);

  // An agency that already has a live subscription must change plan through
  // the subscription route, otherwise Paddle would bill two subscriptions.
  const LIVE = new Set(["active", "on_trial", "past_due", "paused"]);
  if (sub?.provider_subscription_id && LIVE.has(sub.status as string)) {
    return NextResponse.json(
      { error: "You already have an active subscription. Use Change plan instead.", code: "already_subscribed" },
      { status: 409 }
    );
  }

  const customerId = sub?.provider === "paddle" ? sub.provider_customer_id : null;

  // Trial selection. Paddle attaches trials to the price, so "first paid
  // subscription gets N days free" is expressed by checking out a different
  // price id. Eligibility is read with the admin client because the ledger is
  // keyed on email across agencies — an RLS-scoped read would make a fresh
  // agency reusing an old email look eligible.
  // The id is verified against the live Paddle catalog before use: an archived
  // trial price is rejected at transaction time, so checking out on one would
  // turn "start your trial" into a hard failure to buy.
  let usedTrial = false;
  let checkoutPriceId = priceId;

  if (trialPriceId && eligibility.eligible) {
    checkoutPriceId = trialPriceId;
    usedTrial = true;
  }

  // The plan's own price can carry a trial period, in which case Paddle starts
  // the subscription in `trialing` whichever price was chosen. Report what the
  // customer will actually experience rather than what we intended to offer.
  if (!usedTrial && standardTrial) usedTrial = true;

  try {
    // Ad attribution is stored alongside, never in series: it only reads this
    // request and can't fail the checkout (lib/metaCapi.ts).
    const [session] = await Promise.all([
      createCheckoutSession({
        priceId: checkoutPriceId,
        agencyId: agency.id,
        email: user.email,
        customerId,
      }),
      captureAdAttribution(createAdminClient(), agency.id),
    ]);
    // `trial` tells the client what it just opened, so the UI can say
    // "3 days free, then $X" instead of guessing.
    return NextResponse.json({ ...session, trial: usedTrial, trialDays: usedTrial ? PAID_TRIAL_DAYS : 0 });
  } catch (err) {
    const e = err as PaddleError;
    console.error("Paddle checkout failed:", e.message);
    return NextResponse.json({ error: e.message }, { status: e.status ?? 502 });
  }
}
