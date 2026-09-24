// realdb_bridge.js (10th pass helper) — lets tests/edge_harness.js run a REAL
// edge function against a REAL scratch Postgres (tests/e2e/db.js boot, the full
// migration chain incl. 275/276/277) instead of a pretend database.
//
// bridge(db, rpcNames, tableNames) returns scenario source that:
//   * answers each named rpc by running `SELECT public.<name>(p_x => ...)::text`
//     through psql against the scratch DB (so migration 275's reserve / settle
//     / release, 198's claims, 273's stale release... are the real SQL);
//   * makes each named table a live view of the real table for the harness's
//     from(...).select() reads (rows as json).
// Each psql call is synchronous, so each rpc is atomic in the harness process —
// the same as the builder's model; the real two-connection lock is covered by
// pgtest 275's dblink race.
'use strict';

function bridge(db, rpcNames, tableNames) {
  const conn = JSON.stringify({ psql: db.psql, sock: db.socket, port: String(db.port) });
  return `
const __cp: any = await import('node:child_process');
const __C = ${conn};
const __q = (sql: string) => {
  const r = __cp.spawnSync(__C.psql, ['-h', __C.sock, '-p', __C.port, '-U', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || 'psql failed').trim().split('\\n')[0]);
  return String(r.stdout).trim();
};
(T as any).__q = __q;
const __lit = (v: any): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
T.__sqlLog = [];
for (const name of ${JSON.stringify(rpcNames)}) {
  T.rpc[name] = (a: any) => {
    const args = Object.entries(a || {}).filter(([, v]) => v !== undefined).map(([k, v]) => k + ' => ' + __lit(v)).join(', ');
    const out = __q('SELECT public.' + name + '(' + args + ')::text');
    T.__sqlLog.push(name);
    return out === '' ? null : JSON.parse(out);
  };
}
for (const t of ${JSON.stringify(tableNames)}) {
  Object.defineProperty(T.tables, t, { configurable: true, enumerable: false,
    get() { const o = __q("SELECT coalesce(json_agg(x), '[]'::json)::text FROM " + t + " x"); return JSON.parse(o || '[]'); },
    set(_v) { /* the real table decides */ } });
}
`;
}

module.exports = { bridge };
