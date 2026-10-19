import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Copy, ShieldCheck, AlertTriangle } from "lucide-react";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { createClient } from "@/lib/supabase/server";
import { getIntegration } from "@/lib/integrations/registry";
import { duplicatesOf } from "@/lib/integrations/connections";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { IntegrationConfig } from "@/lib/integrations/types";

export const dynamic = "force-dynamic";

type Conn = {
  id: string;
  client_id: string | null;
  identity_provider: string | null;
  display_name: string | null;
  subject_hash: string | null;
  status: string;
  created_at: string;
};
type Use = { id: string; client_id: string | null; connection_id: string; config: IntegrationConfig | null };

// Shown after signing in with a login the workspace already has a saved
// sign-in for. The new sign-in is already saved and working for this client
// ("keep both"), so leaving the page loses nothing. The other choices end
// with one sign-in (POST /api/connections/merge, which checks all of this
// again). Everything here is read as the user (RLS), and no tokens are read.
export default async function ReviewSignInPage(props: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ clientId?: string; connection?: string }>;
}) {
  const [{ type }, { clientId, connection }] = await Promise.all([props.params, props.searchParams]);
  const { user } = await getCurrentUserAndAgency();
  if (!user) redirect("/login");
  const def = getIntegration(type);
  if (!def || !clientId || !connection) notFound();

  const supabase = createClient();
  const [{ data: client }, { data: connRows }, { data: useRows }] = await Promise.all([
    supabase.from("clients").select("id, name").eq("id", clientId).maybeSingle(),
    supabase
      .from("connections")
      .select("id, client_id, identity_provider, display_name, subject_hash, status, created_at")
      .eq("type", def.id),
    supabase.from("data_sources").select("id, client_id, connection_id, config").eq("type", def.id).not("connection_id", "is", null),
  ]);
  if (!client) notFound();
  const conns = (connRows ?? []) as Conn[];
  const fresh = conns.find((c) => c.id === connection);
  const doneHref = `/dashboard/clients/${client.id}/data-sources?connected=${def.id}`;
  if (!fresh) redirect(doneHref);

  const matches = duplicatesOf(fresh, conns);
  if (matches.length === 0) redirect(doneHref);

  const uses = (useRows ?? []) as Use[];
  const freshAccounts = new Map<string, string>();
  for (const u of uses.filter((u) => u.connection_id === fresh.id)) {
    for (const a of def.readAccounts?.(u.config ?? {}) ?? []) freshAccounts.set(a.id, a.name);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-[clamp(24px,3vw,28px)] font-semibold tracking-[-0.03em] text-ink-900">
        You already have this {def.name} sign-in
      </h1>
      <p className="mt-1 text-sm text-ink-500">
        {fresh.display_name ?? "This login"} is connected for <span className="font-medium text-ink-700">{client.name}</span>. It
        looks like a sign-in your workspace has already saved. Choose how to keep them.
      </p>

      {matches.map((m) => {
        const saved = conns.find((c) => c.id === m.id)!;
        const clientsOnSaved = new Set(uses.filter((u) => u.connection_id === saved.id).map((u) => u.client_id)).size;
        // Accounts the saved sign-in's clients report on that the new sign-in
        // didn't list: renewing would cut those clients off.
        const missing = [
          ...new Set(
            uses
              .filter((u) => u.connection_id === saved.id)
              .map((u) => {
                const id = def.readSelected?.(u.config ?? {}) ?? null;
                if (!id || freshAccounts.has(id)) return null;
                return def.readAccounts?.(u.config ?? {}).find((a) => a.id === id)?.name ?? id;
              })
              .filter((n): n is string => Boolean(n))
          ),
        ];
        const canRenew = m.strong && missing.length === 0;
        const canReuse = saved.status !== "revoked";

        return (
          <Card key={m.id} className="mt-6">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                <Copy size={16} className="text-brand-600" /> Saved sign-in: {saved.display_name ?? `${def.name} sign-in`}
              </div>
              <p className="mt-1 text-sm text-ink-500">
                Used by {clientsOnSaved} client{clientsOnSaved === 1 ? "" : "s"}
                {saved.status === "revoked" ? " · expired" : ""}.
              </p>
              <p className="mt-3 flex items-start gap-2 text-sm text-ink-600">
                {m.strong ? (
                  <>
                    <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success-600" />
                    <span>{def.name} confirms this is the same login.</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-600" />
                    <span>
                      Only the name matches. {def.name} doesn&apos;t give us a way to confirm it&apos;s the same login, so
                      the two can&apos;t be combined into one. You can still use the saved one for {client.name}.
                    </span>
                  </>
                )}
              </p>

              <div className="mt-5 space-y-3">
                {m.strong && (
                  <form action="/api/connections/merge" method="post" className="rounded-xl border border-ink-200 p-4">
                    <input type="hidden" name="clientId" value={client.id} />
                    <input type="hidden" name="from" value={fresh.id} />
                    <input type="hidden" name="into" value={saved.id} />
                    <input type="hidden" name="mode" value="renew" />
                    <p className="text-sm font-medium text-ink-900">Renew the saved sign-in with this one</p>
                    <p className="mt-0.5 text-sm text-ink-500">
                      One sign-in for everyone: its {clientsOnSaved} client{clientsOnSaved === 1 ? "" : "s"} and {client.name}{" "}
                      use the login you just signed in with.
                    </p>
                    {missing.length > 0 && (
                      <p className="mt-2 text-xs text-warning-700">
                        Not available: this login can&apos;t reach {missing.slice(0, 3).map((n) => `“${n}”`).join(", ")}
                        {missing.length > 3 ? ` and ${missing.length - 3} more` : ""}, which the saved sign-in is used for.
                      </p>
                    )}
                    <Button type="submit" size="sm" className="mt-3" disabled={!canRenew}>
                      Renew and combine
                    </Button>
                  </form>
                )}

                <form action="/api/connections/merge" method="post" className="rounded-xl border border-ink-200 p-4">
                  <input type="hidden" name="clientId" value={client.id} />
                  <input type="hidden" name="from" value={fresh.id} />
                  <input type="hidden" name="into" value={saved.id} />
                  <input type="hidden" name="mode" value="reuse" />
                  <p className="text-sm font-medium text-ink-900">Use the saved sign-in for {client.name}</p>
                  <p className="mt-0.5 text-sm text-ink-500">
                    The sign-in you just made is removed. {client.name}&apos;s {def.accountNoun} must be one the saved
                    sign-in can reach; that&apos;s checked first.
                  </p>
                  {!canReuse && <p className="mt-2 text-xs text-warning-700">Not available: the saved sign-in has expired.</p>}
                  <Button type="submit" size="sm" variant="outline" className="mt-3" disabled={!canReuse}>
                    Use the saved sign-in
                  </Button>
                </form>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">Or keep both sign-ins. Both work, and you can combine them later.</p>
        <Button asChild>
          <Link href={doneHref}>Keep both</Link>
        </Button>
      </div>
    </div>
  );
}
