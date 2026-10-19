import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/LegalShell";
import { COMPANY, LEGAL_LAST_UPDATED } from "@/lib/company";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = {
  title: `Data Deletion Request — ${COMPANY.product}`,
  description: `How to delete the data ${COMPANY.product} stores about you or your clients — instantly in the app, or in full by request.`,
};

// The status of a request Meta sent us (/api/meta/data-deletion answers Meta
// with this page's URL and a confirmation code). The code is the only lookup
// key, and the page shows nothing but what was deleted and when.
async function deletionStatus(code: string | undefined) {
  if (!code || !/^[A-Za-z0-9_-]{6,40}$/.test(code)) return null;
  const { data } = await createAdminClient()
    .from("meta_deletion_requests")
    .select("code, sign_ins_deleted, sources_deleted, created_at")
    .eq("code", code)
    .maybeSingle();
  return data ? { found: true as const, ...data } : { found: false as const, code };
}

// Publicly accessible data-deletion instructions. This URL doubles as the
// "Data Deletion Instructions URL" required in Meta App settings and supports
// Google verification review — keep it reachable without sign-in.
export default async function DataDeletionPage(props: { searchParams: Promise<{ code?: string }> }) {
  const status = await deletionStatus((await props.searchParams).code);
  return (
    <LegalShell
      title="Data Deletion Request"
      subtitle="Delete integration data instantly in the app, or request full account deletion."
      lastUpdated={LEGAL_LAST_UPDATED}
    >
      {status && (
        <div className="not-prose mb-8 rounded-xl border border-ink-200 bg-surface-subtle px-4 py-3 text-sm text-ink-700">
          {status.found ? (
            <>
              <p className="font-semibold text-ink-900">Request {status.code}: completed</p>
              <p className="mt-1">
                Received {new Date(status.created_at as string).toUTCString()}. Deleted at once: {status.sign_ins_deleted}{" "}
                saved sign-in{status.sign_ins_deleted === 1 ? "" : "s"} and {status.sources_deleted} connected data source
                {status.sources_deleted === 1 ? "" : "s"}, with all data synced through them.
              </p>
            </>
          ) : (
            <p>
              We couldn&apos;t find request {status.code}. If you made it through Facebook or Instagram, check the code, or
              email us at the address below.
            </p>
          )}
        </div>
      )}
      <h2>Option 1 — Delete a connected integration&apos;s data (instant)</h2>
      <p>
        If you connected a data source (Google Search Console, Google Analytics, Meta Ads, or any other integration)
        and want its data removed:
      </p>
      <ol>
        <li>Sign in to {COMPANY.product}.</li>
        <li>
          Go to <Link href="/dashboard/settings/data">Settings → Data &amp; privacy</Link> — every connected source
          across all your clients is listed there.
        </li>
        <li>Click <strong>Disconnect &amp; delete data</strong> on the source you want removed.</li>
      </ol>
      <p>
        This takes effect <strong>immediately</strong> and permanently deletes the stored connection tokens and every
        cached metric snapshot for that source. You can also disconnect from the individual client&apos;s page.
      </p>
      <p>
        We also recommend revoking {COMPANY.product}&apos;s access on the provider side:{" "}
        <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">Google account permissions</a>{" "}
        or{" "}
        <a href="https://www.facebook.com/settings/?tab=business_tools" target="_blank" rel="noopener noreferrer">Facebook business integrations</a>.
      </p>

      <h2>Option 2 — Delete your entire account and all data</h2>
      <p>
        Email <a href={`mailto:${COMPANY.privacyEmail}?subject=Account%20deletion%20request`}>{COMPANY.privacyEmail}</a>{" "}
        from the address you signed up with, with the subject &quot;Account deletion request&quot;. We will:
      </p>
      <ul>
        <li>Verify the request came from the account owner.</li>
        <li>
          Permanently delete your account and everything in it — agency profile, clients, connected data sources and
          their tokens, cached snapshots, generated reports, schedules, and email logs.
        </li>
        <li>Confirm completion by email within <strong>30 days</strong> (usually much sooner).</li>
      </ul>
      <p>
        Billing records required for tax and accounting compliance are retained by our merchant of record (Lemon
        Squeezy) under their own policy.
      </p>

      <h2>If you removed {COMPANY.product} from your Facebook settings</h2>
      <p>
        Removing the app from your Facebook business integrations revokes {COMPANY.product}&apos;s access on Meta&apos;s
        side, but cached report metrics may remain in your {COMPANY.product} workspace. To remove those too, use
        Option 1 above — or Option 2 to erase everything.
      </p>

      <h2>Questions</h2>
      <p>
        See our <Link href="/privacy">Privacy Policy</Link> and{" "}
        <Link href="/security">Data Processing &amp; Security</Link> pages, or contact{" "}
        <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a>.
      </p>
    </LegalShell>
  );
}
