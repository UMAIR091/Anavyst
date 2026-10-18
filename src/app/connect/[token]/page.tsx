import type { Metadata } from "next";
import { CheckCircle2, ShieldCheck, AlertTriangle, ArrowRight } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { getIntegration, signInButton } from "@/lib/integrations/registry";
import { integrationIcon, integrationTint } from "@/components/integrationVisuals";
import { linkSignInOptions, loadConnectLink, type LinkBranding } from "@/lib/connectLinks";
import type { IntegrationConfig } from "@/lib/integrations/types";

export const dynamic = "force-dynamic";

// A client connect link (migration 0048): the agency's client opens this on
// their own phone or laptop and connects their own accounts. No Anavyst login;
// the link is the authorization. The page carries the agency's branding, and
// says plainly that the platforms will ask to allow "Anavyst", so that name
// isn't a surprise on the Facebook or Google screen.

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ connected?: string; error?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { token } = await props.params;
  const found = await loadConnectLink(createAdminClient(), token);
  const agency = found.ok ? found.link.agency.name : "reason" in found && found.reason !== "unknown" ? found.agency.name : null;
  return {
    title: agency ? `${agency} · Connect your accounts` : "Connect your accounts",
    robots: { index: false, follow: false },
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

function Header({ agency }: { agency: LinkBranding }) {
  return (
    <div className="flex items-center gap-3">
      {agency.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={agency.logoUrl} alt="" className="h-10 w-10 rounded-lg object-contain" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink-900 text-sm font-semibold text-white">
          {agency.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <p className="text-base font-semibold text-ink-900">{agency.name}</p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-xl">{children}</div>
    </main>
  );
}

type SourceRow = {
  type: string;
  display_name: string | null;
  config: IntegrationConfig | null;
  status: string | null;
  connection: { client_id: string | null } | { client_id: string | null }[] | null;
};

export default async function ConnectLinkPage(props: Props) {
  const [{ token }, query] = await Promise.all([props.params, props.searchParams]);
  const admin = createAdminClient();
  const found = await loadConnectLink(admin, token);

  if (!found.ok) {
    const agency = found.reason === "unknown" ? null : found.agency;
    return (
      <Shell>
        {agency && <Header agency={agency} />}
        <div className="mt-8 rounded-2xl border border-ink-200 bg-surface p-6">
          <h1 className="text-lg font-semibold text-ink-900">
            {found.reason === "unknown" ? "This link isn't valid" : "This link is no longer active"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-600">
            {agency
              ? `It has expired or was turned off. Ask ${agency.name} to send you a new one.`
              : "Check that you opened the full link, or ask whoever sent it for a new one."}
          </p>
        </div>
      </Shell>
    );
  }

  const { link } = found;
  const accent = link.agency.brandColor && HEX.test(link.agency.brandColor) ? link.agency.brandColor : null;

  const { data } = await admin
    .from("data_sources")
    .select("type, display_name, config, status, connection:connections!data_sources_connection_fkey(client_id)")
    .eq("client_id", link.clientId)
    .in("type", link.types);
  const byType = new Map(((data ?? []) as unknown as SourceRow[]).map((r) => [r.type, r]));

  const flashDef = query.connected ? getIntegration(query.connected) : undefined;
  const expires = new Date(link.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

  return (
    <Shell>
      <Header agency={link.agency} />

      <h1 className="mt-8 text-[clamp(22px,4vw,28px)] font-semibold tracking-[-0.02em] text-ink-900">
        Connect your accounts
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        {link.agency.name} would like read-only access to the accounts below, to prepare reports for{" "}
        <span className="font-medium text-ink-800">{link.clientName}</span>. Sign in to each with your own login.
      </p>

      {flashDef && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-800">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden /> {flashDef.name} connected. Thank you!
        </div>
      )}
      {query.error && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-warning-300 bg-warning-50 px-4 py-3 text-sm text-warning-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {query.error}
        </div>
      )}

      <ul className="mt-6 space-y-3">
        {link.types.map((type) => {
          const def = getIntegration(type)!;
          const Icon = integrationIcon(def.icon);
          const row = byType.get(type);
          const owner = Array.isArray(row?.connection) ? row?.connection[0] : row?.connection;
          const byClient = owner?.client_id === link.clientId;
          const config = (row?.config ?? {}) as IntegrationConfig;
          const accounts = def.readAccounts?.(config) ?? [];
          const selected = def.readSelected?.(config) ?? null;
          const working = row && row.status !== "revoked";
          const options = linkSignInOptions(def);
          const startHref = (provider?: string) =>
            `/api/connect-link/start?token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}`;

          return (
            <li key={type} className="rounded-2xl border border-ink-200 bg-surface p-5">
              <div className="flex items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${integrationTint(def.accent)}`}>
                  <Icon size={18} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink-900">{def.name}</p>
                  {working && selected ? (
                    <p className="mt-0.5 flex items-center gap-1.5 text-sm text-success-700">
                      <CheckCircle2 size={14} aria-hidden /> Connected
                      {accounts.find((a) => a.id === selected)?.name ? `: ${accounts.find((a) => a.id === selected)!.name}` : ""}
                    </p>
                  ) : working && byClient && accounts.length > 0 ? (
                    <p className="mt-0.5 text-sm text-ink-600">
                      Signed in as {row?.display_name ?? "you"}. Choose which {def.accountNoun} is yours:
                    </p>
                  ) : working && byClient ? (
                    <p className="mt-0.5 text-sm text-warning-700">
                      Signed in as {row?.display_name ?? "you"}, but no {def.accountNoun} was found on that login. Try
                      another account.
                    </p>
                  ) : (
                    <p className="mt-0.5 text-sm text-ink-500">{def.description}.</p>
                  )}
                </div>
              </div>

              {working && byClient && !selected && accounts.length > 0 && (
                <form action="/api/connect-link/select" method="post" className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="type" value={type} />
                  <select name="accountId" required className="field h-10 flex-1" defaultValue="">
                    <option value="" disabled>
                      Select a {def.accountNoun}…
                    </option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="h-10 rounded-lg bg-ink-900 px-4 text-sm font-medium text-white"
                    style={accent ? { backgroundColor: accent } : undefined}
                  >
                    Save
                  </button>
                </form>
              )}

              {/* A platform connected by the agency itself has nothing for the
                  client to do; one the client connected can be redone with
                  another login. */}
              {(!working || (byClient && !(selected && accounts.length > 0))) && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {(options.length
                    ? options.map((o, i) => ({ href: startHref(o.id), ...signInButton(o, i) }))
                    : [{ href: startHref(), label: `Connect ${def.name}`, secondary: false }]
                  ).map((b) =>
                    b.secondary ? (
                      <a
                        key={b.href}
                        href={b.href}
                        className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-4 text-sm font-medium text-ink-800"
                      >
                        {b.label} <ArrowRight size={15} aria-hidden />
                      </a>
                    ) : (
                      <a
                        key={b.href}
                        href={b.href}
                        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-900 px-4 text-sm font-medium text-white"
                        style={accent ? { backgroundColor: accent } : undefined}
                      >
                        {working && byClient && options.length <= 1 ? "Use a different account" : b.label}{" "}
                        <ArrowRight size={15} aria-hidden />
                      </a>
                    )
                  )}
                </div>
              )}
              {!working &&
                options
                  .filter((o) => o.note)
                  .map((o) => (
                    <p key={o.id} className="mt-3 text-xs leading-relaxed text-ink-500">
                      {o.note}
                    </p>
                  ))}
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex items-start gap-2 rounded-xl bg-surface-subtle px-4 py-3 text-xs leading-relaxed text-ink-600">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success-600" aria-hidden />
        <span>
          {link.agency.name} uses Anavyst to prepare your reports, so each platform will ask you to allow
          &ldquo;Anavyst&rdquo; access. It&apos;s read-only: nothing can be changed or posted, and you can remove access
          at any time in that platform&apos;s settings. This link works until {expires}.
        </span>
      </div>
    </Shell>
  );
}
