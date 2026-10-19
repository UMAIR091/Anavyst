// Email module entry point (import path "@/lib/email" is unchanged from the
// old single-file version). Picks the provider, exposes send-with-retry, and
// re-exports the template + sender resolution.
import { resendProvider } from "./resend";
import type { EmailProvider, SendEmailArgs, SendResult } from "./types";

export type { EmailAttachment, SendEmailArgs, DnsRecord, SendingDomain, DomainStatus, EmailProvider } from "./types";
export {
  reportEmailHtml, welcomeEmailHtml, invitationEmailHtml, reconnectReminderEmailHtml,
  type ReportEmailArgs, type WelcomeEmailArgs, type InvitationEmailArgs, type ReconnectReminderArgs, type ReconnectReminderItem,
} from "./template";
export { resolveSender, domainOfEmail, isReservedSendingDomain, type ResolvedSender } from "./sender";

// Provider registry. EMAIL_PROVIDER selects the backend; Resend is the only
// implementation today, so anything else falls back to it loudly.
const PROVIDERS: Record<string, EmailProvider> = {
  resend: resendProvider,
};

export function emailProvider(): EmailProvider {
  const id = (process.env.EMAIL_PROVIDER ?? "resend").toLowerCase();
  const provider = PROVIDERS[id];
  if (!provider) {
    console.warn(`Unknown EMAIL_PROVIDER "${id}" — using resend.`);
    return resendProvider;
  }
  return provider;
}

// Whether email delivery is switched on. When false, callers surface a clear
// "email not configured" message instead of attempting to send. EMAIL_FROM is
// required because it is the guaranteed fallback sender.
export function emailConfigured(): boolean {
  return emailProvider().isConfigured() && Boolean(process.env.EMAIL_FROM);
}

export async function sendEmail(args: SendEmailArgs): Promise<SendResult> {
  return emailProvider().send(args);
}

// Sends with simple exponential backoff. Returns the attempt count alongside
// the result so callers can record it in the delivery log. Throws after the
// last attempt; the caller records the failure.
export async function sendEmailWithRetry(
  args: SendEmailArgs,
  maxAttempts = 3
): Promise<{ id: string; attempts: number; duplicate?: boolean }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { id, duplicate } = await sendEmail(args);
      return { id, attempts: attempt, ...(duplicate ? { duplicate } : {}) };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Email send failed");
}
