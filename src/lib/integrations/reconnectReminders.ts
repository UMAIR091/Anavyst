// "Reconnect by" emails to agencies (migration 0052).
//
// Some sign-ins can't be renewed without the person signing in again:
// Facebook Login tokens (~60 days, Meta Ads and Instagram through Facebook)
// and LinkedIn once its refresh token's fixed year runs out. The cards and
// the health page warn 14 days ahead, but an agency that doesn't open
// Anavyst would only find out when its clients' reports stopped updating.
// So once a day, after the sync, each agency gets one email listing its
// sign-ins that are due: 14 days before, 3 days before, and once just after
// the date. Each (sign-in, deadline, stage) is sent at most once, and a
// reconnect sets a new deadline. Sign-ins that only serve archived clients
// are skipped (those clients are paused anyway).
import type { SupabaseClient } from "@supabase/supabase-js";
import { getIntegration } from "./registry";
import { signInDeadline } from "./tokenRenewal";
import { agencyContact } from "@/lib/agencyContact";
import { emailConfigured, sendEmailWithRetry, reconnectReminderEmailHtml, type ReconnectReminderItem } from "@/lib/email";

export type ReminderStage = "14d" | "3d" | "expired";

const DAY_MS = 24 * 60 * 60 * 1000;
// More urgent stages come later; once one is sent, earlier ones aren't.
const STAGES: ReminderStage[] = ["14d", "3d", "expired"];

// Which reminder a deadline calls for now, if any. "expired" only in the
// week after the date, so a long-dead sign-in isn't announced out of nowhere.
export function reminderStage(deadline: string, now: number = Date.now()): ReminderStage | null {
  const left = new Date(deadline).getTime() - now;
  if (Number.isNaN(left)) return null;
  if (left <= 0) return left > -7 * DAY_MS ? "expired" : null;
  if (left <= 3 * DAY_MS) return "3d";
  if (left <= 14 * DAY_MS) return "14d";
  return null;
}

type SignIn = {
  id: string;
  agency_id: string;
  type: string;
  client_id: string | null;
  identity_provider: string | null;
  display_name: string | null;
  token_expires_at: string | null;
  refresh_expires_at: string | null;
};

export type DueReminder = ReconnectReminderItem & { connectionId: string; agencyId: string };

// Every reminder due now, across all agencies. Service role.
export async function dueReminders(admin: SupabaseClient, appUrl: string, now: number = Date.now()): Promise<DueReminder[]> {
  const { data: signIns, error } = await admin
    .from("connections")
    .select("id, agency_id, type, client_id, identity_provider, display_name, token_expires_at, refresh_expires_at");
  if (error) throw new Error(error.message);

  const candidates = ((signIns ?? []) as SignIn[])
    .map((s) => {
      const deadline = signInDeadline(
        {
          type: s.type,
          config: { identity_provider: s.identity_provider ?? undefined },
          token_expires_at: s.token_expires_at,
          refresh_expires_at: s.refresh_expires_at,
        },
        now
      );
      const stage = deadline ? reminderStage(deadline, now) : null;
      return deadline && stage ? { s, deadline, stage } : null;
    })
    .filter((c): c is { s: SignIn; deadline: string; stage: ReminderStage } => c !== null);
  if (!candidates.length) return [];

  const ids = candidates.map((c) => c.s.id);
  const [{ data: uses }, { data: sent }] = await Promise.all([
    admin.from("data_sources").select("connection_id, client_id").in("connection_id", ids),
    admin.from("connection_reminders").select("connection_id, deadline, stage").in("connection_id", ids),
  ]);
  const useRows = (uses ?? []) as { connection_id: string; client_id: string | null }[];
  const clientIds = [...new Set(useRows.map((u) => u.client_id).filter((id): id is string => Boolean(id)))];
  const { data: clientRows } = clientIds.length
    ? await admin.from("clients").select("id, name, archived").in("id", clientIds)
    : { data: [] };
  const clients = new Map(((clientRows ?? []) as { id: string; name: string | null; archived: boolean | null }[]).map((c) => [c.id, c]));
  const sentRows = (sent ?? []) as { connection_id: string; deadline: string; stage: ReminderStage }[];

  const out: DueReminder[] = [];
  for (const { s, deadline, stage } of candidates) {
    const at = new Date(deadline).getTime();
    const already = sentRows.filter((r) => r.connection_id === s.id && new Date(r.deadline).getTime() === at);
    // This stage, or a more urgent one, already went out for this deadline.
    if (already.some((r) => STAGES.indexOf(r.stage) >= STAGES.indexOf(stage))) continue;

    const active = useRows
      .filter((u) => u.connection_id === s.id && u.client_id)
      .map((u) => clients.get(u.client_id!))
      .filter((c): c is { id: string; name: string | null; archived: boolean | null } => Boolean(c) && c!.archived !== true);
    if (!active.length) continue;

    const def = getIntegration(s.type);
    const owner = s.client_id ? clients.get(s.client_id) ?? null : null;
    out.push({
      connectionId: s.id,
      agencyId: s.agency_id,
      platform: def?.name ?? s.type,
      signedInAs: s.display_name,
      clients: [...new Set(active.map((c) => c.name ?? "a client"))],
      deadline,
      stage,
      clientOwnedBy: s.client_id ? owner?.name ?? "the client" : null,
      // The connect screen lists this saved sign-in with its Reconnect button;
      // a client's own sign-in is renewed through a new connect link instead.
      actionUrl: s.client_id
        ? `${appUrl}/dashboard/clients/${s.client_id}/data-sources`
        : `${appUrl}/dashboard/connect/${s.type}?clientId=${active[0].id}`,
    });
  }
  return out;
}

function subjectFor(items: DueReminder[]): string {
  if (items.length === 1) {
    const i = items[0];
    return i.stage === "expired"
      ? `Your ${i.platform} connection has expired`
      : `Reconnect ${i.platform} to keep your reports updating`;
  }
  return items.some((i) => i.stage === "expired")
    ? `${items.length} data connections need attention`
    : `${items.length} data connections need reconnecting soon`;
}

// Sends the due reminders: one email per agency, then records each so it
// isn't sent again. Best-effort per agency: one failure doesn't stop the rest.
export async function sendReconnectReminders(
  admin: SupabaseClient,
  appUrl: string,
  now: number = Date.now()
): Promise<{ agencies: number; reminders: number; failed: number; skipped?: string }> {
  if (!emailConfigured()) return { agencies: 0, reminders: 0, failed: 0, skipped: "email not configured" };
  const due = await dueReminders(admin, appUrl, now);
  const byAgency = new Map<string, DueReminder[]>();
  for (const d of due) byAgency.set(d.agencyId, [...(byAgency.get(d.agencyId) ?? []), d]);

  const day = new Date(now).toISOString().slice(0, 10);
  let agencies = 0;
  let reminders = 0;
  let failed = 0;
  for (const [agencyId, items] of byAgency) {
    try {
      const { email, name } = await agencyContact(admin, agencyId);
      if (!email) continue;
      const subject = subjectFor(items);
      const from = (process.env.EMAIL_FROM ?? "").trim();
      const html = reconnectReminderEmailHtml({ agencyName: name, items, dashboardUrl: `${appUrl}/dashboard` });
      const { id, attempts } = await sendEmailWithRetry(
        { from, to: email, subject, html, idempotencyKey: `reconnect:${agencyId}:${day}` },
        2
      );

      await admin.from("connection_reminders").insert(
        items.map((i) => ({ connection_id: i.connectionId, deadline: i.deadline, stage: i.stage, agency_id: agencyId }))
      );
      const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
      await admin.from("email_logs").insert({
        agency_id: agencyId,
        report_id: null,
        to_email: email,
        subject,
        status: "sent",
        provider_id: id,
        attempts,
        from_email: fromEmail,
        from_domain: fromEmail.slice(fromEmail.lastIndexOf("@") + 1).toLowerCase(),
        sent_at: new Date(now).toISOString(),
      });
      agencies += 1;
      reminders += items.length;
    } catch (err) {
      failed += 1;
      console.error(`reconnect reminder failed for agency ${agencyId}: ${(err as Error).message}`);
    }
  }
  return { agencies, reminders, failed };
}
