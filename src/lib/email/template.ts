// The white-label report email. Table-based HTML with inline styles (the only
// thing email clients render reliably), built entirely from the agency's
// branding — logo, name, color, footer — with no platform branding anywhere.
// Every dynamic value is HTML-escaped; URLs additionally get a scheme check so
// a stored value can't inject a javascript: link.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const safeUrl = (u: string | null | undefined): string | null => {
  const v = (u ?? "").trim();
  return /^https?:\/\//i.test(v) ? v : null;
};

const safeColor = (c: string | null | undefined): string =>
  c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#4f46e5";

export type ReportEmailArgs = {
  agencyName: string;
  brandColor: string;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  clientName: string;
  reportTitle: string;
  periodLabel: string;
  shareUrl: string;
  /** Direct PDF download; omitted → the "Download PDF" link is not rendered. */
  pdfUrl?: string | null;
  /** AI executive summary, shown as the body of the email when present. */
  aiSummary?: string | null;
  /** Custom message from the schedule; takes precedence over the AI summary intro. */
  message?: string | null;
  /** Closing line configured in Email Branding (agencies.email_footer). */
  footerText?: string | null;
};

// ── Subscription welcome ─────────────────────────────────────
// Sent by the Paddle webhook when an agency's subscription first activates.
// This one is Anavyst → agency (our own customer), so platform branding is
// correct here — unlike report emails, which are agency → their client and
// must stay white-label.
export type WelcomeEmailArgs = {
  agencyName: string | null;
  planName: string;
  interval: "monthly" | "quarterly" | null;
  maxClients: number | null;
  /** ISO date of the next charge / trial conversion. */
  renewsAt: string | null;
  trial: boolean;
  trialDays: number;
  dashboardUrl: string;
  billingUrl: string;
};

function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function welcomeEmailHtml(a: WelcomeEmailArgs): string {
  const color = "#4f46e5";
  const hi = a.agencyName ? `Hi ${esc(a.agencyName)},` : "Hi,";
  const day = fmtDay(a.renewsAt);
  const cycle = a.interval === "quarterly" ? "every 3 months" : a.interval === "monthly" ? "monthly" : null;

  const heading = a.trial ? `Your ${a.trialDays}-day free trial has started` : `Your ${esc(a.planName)} plan is active`;
  const renewalLine = a.trial
    ? `Your trial runs for ${a.trialDays} days${day ? ` — your first charge is on ${day}` : ""}. Cancel any time before then from your billing page and you won't be charged.`
    : day && cycle
      ? `You're billed ${cycle}; your next renewal is ${day}. Manage or cancel any time from your billing page.`
      : `Manage or cancel any time from your billing page.`;

  const features = [
    a.maxClients ? `Up to ${a.maxClients} active clients` : null,
    "Unlimited integrations & reports",
    "AI insights on every report",
    "Full white-label branding, PDF exports & scheduled delivery",
  ].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:36px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e9edf2;">
          <tr><td style="background:${color};padding:22px 32px;"><span style="font-size:18px;font-weight:700;color:#ffffff;">Anavyst</span></td></tr>
          <tr><td style="padding:32px;">
            <h1 style="margin:0 0 14px;font-size:20px;line-height:1.35;color:#0f172a;">${heading}</h1>
            <p style="margin:0 0 8px;font-size:15px;color:#0f172a;font-weight:600;">${hi}</p>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#334155;">
              Thanks for choosing Anavyst. Everything is unlocked and ready:
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
              ${features.map((f) => `<tr><td style="padding:3px 0;font-size:14px;color:#334155;">✓&nbsp; ${esc(f)}</td></tr>`).join("")}
            </table>
            <p style="margin:0 0 22px;font-size:13px;line-height:1.6;color:#64748b;">${renewalLine}</p>
            <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:${color};">
              <a href="${esc(a.dashboardUrl)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open your dashboard</a>
            </td></tr></table>
            <p style="margin:16px 0 0;font-size:13px;color:#64748b;">
              Billing details, invoices and plan changes live at <a href="${esc(a.billingUrl)}" style="color:${color};font-weight:600;text-decoration:none;">your billing page</a>.
            </p>
          </td></tr>
          <tr><td style="padding:18px 32px;border-top:1px solid #eef1f5;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#94a3b8;">Anavyst · white-label client reporting on autopilot<br/>Questions? Just reply to this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// ── Team invitation ──────────────────────────────────────────
// A platform email, not a white-label one: it invites someone to join an
// Anavyst workspace, so it carries Anavyst's identity and is sent from
// the platform sender. That also means it does not depend on the agency having
// verified a sending domain — an invite must work on day one.
export type InvitationEmailArgs = {
  agencyName: string;
  /** Who sent it, for the "X invited you" line. Falls back gracefully. */
  inviterEmail: string | null;
  role: "admin" | "member";
  inviteUrl: string;
  expiryDays: number;
};

export function invitationEmailHtml(a: InvitationEmailArgs): string {
  const color = "#4f46e5";
  const agency = esc(a.agencyName);
  const inviter = a.inviterEmail ? esc(a.inviterEmail) : null;
  const url = safeUrl(a.inviteUrl);
  const roleLabel = a.role === "admin" ? "an admin" : "a team member";

  const canDo = [
    "View and manage clients",
    "Connect data sources and run syncs",
    "Generate, schedule and send reports",
    a.role === "admin" ? "Manage workspace settings and teammates" : null,
  ].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:36px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e9edf2;">
          <tr><td style="background:${color};padding:22px 32px;"><span style="font-size:18px;font-weight:700;color:#ffffff;">Anavyst</span></td></tr>
          <tr><td style="padding:32px;">
            <h1 style="margin:0 0 14px;font-size:20px;line-height:1.35;color:#0f172a;">You've been invited to join ${agency}</h1>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#334155;">
              ${inviter ? `${inviter} has invited you` : "You've been invited"} to join
              <strong>${agency}</strong> on Anavyst as ${roleLabel}. Once you accept you'll be able to:
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
              ${canDo.map((f) => `<tr><td style="padding:3px 0;font-size:14px;color:#334155;">✓&nbsp; ${esc(f)}</td></tr>`).join("")}
            </table>
            ${
              url
                ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:${color};">
              <a href="${esc(url)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Accept invitation</a>
            </td></tr></table>
            <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#64748b;">
              Or paste this link into your browser:<br/>
              <span style="color:#334155;word-break:break-all;">${esc(url)}</span>
            </p>`
                : `<p style="margin:0;font-size:14px;color:#b91c1c;">The invitation link could not be generated. Please ask for a new invite.</p>`
            }
            <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#64748b;">
              This invitation expires in ${a.expiryDays} days. It only works for the address it was sent to.
            </p>
          </td></tr>
          <tr><td style="padding:18px 32px;border-top:1px solid #eef1f5;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#94a3b8;">
              Anavyst · white-label client reporting on autopilot<br/>
              Weren't expecting this? You can safely ignore this email — nothing happens until you accept.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function reportEmailHtml(args: ReportEmailArgs): string {
  const color = safeColor(args.brandColor);
  const agency = esc(args.agencyName || "Your Agency");
  const logo = safeUrl(args.logoUrl);
  const website = safeUrl(args.websiteUrl);
  const share = safeUrl(args.shareUrl) ?? "#";
  const pdf = safeUrl(args.pdfUrl);

  const greeting = `Hi ${esc(args.clientName)},`;
  const intro = args.message
    ? esc(args.message.trim())
    : `Your latest performance report is ready — here's how things looked over ${esc(args.periodLabel)}.`;

  // The AI summary is plain text from our own generation pipeline; escape it
  // and keep it to a readable length for an email body.
  const summary = (args.aiSummary ?? "").trim();
  const summaryBlock = summary
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td style="background:#f8fafc;border:1px solid #e9edf2;border-left:4px solid ${color};border-radius:10px;padding:16px 18px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;">Summary</p>
          <p style="margin:0;font-size:14px;line-height:1.65;color:#334155;">${esc(summary.length > 700 ? `${summary.slice(0, 699)}…` : summary)}</p>
        </td></tr>
      </table>`
    : "";

  const header = logo
    ? `<img src="${esc(logo)}" alt="${agency}" height="36" style="display:block;max-height:36px;width:auto;border:0;" />`
    : `<span style="font-size:18px;font-weight:700;color:#ffffff;">${agency}</span>`;

  const pdfLink = pdf
    ? `<p style="margin:14px 0 0;font-size:13px;color:#64748b;">
         Prefer a file? <a href="${esc(pdf)}" style="color:${color};font-weight:600;text-decoration:none;">Download the PDF</a>
         &nbsp;·&nbsp; it's also attached to this email.
       </p>`
    : `<p style="margin:14px 0 0;font-size:13px;color:#64748b;">The full report is also attached to this email as a PDF.</p>`;

  const footerBits = [
    args.footerText ? esc(args.footerText.trim()) : null,
    website ? `<a href="${esc(website)}" style="color:#94a3b8;text-decoration:underline;">${esc(website.replace(/^https?:\/\//i, ""))}</a>` : null,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${esc(args.reportTitle)} — ${esc(args.periodLabel)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:36px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e9edf2;">
          <tr><td style="background:${color};padding:22px 32px;">${header}</td></tr>
          <tr><td style="padding:32px 32px 8px;">
            <h1 style="margin:0 0 4px;font-size:20px;line-height:1.35;color:#0f172a;">${esc(args.reportTitle)}</h1>
            <p style="margin:0 0 20px;font-size:13px;color:#64748b;">${esc(args.periodLabel)}</p>
            <p style="margin:0 0 10px;font-size:15px;color:#0f172a;font-weight:600;">${greeting}</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#334155;">${intro}</p>
            ${summaryBlock}
            <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:${color};">
              <a href="${esc(share)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">View your report</a>
            </td></tr></table>
            ${pdfLink}
          </td></tr>
          <tr><td style="padding:22px 32px 28px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">If the button doesn't work, copy this link:<br/><span style="color:#64748b;word-break:break-all;">${esc(share)}</span></p>
          </td></tr>
          <tr><td style="padding:18px 32px;border-top:1px solid #eef1f5;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#94a3b8;">
              Prepared by <span style="font-weight:600;color:#64748b;">${agency}</span>${footerBits.length ? `<br/>${footerBits.join(" &nbsp;·&nbsp; ")}` : ""}
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// ── Reconnect reminder ───────────────────────────────────────
// Anavyst → agency (a platform email, like the welcome email): saved sign-ins
// that need a fresh sign-in soon, so a report doesn't silently stop updating.
// Facebook sign-ins last ~60 days and LinkedIn's a year, and neither can be
// renewed without the person signing in again. Sent by the daily sync cron
// (lib/integrations/reconnectReminders.ts), at most once per stage.
export type ReconnectReminderItem = {
  platform: string;
  signedInAs: string | null;
  /** Clients whose reports use this sign-in (names). */
  clients: string[];
  deadline: string;
  stage: "14d" | "3d" | "expired";
  /** Set when the sign-in is a client's own (connect link): they reconnect it. */
  clientOwnedBy: string | null;
  actionUrl: string;
};

export type ReconnectReminderArgs = { agencyName: string | null; items: ReconnectReminderItem[]; dashboardUrl: string };

export function reconnectReminderEmailHtml(a: ReconnectReminderArgs): string {
  const color = "#4f46e5";
  const hi = a.agencyName ? `Hi ${esc(a.agencyName)},` : "Hi,";
  const anyExpired = a.items.some((i) => i.stage === "expired");
  const intro = anyExpired
    ? "One or more of your data connections has expired, so the reports that use it have stopped updating. Reconnect to resume syncing:"
    : "These data connections need a fresh sign-in soon. The platform doesn't let them renew on their own, so reconnect before the date to keep your clients' reports updating:";

  const clientsText = (names: string[]) =>
    names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;

  const rows = a.items
    .map((i) => {
      const day = fmtDay(i.deadline) ?? "";
      const when = i.stage === "expired" ? `Expired on ${esc(day)}` : `Reconnect by ${esc(day)}`;
      const who = i.signedInAs ? ` · signed in as ${esc(i.signedInAs)}` : "";
      const used = i.clients.length ? `Used for ${esc(clientsText(i.clients))}` : "";
      const action = i.clientOwnedBy
        ? `This is ${esc(i.clientOwnedBy)}'s own sign-in. Send them a new connect link from their Data sources tab.`
        : "";
      const button = i.clientOwnedBy ? "Open data sources" : "Reconnect";
      const url = safeUrl(i.actionUrl) ?? a.dashboardUrl;
      return `<tr><td style="padding:14px 0;border-top:1px solid #eef1f5;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${esc(i.platform)}<span style="font-weight:400;color:#64748b;">${who}</span></p>
        <p style="margin:4px 0 0;font-size:13px;color:${i.stage === "14d" ? "#334155" : "#b45309"};font-weight:600;">${when}</p>
        ${used ? `<p style="margin:4px 0 0;font-size:13px;color:#64748b;">${used}</p>` : ""}
        ${action ? `<p style="margin:4px 0 0;font-size:13px;color:#64748b;">${action}</p>` : ""}
        <p style="margin:10px 0 0;"><a href="${esc(url)}" style="display:inline-block;padding:9px 18px;border-radius:8px;background:${color};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${button}</a></p>
      </td></tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:36px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e9edf2;">
          <tr><td style="background:${color};padding:22px 32px;"><span style="font-size:18px;font-weight:700;color:#ffffff;">Anavyst</span></td></tr>
          <tr><td style="padding:32px;">
            <p style="margin:0 0 8px;font-size:15px;color:#0f172a;font-weight:600;">${hi}</p>
            <p style="margin:0 0 6px;font-size:15px;line-height:1.65;color:#334155;">${intro}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
            <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#64748b;">
              Reconnecting takes a minute and renews the sign-in for every client that uses it.
            </p>
          </td></tr>
          <tr><td style="padding:18px 32px;border-top:1px solid #eef1f5;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#94a3b8;">Anavyst · white-label client reporting on autopilot<br/>Questions? Just reply to this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
