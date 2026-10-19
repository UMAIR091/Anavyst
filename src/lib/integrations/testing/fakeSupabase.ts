// An in-memory stand-in for the slice of Supabase that sign-ins and data
// sources use, enforcing the database's own rules so tests exercise them:
//
//   - data_sources.account_key, computed from config (migration 0049);
//   - unique (client_id, type, account_key), and one source per client for
//     Search Console / GA4 (0049); optionally 0023's one-per-platform index,
//     until 0051 drops it (`legacyIndex`);
//   - the sign-in foreign key: same workspace and platform (0046);
//   - a client's own sign-in serves only that client (0048);
//   - a sign-in no source uses is deleted (0046);
//   - changing a source's account clears its stored history (0049).
//
// Test-only. Supports the query-builder calls the code under test makes.
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;
type PgError = { code: string; message: string };
type Result = { data: unknown; error: PgError | null; count?: number | null };

const SINGLE = new Set(["gsc", "ga4"]);

// The plain columns of a PostgREST select list (embeds are handled apart);
// null for "*" or none.
function columnsOf(columns: string | null): string[] | null {
  if (!columns || columns.trim() === "*") return null;
  const out: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of `${columns},`) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      const t = token.trim();
      if (t && !t.includes("(")) out.push(t);
      token = "";
    } else token += ch;
  }
  return out;
}

export function accountKey(r: Row): string {
  const cfg = (r.config ?? {}) as Record<string, unknown>;
  const v = r.type === "gsc" ? cfg.site_url : r.type === "ga4" ? cfg.property_id : cfg.account_id;
  return typeof v === "string" ? v : "";
}

export class FakeDb {
  tables: Record<string, Row[]> = { connections: [], data_sources: [], clients: [] };
  legacyIndex = false;
  clearedHistory: string[] = [];
  private seq = 0;

  constructor(opts: { legacyIndex?: boolean } = {}) {
    this.legacyIndex = Boolean(opts.legacyIndex);
  }

  id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  connection(id: string | null | undefined): Row | undefined {
    return id ? this.rows("connections").find((c) => c.id === id) : undefined;
  }

  // ── rules ────────────────────────────────────────────────────
  private checkSource(next: Row, self: Row | null): PgError | null {
    const others = this.rows("data_sources").filter((r) => r !== self && r.client_id && r.client_id === next.client_id);
    if (others.some((r) => r.type === next.type && accountKey(r) === accountKey(next))) {
      return { code: "23505", message: 'duplicate key value violates unique constraint "data_sources_client_type_account_key"' };
    }
    if (SINGLE.has(String(next.type)) && others.some((r) => r.type === next.type)) {
      return { code: "23505", message: 'duplicate key value violates unique constraint "data_sources_single_account_types_key"' };
    }
    if (this.legacyIndex && others.some((r) => r.type === next.type)) {
      return { code: "23505", message: 'duplicate key value violates unique constraint "data_sources_client_type_key"' };
    }
    if (next.connection_id) {
      const c = this.connection(next.connection_id as string);
      if (!c || c.agency_id !== next.agency_id || c.type !== next.type) {
        return { code: "23503", message: 'insert or update on table "data_sources" violates foreign key constraint "data_sources_connection_fkey"' };
      }
      if (c.client_id && c.client_id !== next.client_id) {
        return { code: "42501", message: "That sign-in belongs to another client" };
      }
    }
    return null;
  }

  private afterSourceChange(before: Row | null, after: Row | null) {
    // 0049: a source's history belongs to its account.
    if (before && after && accountKey(before) !== "" && accountKey(before) !== accountKey(after)) {
      this.clearedHistory.push(String(after.id));
      after.last_synced_at = null;
    }
    // 0046: an unused sign-in goes.
    const old = before?.connection_id as string | undefined;
    if (old && old !== after?.connection_id && !this.rows("data_sources").some((r) => r.connection_id === old)) {
      this.tables.connections = this.rows("connections").filter((c) => c.id !== old);
    }
  }

  withKey(r: Row): Row {
    return r && "type" in r && "config" in r ? { ...r, account_key: accountKey(r) } : r;
  }

  // ── execution ────────────────────────────────────────────────
  run(q: Query): Result {
    const table = this.rows(q.table);
    const match = (r: Row) => q.filters.every((f) => f(r));

    if (q.op === "upsert") {
      // Simple tables only (snapshots): replace on the conflict columns.
      for (const p of q.payload as Row[]) {
        const same = table.find((r) => q.conflict.every((c) => r[c] === p[c]));
        if (same) Object.assign(same, p);
        else table.push({ ...p });
      }
      return { data: null, error: null };
    }

    if (q.op === "insert") {
      const inserted: Row[] = [];
      for (const p of q.payload as Row[]) {
        const row: Row = {
          id: p.id ?? this.id(q.table === "connections" ? "conn" : q.table === "data_sources" ? "ds" : q.table),
          created_at: new Date(Date.now() + this.seq).toISOString(),
          ...p,
        };
        if (q.table === "data_sources") {
          row.status ??= "connected";
          const err = this.checkSource(row, null);
          if (err) return { data: null, error: err };
        }
        table.push(row);
        inserted.push(row);
      }
      return this.project(q, inserted);
    }

    if (q.op === "update") {
      const hits = table.filter(match);
      for (const row of hits) {
        const before = { ...row };
        const next = { ...row, ...(q.payload as Row) };
        if (q.table === "data_sources") {
          const err = this.checkSource(next, row);
          if (err) return { data: null, error: err };
        }
        Object.assign(row, q.payload as Row);
        if (q.table === "data_sources") this.afterSourceChange(before, row);
      }
      return this.project(q, hits);
    }

    if (q.op === "delete") {
      const hits = table.filter(match);
      this.tables[q.table] = table.filter((r) => !hits.includes(r));
      if (q.table === "data_sources") for (const r of hits) this.afterSourceChange(r, null);
      return this.project(q, hits);
    }

    let hits = table.filter(match);
    if (q.ordering) {
      const { col, asc } = q.ordering;
      hits = [...hits].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (q.max !== null) hits = hits.slice(0, q.max);
    if (q.head) return { data: null, error: null, count: hits.length };
    return this.project(q, hits);
  }

  private project(q: Query, rows: Row[]): Result {
    if (q.columns === null && q.op !== "select") return { data: null, error: null };
    const embed = /connection:connections!data_sources_connection_fkey/.test(q.columns ?? "");
    const picked = columnsOf(q.columns);
    const out = rows.map((r) => {
      const full: Row = { ...this.withKey(r) };
      const copy: Row = picked ? Object.fromEntries(picked.filter((k) => k in full).map((k) => [k, full[k]])) : full;
      if (embed) {
        const c = this.connection(r.connection_id as string | null);
        copy.connection = c ? { ...c } : null;
      }
      return copy;
    });
    return { data: out, error: null };
  }

  client() {
    return { from: (table: string) => new Query(this, table) } as unknown as import("@supabase/supabase-js").SupabaseClient;
  }
}

class Query implements PromiseLike<Result> {
  op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  conflict: string[] = [];
  payload: unknown = null;
  columns: string | null = null;
  filters: Filter[] = [];
  ordering: { col: string; asc: boolean } | null = null;
  max: number | null = null;
  head = false;

  constructor(private db: FakeDb, public table: string) {}

  select(columns = "*", opts?: { head?: boolean; count?: string }) {
    this.columns = columns;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(p: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(p) ? p : [p];
    return this;
  }
  upsert(p: Row | Row[], opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = Array.isArray(p) ? p : [p];
    this.conflict = (opts?.onConflict ?? "id").split(",").map((c) => c.trim());
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  private value(r: Row, k: string) {
    return k === "account_key" ? accountKey(r) : r[k];
  }
  eq(k: string, v: unknown) {
    this.filters.push((r) => this.value(r, k) === v);
    return this;
  }
  neq(k: string, v: unknown) {
    this.filters.push((r) => this.value(r, k) !== v);
    return this;
  }
  in(k: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(this.value(r, k)));
    return this;
  }
  is(k: string, v: null) {
    this.filters.push((r) => (this.value(r, k) ?? null) === v);
    return this;
  }
  not(k: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.filters.push((r) => (this.value(r, k) ?? null) !== null);
    return this;
  }
  gt(k: string, v: string) {
    this.filters.push((r) => String(this.value(r, k)) > v);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.ordering = { col, asc: opts?.ascending ?? true };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }

  async single(): Promise<Result> {
    const res = this.db.run(this);
    if (res.error) return res;
    const rows = (res.data ?? []) as Row[];
    if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${rows.length}` } };
    return { data: rows[0], error: null };
  }
  async maybeSingle(): Promise<Result> {
    const res = this.db.run(this);
    if (res.error) return res;
    const rows = (res.data ?? []) as Row[];
    if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" } };
    return { data: rows[0] ?? null, error: null };
  }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.db.run(this)).then(ok, bad);
  }
}
