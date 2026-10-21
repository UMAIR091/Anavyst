import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, minimal health check for uptime monitors. Keep job names, heartbeat
// timestamps, and failure details private: they reveal operational internals.
// Returns 200 when healthy, 503 when degraded. Never cached.
export async function GET() {
  const startedAt = Date.now();
  let dbOk = false;
  let cronHealth: "ok" | "degraded" = "ok";
  try {
    const admin = createAdminClient();
    // HEAD count on a tiny system-owned table — fast and independent of tenants.
    const { error } = await admin.from("report_templates").select("id", { count: "exact", head: true }).limit(1);
    dbOk = !error;

    // Expose only an aggregate status publicly; detailed heartbeats stay server-side.
    const staleMs = (Number(process.env.CRON_STALE_HOURS) || 30) * 3600_000;
    const { data: hb, error: heartbeatError } = await admin
      .from("ops_heartbeats")
      .select("last_run_at, ok");
    if (heartbeatError) {
      cronHealth = "degraded";
    } else if ((hb ?? []).some((h: { last_run_at: string | null; ok: boolean | null }) => {
      const last = h.last_run_at ? new Date(h.last_run_at).getTime() : 0;
      return Date.now() - last > staleMs || h.ok === false;
    })) {
      cronHealth = "degraded";
    }
  } catch {
    dbOk = false;
  }

  const body = {
    status: dbOk && cronHealth === "ok" ? "ok" : "degraded",
    checks: { database: dbOk ? "ok" : "fail", crons: cronHealth },
    latencyMs: Date.now() - startedAt,
    time: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: body.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
