import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { getIntegration, isLive } from "@/lib/integrations/registry";
import { isShareable, reviveConnectionSources, type ConnectionTokens } from "@/lib/integrations/connections";
import { getValidAccessToken } from "@/lib/googleTokens";
import { syncDataSource } from "@/lib/sync";
import { loadSyncable } from "@/lib/integrations/connections";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import { logError } from "@/lib/errorLog";
import { publicMessage } from "@/lib/errors";
import { CONNECT_FLASH_COOKIE, CONNECT_FLASH_MAX_AGE, encodeConnectFlash } from "@/lib/integrations/connectFlash";
import type { IntegrationAccount, IntegrationConfig, IntegrationDef } from "@/lib/integrations/types";

export const runtime = "nodejs";

type Conn = {
  id: string;
  agency_id: string;
  client_id: string | null;
  type: string;
  identity_provider: string | null;
  display_name: string | null;
  subject_hash: string | null;
  status: string;
};

const TOKEN_FIELDS = "id, agency_id, type, client_id, identity_provider, access_token, refresh_token, token_expires_at, status";

// The same login, signed in twice (see the review page,
// /dashboard/connect/[type]/review). Two ways to end up with one sign-in:
//
//   renew  The saved sign-in takes the new one's credentials, and the new
//          one's sources move onto it. Allowed only when the provider's own
//          id proves both are the same login (never on a matching name or
//          email), and only when the new credentials reach every account the
//          saved sign-in's clients report on. So no client loses access.
//   reuse  This client's sources on the new sign-in move to the saved one,
//          which must still work and reach their accounts. The new sign-in
//          is then unused and deleted (migration 0046's trigger).
//
// "Keep both" needs nothing: both sign-ins already work.
export async function POST(req: Request) {
  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.redirect(new URL("/login", req.url));

  const form = await req.formData();
  const clientId = String(form.get("clientId") ?? "");
  const fromId = String(form.get("from") ?? "");
  const intoId = String(form.get("into") ?? "");
  const mode = String(form.get("mode") ?? "");
  const base = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const back = `${base}/dashboard/clients/${clientId}/data-sources`;
  const fail = (msg: string) => NextResponse.redirect(`${back}?connect_error=${encodeURIComponent(msg)}`, 303);
  if (!clientId || !fromId || !intoId || fromId === intoId || (mode !== "renew" && mode !== "reuse")) {
    return fail("Choose what to do with the two sign-ins.");
  }

  // RLS: the client and both sign-ins must be in the caller's workspace.
  const supabase = createClient();
  const [{ data: client }, { data: rows }] = await Promise.all([
    supabase.from("clients").select("id, agency_id").eq("id", clientId).maybeSingle(),
    supabase
      .from("connections")
      .select("id, agency_id, client_id, type, identity_provider, display_name, subject_hash, status")
      .in("id", [fromId, intoId]),
  ]);
  const conns = (rows ?? []) as Conn[];
  const from = conns.find((c) => c.id === fromId);
  const into = conns.find((c) => c.id === intoId);
  if (!client || !from || !into) return fail("That sign-in isn't available.");
  const agencyId = client.agency_id as string;
  const sameOwner = (from.client_id ?? null) === (into.client_id ?? null);
  if (
    from.agency_id !== agencyId ||
    into.agency_id !== agencyId ||
    from.type !== into.type ||
    (from.identity_provider ?? null) !== (into.identity_provider ?? null) ||
    !sameOwner ||
    (from.client_id && from.client_id !== clientId)
  ) {
    return fail("Those sign-ins can't be combined.");
  }
  const def = getIntegration(from.type);
  if (!def || !isLive(def.id) || !isShareable(def) || !def.listAccounts) return fail("Those sign-ins can't be combined.");

  const admin = createAdminClient();
  try {
    if (mode === "renew") {
      if (!from.subject_hash || from.subject_hash !== into.subject_hash) {
        return fail(
          `${def.name} can't confirm these are the same login, so their sign-ins can't be combined. Keep both, or use the saved one for this client.`
        );
      }
      const fromTokens = await loadTokens(admin, from.id, agencyId);
      const accounts = await listWith(def, fromTokens);
      const sources = await sourcesOn(admin, agencyId, [from.id, into.id]);
      const missing = unreachable(def, sources, accounts);
      if (missing.length) {
        return fail(
          `The new sign-in can't reach ${list(missing)}, which the saved one is used for, so the saved one was kept. Keep both instead.`
        );
      }

      const { data: raw } = await admin
        .from("connections")
        .select("access_token, refresh_token, token_expires_at")
        .eq("id", from.id)
        .eq("agency_id", agencyId)
        .single();
      const { error: renewError } = await admin
        .from("connections")
        .update({
          ...(raw as Record<string, unknown>),
          display_name: from.display_name,
          status: "connected",
          token_lock_token: null,
          token_locked_until: null,
        })
        .eq("id", into.id)
        .eq("agency_id", agencyId);
      if (renewError) throw new Error(renewError.message);
      // Moving the last source off the new sign-in deletes it (0046 trigger).
      const { error: moveError } = await admin
        .from("data_sources")
        .update({ connection_id: into.id })
        .eq("connection_id", from.id)
        .eq("agency_id", agencyId);
      if (moveError) throw new Error(moveError.message);

      const outcome = await reviveConnectionSources(admin, { def, connectionId: into.id, accounts, identity: from.display_name });
      await syncClient(supabase, admin, clientId, into.id, def);
      revalidateIntegrationHealth(agencyId);
      return done(back, base, {
        account: null,
        identity: into.display_name,
        note: `One sign-in now, renewed for ${outcome.restored} source${outcome.restored === 1 ? "" : "s"}`,
      });
    }

    // reuse
    if (into.status === "revoked") return fail("The saved sign-in has expired. Renew it instead, or keep both.");
    const intoTokens = await loadTokens(admin, into.id, agencyId);
    const accounts = await listWith(def, intoTokens);
    const { data: mine } = await supabase
      .from("data_sources")
      .select("id, config")
      .eq("client_id", clientId)
      .eq("connection_id", from.id);
    const moving = (mine ?? []) as { id: string; config: IntegrationConfig | null }[];
    const missing = unreachable(def, moving, accounts);
    if (missing.length) {
      return fail(`The saved sign-in can't reach ${list(missing)}. Keep both sign-ins instead.`);
    }
    const fresh = def.buildConfig ? def.buildConfig(accounts) : {};
    for (const row of moving) {
      const config = row.config ?? {};
      const { error } = await supabase
        .from("data_sources")
        .update({
          connection_id: into.id,
          display_name: into.display_name,
          config: { ...config, ...fresh, [def.accountConfigKey]: def.readSelected?.(config) ?? null },
          status: "connected",
          last_sync_error: null,
        })
        .eq("id", row.id);
      if (error) throw new Error(error.message);
    }
    await syncClient(supabase, admin, clientId, into.id, def);
    revalidateIntegrationHealth(agencyId);
    return done(back, base, { account: null, identity: into.display_name, note: "Using your saved sign-in" });
  } catch (err) {
    await logError({ context: "api_route", agencyId, provider: def.id, message: (err as Error).message });
    return fail(publicMessage(err, "Couldn't combine those sign-ins. Both still work; please try again.", { provider: def.id }));
  }
}

async function loadTokens(admin: ReturnType<typeof createAdminClient>, id: string, agencyId: string): Promise<ConnectionTokens> {
  const { data, error } = await admin.from("connections").select(TOKEN_FIELDS).eq("id", id).eq("agency_id", agencyId).single();
  if (error || !data) throw new Error(error?.message ?? "sign-in not found");
  return data as ConnectionTokens;
}

async function listWith(def: IntegrationDef, connection: ConnectionTokens): Promise<IntegrationAccount[]> {
  const provider = connection.identity_provider ?? undefined;
  const token = await getValidAccessToken({ id: connection.id, type: def.id, config: { identity_provider: provider }, connection });
  return def.listAccounts!(token, { provider });
}

async function sourcesOn(admin: ReturnType<typeof createAdminClient>, agencyId: string, connectionIds: string[]) {
  const { data, error } = await admin
    .from("data_sources")
    .select("id, config")
    .eq("agency_id", agencyId)
    .in("connection_id", connectionIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; config: IntegrationConfig | null }[];
}

// Accounts these sources report on that `accounts` doesn't include, by name.
function unreachable(def: IntegrationDef, sources: { config: IntegrationConfig | null }[], accounts: IntegrationAccount[]): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    const selected = def.readSelected?.(s.config ?? {}) ?? null;
    if (selected && !accounts.some((a) => a.id === selected)) {
      out.add(def.readAccounts?.(s.config ?? {}).find((a) => a.id === selected)?.name ?? selected);
    }
  }
  return [...out];
}

const list = (names: string[]) =>
  names.length <= 3 ? names.map((n) => `“${n}”`).join(", ") : `${names.slice(0, 3).map((n) => `“${n}”`).join(", ")} and ${names.length - 3} more`;

async function syncClient(
  supabase: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createAdminClient>,
  clientId: string,
  connectionId: string,
  def: IntegrationDef
) {
  const { data } = await admin.from("data_sources").select("id").eq("client_id", clientId).eq("connection_id", connectionId);
  const sources = await loadSyncable(((data ?? []) as { id: string }[]).map((r) => r.id));
  for (const s of sources) if (def.readSelected?.(s.config ?? {})) await syncDataSource(supabase, s);
}

function done(back: string, base: string, flash: { account: string | null; identity: string | null; note: string }) {
  const res = NextResponse.redirect(`${back}?connected=1`, 303);
  res.cookies.set(CONNECT_FLASH_COOKIE, encodeConnectFlash(flash), {
    maxAge: CONNECT_FLASH_MAX_AGE,
    path: "/dashboard",
    sameSite: "lax",
    secure: base.startsWith("https://"),
  });
  return res;
}
