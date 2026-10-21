import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndAgency, isAdminRole } from "@/lib/agency";
import { createPortalUrl, PaddleError } from "@/lib/billing/paddle";
import { reconcileMissingSubscription } from "@/lib/billing/reconcile";

export const runtime = "nodejs";

// Redirects to the Paddle customer portal for the agency's subscription.
// Portal links are signed and short-lived, so we mint a fresh one per click
// instead of storing it.
export async function GET(req: Request) {
  const { user, agency, role } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.redirect(new URL("/login", req.url));

  const back = (msg: string) =>
    NextResponse.redirect(new URL(`/dashboard/billing?portal_error=${encodeURIComponent(msg)}`, req.url));
  if (!isAdminRole(role)) return back("Only agency owners and admins can manage billing.");

  const supabase = createClient();
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("provider, provider_customer_id, provider_subscription_id")
    .eq("agency_id", agency.id)
    .maybeSingle();

  if (sub?.provider !== "paddle" || !sub?.provider_customer_id) {
    return back("No subscription to manage yet — choose a plan first.");
  }

  try {
    const url = await createPortalUrl(sub.provider_customer_id, sub.provider_subscription_id);
    return NextResponse.redirect(url);
  } catch (err) {
    const e = err as PaddleError;
    // A 404 means the stored ids are stale. Clear them so the page stops
    // offering "Manage billing" for a subscription that doesn't exist, and so
    // a fresh checkout isn't blocked by the same dead customer id. Written with
    // the service role: tenants can only read subscriptions.
    if (e.notFound) {
      await reconcileMissingSubscription(createAdminClient(), agency.id, "portal: customer not found");
      return back("That subscription no longer exists with our payment provider, so we've reset your billing details. Choose a plan below to subscribe again.");
    }
    return back(e.message);
  }
}
