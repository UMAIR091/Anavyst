import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ShieldCheck, Eye, Trash2, ArrowRight, LogIn, Users } from "lucide-react";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { createClient } from "@/lib/supabase/server";
import {
  availableIdentityProviders, getIntegration, isConnectable, signInButton, signInRouteOf,
} from "@/lib/integrations/registry";
import { isPlatformAdmin } from "@/lib/admin";
import { isShareable } from "@/lib/integrations/connections";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { COMPANY, DATA_PROMISE } from "@/lib/company";

export const dynamic = "force-dynamic";

// Pre-OAuth consent screen: explains exactly what data the integration reads,
// why, how it's stored, and how to revoke — before the user is sent to the
// provider's authorization page. Registry-driven, so it works for every
// current and future live integration.
export default async function ConnectConsentPage(
  props: {
    params: Promise<{ type: string }>;
    searchParams: Promise<{ clientId?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const { user } = await getCurrentUserAndAgency();
  if (!user) redirect("/login");

  const def = getIntegration(params.type);
  const clientId = searchParams.clientId;
  // This page's inline rule (live + apikey-or-connectPath) is now the registry's
  // isConnectable, shared with the integrations page and IntegrationCard.
  if (!def || !isConnectable(def) || !clientId) notFound();

  const supabase = createClient();
  const { data: client } = await supabase.from("clients").select("id, name").eq("id", clientId).single();
  if (!client) notFound();

  const continueHref = `${def.connectPath}?clientId=${client.id}&type=${def.id}`;
  const backHref = `/dashboard/clients/${client.id}`;
  // Only the sign-ins this viewer may use (admin-only previews hidden).
  const signInOptions = availableIdentityProviders(def, isPlatformAdmin(user.email));

  // The agency's saved sign-ins for this integration (migration 0046): reuse
  // one for this client, or renew one that expired for every client on it.
  // Both reads are RLS-scoped to the caller's workspace and hold no tokens.
  const shareable = isShareable(def);
  const [{ data: signInRows }, { data: useRows }] = shareable
    ? await Promise.all([
        // A client's own sign-in (made through a connect link, 0048) serves
        // that client only.
        supabase
          .from("connections")
          .select("id, display_name, identity_provider, status")
          .eq("type", def.id)
          .or(`client_id.is.null,client_id.eq.${client.id}`)
          .order("created_at"),
        supabase.from("data_sources").select("connection_id, client_id").eq("type", def.id).not("connection_id", "is", null),
      ])
    : [{ data: [] }, { data: [] }];
  const uses = (useRows ?? []) as { connection_id: string; client_id: string | null }[];
  const currentSignIn = uses.find((u) => u.client_id === client.id)?.connection_id ?? null;
  const savedSignIns = ((signInRows ?? []) as { id: string; display_name: string | null; identity_provider: string | null; status: string }[]).map((s) => {
    const route = signInRouteOf(def, s.identity_provider);
    return {
      ...s,
      clients: uses.filter((u) => u.connection_id === s.id).length,
      isCurrent: s.id === currentSignIn,
      via: route ? route.via ?? route.label.replace(/^Continue with /, "") : null,
      // Renewing goes back through the provider, on the same sign-in route.
      // API-key sign-ins are renewed by entering the key again instead.
      reconnectHref:
        def.authKind === "apikey" || (def.identityProviders?.length && !signInOptions.some((p) => p.id === route?.id))
          ? null
          : `${continueHref}&connection=${s.id}${route ? `&provider=${route.id}` : ""}`,
    };
  });

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-[clamp(24px,3vw,28px)] font-semibold tracking-[-0.03em] text-ink-900">Connect {def.name}</h1>
      <p className="mt-1 text-sm text-ink-500">
        For <span className="font-medium text-ink-700">{client.name}</span> — review what {COMPANY.product} will access
        before continuing.
      </p>

      {savedSignIns.length > 0 && (
        <Card className="mt-6">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <Users size={16} className="text-brand-600" /> Your saved {def.name} sign-ins
            </div>
            <p className="mt-1 text-sm text-ink-500">
              Sign in once, then reuse it for every client whose account you can reach with it. Reconnecting a sign-in
              renews it for all of its clients.
            </p>
            <ul className="mt-4 divide-y divide-ink-100 rounded-xl border border-ink-200">
              {savedSignIns.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {s.display_name ?? `${def.name} sign-in`}
                      {s.via && <span className="font-normal text-ink-500"> · via {s.via}</span>}
                    </p>
                    <p className="text-xs text-ink-500">
                      {s.status === "revoked" ? (
                        <span className="font-medium text-warning-700">Expired: reconnect to keep its clients syncing</span>
                      ) : (
                        <>Used by {s.clients} client{s.clients === 1 ? "" : "s"}{s.isCurrent ? ", including this one" : ""}</>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.status === "revoked" || s.isCurrent ? (
                      s.reconnectHref && (
                        <Button asChild size="sm" variant={s.status === "revoked" ? "default" : "outline"}>
                          <a href={s.reconnectHref}>Reconnect</a>
                        </Button>
                      )
                    ) : (
                      <form action="/api/connections/attach" method="post">
                        <input type="hidden" name="clientId" value={client.id} />
                        <input type="hidden" name="connectionId" value={s.id} />
                        <Button type="submit" size="sm">Use for {client.name}</Button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
            <Eye size={16} className="text-brand-600" /> What we&apos;ll access, and why
          </div>
          <ul className="mt-4 space-y-4">
            {(def.dataAccess ?? []).map((d) => (
              <li key={d.item}>
                <p className="text-sm font-medium text-ink-800">{d.item}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-500">{d.why}</p>
              </li>
            ))}
          </ul>

          <div className="mt-6 space-y-3 border-t border-ink-100 pt-5 text-sm text-ink-600">
            {signInOptions.filter((p) => p.note).map((p) => (
              <p key={p.id} className="flex items-start gap-2">
                <LogIn size={16} className="mt-0.5 shrink-0 text-brand-600" />
                <span>{p.note}</span>
              </p>
            ))}
            <p className="flex items-start gap-2">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success-600" />
              <span>
                Access is <strong>read-only</strong> — {COMPANY.product} can never change anything in your {def.name}{" "}
                account. Connection tokens are encrypted (AES-256-GCM) before storage. {DATA_PROMISE}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Trash2 size={16} className="mt-0.5 shrink-0 text-ink-500" />
              <span>
                You can disconnect at any time from the client&apos;s page or{" "}
                <Link href="/dashboard/settings/data" className="font-medium text-brand-600 hover:underline">
                  Settings → Data &amp; privacy
                </Link>
                , which immediately deletes the stored tokens and all cached data for this source.
              </span>
            </p>
          </div>

          {savedSignIns.length > 0 && (
            <p className="mt-6 text-sm font-medium text-ink-800">Or sign in with another account</p>
          )}
          <div className={`${savedSignIns.length > 0 ? "mt-3" : "mt-6"} flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between`}>
            <p className="text-xs text-ink-500">
              By continuing you agree to our{" "}
              <Link href="/privacy" className="text-brand-600 hover:underline">Privacy Policy</Link> and{" "}
              <Link href="/security" className="text-brand-600 hover:underline">data practices</Link>.
            </p>
            {def.authKind === "apikey" ? (
              /* API-key providers (Klaviyo, CallRail, Ahrefs, Semrush) collect
                 their secret(s) here and POST them — never in a URL. */
              <form action="/api/connect/apikey" method="post" className="flex flex-1 flex-col gap-3 sm:max-w-md">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="type" value={def.id} />
                {(def.connectFields ?? []).map((f) => (
                  <div key={f.name} className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-ink-700" htmlFor={`f-${f.name}`}>{f.label}</label>
                    <input
                      id={`f-${f.name}`}
                      name={f.name}
                      type={f.secret ? "password" : "text"}
                      required
                      autoComplete="off"
                      placeholder={f.placeholder}
                      className="field h-10 w-full"
                    />
                    {f.hint && <p className="text-xs text-ink-500">{f.hint}</p>}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button asChild variant="outline">
                    <Link href={backHref}>Cancel</Link>
                  </Button>
                  <Button type="submit">
                    Connect {def.name} <ArrowRight size={16} />
                  </Button>
                </div>
              </form>
            ) : def.connectField ? (
              /* Providers like Shopify need one extra value (the shop domain)
                 before OAuth can start — collected here, passed to connectPath. */
              <form action={def.connectPath ?? "#"} method="get" className="flex flex-1 flex-col gap-2 sm:max-w-md">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="type" value={def.id} />
                <label className="text-xs font-medium text-ink-700" htmlFor="connect-field">
                  {def.connectField.label}
                </label>
                <input
                  id="connect-field"
                  name={def.connectField.name}
                  required
                  placeholder={def.connectField.placeholder}
                  className="field h-10 w-full"
                />
                {def.connectField.hint && <p className="text-xs text-ink-500">{def.connectField.hint}</p>}
                <div className="flex gap-2">
                  <Button asChild variant="outline">
                    <Link href={backHref}>Cancel</Link>
                  </Button>
                  <Button type="submit">
                    Continue to {def.name} <ArrowRight size={16} />
                  </Button>
                </div>
              </form>
            ) : signInOptions.length ? (
              /* Integrations that accept more than one sign-in identity (e.g.
                 Microsoft Ads: Microsoft or Google) show one button per
                 provider; each passes ?provider= to the connect route. */
              <div className="flex w-full flex-col gap-2 sm:max-w-xs">
                {signInOptions.map((p, i) => {
                  const button = signInButton(p, i);
                  return (
                    <Button key={p.id} asChild variant={button.secondary ? "secondary" : "default"}>
                      <a href={`${continueHref}&provider=${p.id}`}>
                        {button.label} <ArrowRight size={16} />
                      </a>
                    </Button>
                  );
                })}
                <Button asChild variant="outline">
                  <Link href={backHref}>Cancel</Link>
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button asChild variant="outline">
                  <Link href={backHref}>Cancel</Link>
                </Button>
                <Button asChild>
                  <a href={continueHref}>
                    Continue to {def.name} <ArrowRight size={16} />
                  </a>
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
