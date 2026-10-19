import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cronAuthorized } from "@/lib/cronAuth";
import { dispatchSyncBatch, dispatchConfig } from "@/lib/syncDispatch";
import { logRouteError } from "@/lib/errorLog";
import { reconcileLiveSubscriptions } from "@/lib/billing/reconcile";
import { purgeStaleAdAttribution } from "@/lib/metaCapi";
import { sendReconnectReminders } from "@/lib/integrations/reconnectReminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sync DISPATCHER (perf audit P0). Atomically claims a large batch of the stalest
// sources and fans them out to parallel worker invocations (see
// lib/syncDispatch.ts), so throughput scales horizontally instead of being
// capped by a single function's 60s budget. Safe to run concurrently — claiming
// is atomic (FOR UPDATE SKIP LOCKED) and fairly ordered by staleness. Tune with
// SYNC_DISPATCH_LIMIT (sources per tick) and SYNC_CHUNK_SIZE (sources per
// worker); raise the cron frequency on a plan that allows it.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  const admin = createAdminClient();
  try {
    const result = await dispatchSyncBatch(admin, baseUrl, secret);

    // Billing drift sweep: Paddle is the source of truth, and a lost webhook
    // must not leave paid access running (see reconcileLiveSubscriptions).
    const billing = await reconcileLiveSubscriptions(admin).catch(() => ({ checked: 0, changed: 0 }));

    // "Reconnect by" emails for sign-ins that can't renew on their own
    // (migration 0052). After the sync, so a sign-in just renewed isn't
    // reminded about. Best-effort: never fails the run.
    const reminders = await sendReconnectReminders(admin, baseUrl).catch((err) => {
      console.error(`reconnect reminders failed: ${(err as Error).message}`);
      return { agencies: 0, reminders: 0, failed: 1 };
    });

    // Heartbeat (uptime monitoring) + best-effort housekeeping.
    // Record what actually happened, not just what was claimed: a worker that
    // never reports back leaves the claim stamped and the sources untouched, so
    // "claimed 7" alone reads identically to a healthy run and a silent
    // fan-out failure can go unnoticed for days.
    //
    // Awaited: fired-and-forgotten, the function could return and be frozen
    // before the write landed — the 28 Sep run synced every source yet left
    // no heartbeat, so /api/health reported the job stale.
    await Promise.allSettled([
      admin.rpc("record_heartbeat", {
        p_job: "sync",
        p_ok: result.failed === 0,
        p_detail: `claimed ${result.claimed} synced ${result.synced} failed ${result.failed} · billing checked ${billing.checked} fixed ${billing.changed} · reminders ${reminders.reminders} to ${reminders.agencies}`,
      }),
      admin.rpc("purge_rate_limits"),
      purgeStaleAdAttribution(admin),
    ]);

    return NextResponse.json({ ok: true, ...dispatchConfig(), ...result, billing, reminders });
  } catch (err) {
    const message = await logRouteError("cron", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
