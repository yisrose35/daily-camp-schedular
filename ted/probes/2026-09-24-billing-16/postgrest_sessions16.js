// Probe (16th pass, TED-143): does the auto-reload job's NEW query work against
// a REAL PostgREST (the server Supabase runs in front of the database)?
//
// canteen-auto-reload/index.ts now reads each camp's sessions with
//   supabase.from("camp_state_kv").select("camp_id, key, sessions:value->sessions")
//           .in("camp_id", [...]).eq("key", "campistryMe")
// My edge harness ignores the select list, so the probes/tests only exercise
// the `r.value.sessions` fallback. Here the SAME request goes to PostgREST
// 12.2.3 (downloaded from GitHub into my scratch folder) over a scratch copy of
// the migration chain, via the real supabase-js the project vendors.
// Run: node ted/probes/2026-09-24-billing-16/postgrest_sessions16.js
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const R = '/home/user/daily-camp-schedular';
const PGR = '/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/ted16/postgrest';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5693 });
let bad = 0;
const check = (label, ok, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };

(async () => {
  const C1 = '0ed16100-0000-0000-0000-000000000001', C2 = '0ed16100-0000-0000-0000-000000000002', O = '0ed16100-0000-0000-0000-0000000000ff';
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${O}','o@pgr16');
    INSERT INTO camps (id, owner, name) VALUES ('${C1}','${O}','A'), ('${C2}','${O}','B');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES
      ('${C1}', 'campistryMe', '{"families":{"x":{"name":"X"}},"sessions":[{"id":"s1","name":"Summer","startDate":"2027-06-28","endDate":"2027-08-20"}]}'::jsonb),
      ('${C2}', 'campistryMe', '{"families":{}}'::jsonb),
      ('${C1}', 'campDates', '{"startDate":"2027-06-28","endDate":"2027-08-20"}'::jsonb);
    DO $$ BEGIN CREATE ROLE ted_anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  const sock = db.socket || '/tmp';
  const conf = path.join(path.dirname(PGR), 'pgr16.conf');
  fs.writeFileSync(conf, [
    `db-uri = "postgres://postgres@/postgres?host=${encodeURIComponent(sock)}&port=${db.port}"`,
    `db-schemas = "public"`, `db-anon-role = "postgres"`, `server-port = 3993`, `server-host = "127.0.0.1"`, `log-level = "error"`,
  ].join('\n'));
  const srv = spawn(PGR, [conf], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errOut = ''; srv.stderr.on('data', d => { errOut += d; }); srv.stdout.on('data', d => { errOut += d; });
  for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:3993/'); if (r.status < 500) break; } catch (_) {} await new Promise(r => setTimeout(r, 200)); }
  try {
    // 1. the raw REST request supabase-js builds for that call
    const url = `http://127.0.0.1:3993/camp_state_kv?select=camp_id,key,sessions:value-%3Esessions&camp_id=in.(${C1},${C2})&key=eq.campistryMe`;
    const r1 = await fetch(url); const b1 = await r1.text();
    console.log(`1. GET ${decodeURIComponent(url.replace('http://127.0.0.1:3993', ''))}\n   HTTP ${r1.status}: ${b1}`);
    let rows = []; try { rows = JSON.parse(b1); } catch (_) {}
    const a = Array.isArray(rows) && rows.find(x => x.camp_id === C1);
    check('the alias comes back as `sessions` (an array) — the job\'s first branch', r1.status === 200 && a && Array.isArray(a.sessions) && a.sessions[0].startDate === '2027-06-28', JSON.stringify(a));
    check('the rest of the Me document is NOT sent (only the sessions)', a && !('value' in a) && !('families' in a), Object.keys(a || {}).join(','));
    const b = Array.isArray(rows) && rows.find(x => x.camp_id === C2);
    check('a camp whose Me document has no sessions → sessions null (the job treats it as no dated sessions)', b && b.sessions === null, JSON.stringify(b));

    // 2. through the vendored supabase-js, exactly the job's call
    const vend = ['supabase_vendor.js', 'vendor/supabase.js', 'node_modules/@supabase/supabase-js'].map(p => path.join(R, p)).find(p => fs.existsSync(p));
    let createClient = null;
    try { createClient = require(path.join(R, 'node_modules/@supabase/supabase-js')).createClient; } catch (_) {}
    if (!createClient) {
      // the project's own vendored copy (supabase-js@2.js, v2.95.3 UMD) — what the pages load
      const vm = require('node:vm');
      const lib = vm.runInThisContext(fs.readFileSync(path.join(R, 'supabase-js@2.js'), 'utf8') + '\n;supabase');
      createClient = lib.createClient;
    }
    if (createClient) {
      // supabase-js appends /rest/v1 — point it at a tiny proxy prefix
      const http = require('node:http');
      const proxy = http.createServer(async (req, res) => {
        const u = req.url.replace(/^\/rest\/v1/, '');
        const pr = await fetch('http://127.0.0.1:3993' + u, { headers: { Accept: req.headers.accept || 'application/json' } });
        res.writeHead(pr.status, { 'content-type': pr.headers.get('content-type') || 'application/json' }); res.end(await pr.text());
      }).listen(3994);
      const sb = createClient('http://127.0.0.1:3994', 'anon-key', { auth: { persistSession: false } });
      const { data, error } = await sb.from('camp_state_kv').select('camp_id, key, sessions:value->sessions').in('camp_id', [C1, C2]).eq('key', 'campistryMe');
      console.log(`2. supabase-js (the vendored supabase-js@2.js, 2.95.3) .select("camp_id, key, sessions:value->sessions") → error ${JSON.stringify(error)}, data ${JSON.stringify(data)}`);
      check('supabase-js + PostgREST return the sessions under `sessions`', !error && Array.isArray(data) && data.some(x => Array.isArray(x.sessions) && x.sessions.length === 1), JSON.stringify(data));
      proxy.close();
    } else {
      console.log(`2. (no @supabase/supabase-js in node_modules; vendored copy: ${vend || 'none'}) — raw request above is what it sends`);
    }
  } catch (e) { check('the run finished', false, String(e.stack || e).slice(0, 400)); }
  finally {
    srv.kill(); db.stop();
    if (errOut.trim()) console.log('postgrest log: ' + errOut.trim().slice(0, 400));
    console.log(`\n${bad} BAD`);
  }
})();
