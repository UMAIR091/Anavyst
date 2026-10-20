// The connection activity log (migration 0053): one row per thing that
// happened to a saved sign-in or data source. Written with the service role,
// best-effort: a logging failure never fails the action it describes.
//
// Never pass tokens or secrets in `detail`. It is for ids, names, the sign-in
// route and counts; values that look like secrets are dropped regardless.
import { createAdminClient } from "@/lib/supabase/admin";

export type ConnectionAction =
  | "connect"
  | "reconnect"
  | "client_connect"
  | "attach"
  | "select_account"
  | "combine"
  | "reuse"
  | "disconnect"
  | "remove_sign_in"
  | "revoke_at_provider"
  | "expired"
  | "deauthorized"
  | "data_deleted"
  | "store_uninstalled"
  | "store_data_deleted";

export type ConnectionEvent = {
  agencyId: string;
  action: ConnectionAction;
  actor?: "user" | "client" | "provider" | "system";
  outcome?: "ok" | "failed";
  connectionId?: string | null;
  dataSourceId?: string | null;
  clientId?: string | null;
  userId?: string | null;
  platform?: string | null;
  detail?: Record<string, string | number | boolean | null | string[]>;
};

const SECRET_KEY = /token|secret|password|key|code/i;

// Keeps the detail to plain, non-secret values.
export function cleanDetail(detail: ConnectionEvent["detail"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => String(x).slice(0, 120));
    else out[k] = v;
  }
  return out;
}

export async function logConnectionEvent(e: ConnectionEvent): Promise<void> {
  try {
    await createAdminClient()
      .from("connection_events")
      .insert({
        agency_id: e.agencyId,
        action: e.action,
        actor: e.actor ?? "user",
        outcome: e.outcome ?? "ok",
        connection_id: e.connectionId ?? null,
        data_source_id: e.dataSourceId ?? null,
        client_id: e.clientId ?? null,
        user_id: e.userId ?? null,
        platform: e.platform ?? null,
        detail: cleanDetail(e.detail),
      });
  } catch (err) {
    console.error(`connection event not recorded (${e.action}): ${(err as Error).message}`);
  }
}
