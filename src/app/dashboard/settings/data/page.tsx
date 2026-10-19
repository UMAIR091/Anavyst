import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Database, ShieldCheck, Plug } from "lucide-react";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { createClient } from "@/lib/supabase/server";
import { getIntegration } from "@/lib/integrations/registry";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { DisconnectSource } from "@/components/DisconnectSource";
import { COMPANY, DATA_PROMISE } from "@/lib/company";
import { getIntegrationName } from "@/lib/integrations/names";

export const dynamic = "force-dynamic";

// Data & privacy: every connected integration across all clients, with a
// disconnect-and-delete action, plus account-deletion contact. This is the
// user-facing data-control page referenced from the legal pages.
export default async function DataPrivacyPage() {
  const { user } = await getCurrentUserAndAgency();
  if (!user) redirect("/login");

  const supabase = createClient();
  const { data: sources } = await supabase
    .from("data_sources")
    .select("id, type, display_name, config, created_at, last_synced_at, clients(name)")
    .order("created_at", { ascending: false });

  const list = sources ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-[clamp(24px,3vw,28px)] font-semibold tracking-[-0.03em] text-ink-900">Data &amp; privacy</h1>
        <p className="mt-1 text-[14.5px] text-ink-500">
          Manage every connection {COMPANY.product} has to your clients&apos; data — and remove them at any time.
        </p>
      </div>

      <Card>
        <CardContent className="flex items-start gap-3 p-5">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-success-600" />
          <p className="text-[13.5px] leading-relaxed text-ink-500">
            {DATA_PROMISE} Disconnecting a source below immediately deletes its stored connection tokens and all
            cached metric data. Read the full details in our{" "}
            <Link href="/privacy" className="font-medium text-brand-600 hover:underline">Privacy Policy</Link> and{" "}
            <Link href="/security" className="font-medium text-brand-600 hover:underline">Data &amp; Security</Link> pages.
          </p>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-[15px] font-semibold text-ink-900">Connected data sources</h2>
        {list.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="No data sources connected"
            description="When you connect integrations for your clients, they'll appear here so you can manage or remove them."
            action={<Button asChild variant="outline"><Link href="/dashboard/integrations">View integrations</Link></Button>}
          />
        ) : (
          <div className="overflow-hidden rounded-card border border-ink-200 bg-surface">
            {list.map((s, i) => {
              const def = getIntegration(s.type);
              // Supabase types to-one joins as arrays; normalize both shapes.
              const joined = s.clients as { name: string } | { name: string }[] | null;
              const clientName = (Array.isArray(joined) ? joined[0]?.name : joined?.name) ?? "Unknown client";
              // Which account, so two accounts of one platform can be told apart.
              const cfg = (s.config ?? {}) as Record<string, unknown>;
              const chosen = def?.readSelected?.(cfg) ?? null;
              const account = chosen ? def?.readAccounts?.(cfg).find((a) => a.id === chosen)?.name ?? chosen : null;
              return (
                <div key={s.id} className={`flex flex-wrap items-center justify-between gap-3 px-[18px] py-[13px] ${i ? "border-t border-ink-100" : ""}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-ink-900">
                        {def?.name ?? getIntegrationName(s.type)}
                        {account && <span className="font-normal text-ink-500"> · {account}</span>}
                      </p>
                      <Badge variant="muted">{clientName}</Badge>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-ink-400">
                      {s.display_name ? `Connected as ${s.display_name} · ` : ""}
                      {s.last_synced_at
                        ? `Last synced ${formatDistanceToNow(new Date(s.last_synced_at), { addSuffix: true })}`
                        : "Not synced yet"}
                    </p>
                  </div>
                  <DisconnectSource dataSourceId={s.id} label={`${def?.name ?? getIntegrationName(s.type)}${account ? ` (${account})` : ""} for ${clientName}`} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Danger zone. */}
      <section aria-labelledby="delete-account" className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-danger-100 bg-surface p-5">
        <div className="flex min-w-[220px] flex-1 items-start gap-3">
          <Database size={18} className="mt-0.5 shrink-0 text-danger-600" />
          <div>
            <h2 id="delete-account" className="text-[15px] font-semibold text-danger-700">Delete your account</h2>
            <p className="mt-1 max-w-md text-[13px] leading-relaxed text-ink-500">
              To permanently delete your account and everything in it — clients, connections, snapshots, and
              reports — email us and we&apos;ll complete it within 30 days.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" className="border-danger-100 text-danger-700 hover:border-danger-600 hover:text-danger-700">
          <a href={`mailto:${COMPANY.privacyEmail}?subject=Account%20deletion%20request`}>Request deletion</a>
        </Button>
      </section>
    </div>
  );
}
