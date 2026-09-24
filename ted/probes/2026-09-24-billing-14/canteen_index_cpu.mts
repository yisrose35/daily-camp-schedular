// Probe (14th pass, TED-139 re-check). Two questions about the canteen refund
// maths now that it builds one index of the ledger per run:
//
//  1. SPEED — processing time of the REAL functions (cut verbatim from today's
//     files at run time: refundableByAccount in stripe-canteen-refund and
//     payments-canteen-refund, depositsFor in both Refund Alls, with the new
//     ledgerIndex/depositsOf they call) on camps up to 1,500 children × 20
//     top-ups, against Supabase's 2 s processing limit per request.
//  2. SAME ANSWERS — the new code must give exactly what the old code (the same
//     functions from fef6edb, before the change) gave, on 400 random ledgers:
//     numbered and un-numbered children, two children with one name, renamed
//     children, refunds, failed-and-put-back refunds, holds, other processors.
// Run: node --experimental-strip-types ted/probes/2026-09-24-billing-14/canteen_index_cpu.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = '/home/user/daily-camp-schedular';
const FILES = {
  stripeOne: 'supabase/functions/stripe-canteen-refund/index.ts',
  solaOne: 'supabase/functions/payments-canteen-refund/index.ts',
  stripeAll: 'supabase/functions/stripe-canteen-refund-all/index.ts',
  solaAll: 'supabase/functions/payments-canteen-refund-all/index.ts',
};
const cutFn = (src: string, name: string) => { const at = src.indexOf('function ' + name + '('); if (at < 0) return ''; return src.slice(at, src.indexOf('\n}\n', at) + 3); };
const cutBlock = (src: string, start: string, end: string) => { const at = src.indexOf(start); if (at < 0) return ''; return src.slice(at, src.indexOf(end, at) + end.length); };
async function load(src: string, names: string[], tag: string) {
  let code = 'type DepositRemainder = any;\n' + cutFn(src, 'round2');
  code += cutBlock(src, 'type LedgerIndex = {', '};\n');
  code += cutBlock(src, 'const __ledgerIndexes', ';\n');
  code += cutFn(src, 'ledgerIndex') + cutFn(src, 'depositsOf');
  for (const n of names) code += cutFn(src, n);
  code += `\nexport { ${names.join(', ')} };\n`;
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cidx-' + tag + '-')), 'fn.ts');
  fs.writeFileSync(f, code);
  return import(f);
}
const now: Record<string, any> = {}, old: Record<string, any> = {};
for (const [k, file] of Object.entries(FILES)) {
  const names = k.endsWith('One') ? ['refundableByAccount'] : ['depositsFor'];
  now[k] = await load(fs.readFileSync(path.join(REPO, file), 'utf8'), names, 'now' + k);
  old[k] = await load(execSync(`git -C ${REPO} show fef6edb:${file}`, { encoding: 'utf8' }), names, 'old' + k);
}
const cpu = (fn: () => void) => { const t0 = process.cpuUsage(); fn(); const u = process.cpuUsage(t0); return Math.round((u.user + u.system) / 1000); };

// ── 1. speed ────────────────────────────────────────────────────────────────
function camp(children: number, each: number, method: string, idField: string) {
  const accounts: any = {}, transactions: any[] = [], holds: any[] = [];
  for (let a = 1; a <= children; a++) {
    const key = 'Camper ' + a; accounts[key] = { balance: 50, balanceFloor: 0, camperId: a };
    for (let t = 1; t <= each; t++) {
      const ref = `${method}_${a}_${t}`;
      transactions.push({ kind: 'deposit', method, [idField]: ref, amount: 25, camper: key, camperId: a, timestamp: t });
      if (t <= 3) transactions.push({ kind: 'refund', method, [idField]: ref, amount: 5, camper: key, camperId: a });
    }
    for (let s = 0; s < 10; s++) transactions.push({ kind: 'purchase', amount: 2, camper: key, camperId: a });
  }
  return { accounts, transactions, holds };
}
console.log(`machine: ${os.cpus()[0].model}, node ${process.version}\n`);
console.log('1. processing time (ms) of today\'s code — Supabase stops a function at 2,000 ms');
for (const [n, e] of [[600, 8], [1000, 15], [1500, 20]]) {
  const s = camp(n, e, 'stripe', 'stripePaymentIntentId'), b = camp(n, e, 'cardknox', 'byopTransactionId');
  const t1 = cpu(() => now.stripeOne.refundableByAccount(s, 'stripe', 'stripePaymentIntentId'));
  const t2 = cpu(() => now.solaOne.refundableByAccount(b, 'cardknox', 'byopTransactionId'));
  const t3 = cpu(() => { for (let i = 1; i <= n; i++) now.stripeAll.depositsFor({ camperId: i, camperName: 'Camper ' + i }, s.transactions, s.holds); });
  const t4 = cpu(() => { for (let i = 1; i <= n; i++) now.solaAll.depositsFor({ camperId: i, camperName: 'Camper ' + i }, b.transactions, 'cardknox', b.holds); });
  console.log(`   ${String(n).padStart(5)} children × ${String(e).padStart(2)} top-ups (${s.transactions.length} ledger rows): window (Stripe) ${t1} · window (Sola) ${t2} · Refund All (Stripe) ${t3} · Refund All (Sola) ${t4}`);
}

// ── 2. same answers as before the change ─────────────────────────────────────
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
function randomView(method: string, idField: string, fair = false) {
  const names = ['Avi', 'Bea', 'Avi Katz', 'Dov', 'Eli', 'Avi'];     // 'Avi' twice: two children, one name
  const accounts: any = {}, transactions: any[] = [], holds: any[] = [];
  const kids = names.map((nm, i) => ({ key: i === 5 ? 'Avi (2)' : nm, name: nm, id: rnd() < 0.8 ? i + 1 : null }));
  kids.forEach((k) => { accounts[k.key] = { balance: Math.round(rnd() * 8000) / 100, balanceFloor: fair ? 0 : pick([0, 0, 5, 10]), camperId: k.id }; });
  let n = 0;
  for (let t = 0; t < 30; t++) {
    const k = pick(kids); const ref = `${method}_${++n}`;
    const m = rnd() < 0.85 ? method : pick(['cash', 'stripe', 'cardknox', 'banquest']);
    transactions.push({ kind: 'deposit', method: m, [idField]: rnd() < 0.9 ? ref : undefined, amount: pick([10, 20, 25, 50]),
      camper: rnd() < 0.9 ? k.name : k.key, camperId: rnd() < 0.8 ? k.id : undefined, timestamp: t });
    if (rnd() < 0.4) transactions.push({ kind: 'refund', method: m, [idField]: ref, amount: pick([5, 10]), camper: k.name });
    if (rnd() < 0.15 && (!fair || m === 'stripe')) transactions.push({ kind: 'refund_failed', method: m, [idField]: ref, amount: 5, camper: k.name });
    if (rnd() < 0.2) holds.push({ method: pick([method, 'cash']), paymentRef: ref, amount: pick([5, 10]), camperId: k.id, accountKey: k.key, ageSeconds: 10 });
  }
  return { accounts, transactions, holds };
}
const norm = (x: any) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
function compare(fair: boolean) {
  seed = 7;
let same = 0, differ = 0; const examples: string[] = [];
for (let i = 0; i < 400; i++) {
  for (const [k, method, idField] of [['stripeOne', 'stripe', 'stripePaymentIntentId'], ['solaOne', 'cardknox', 'byopTransactionId']] as const) {
    const v = randomView(method, idField, fair);
    const a = norm(now[k].refundableByAccount(v, method, idField)), b = norm(old[k].refundableByAccount(v, method, idField));
    if (a === b) same++; else { differ++; if (examples.length < 3) examples.push(`${k}: now ${a.slice(0, 200)} | before ${b.slice(0, 200)}`); }
  }
  for (const [k, method, idField] of [['stripeAll', 'stripe', 'stripePaymentIntentId'], ['solaAll', 'cardknox', 'byopTransactionId']] as const) {
    const v = randomView(method, idField, fair);
    for (const who of [{ camperId: 1, camperName: 'Avi' }, { camperId: null, camperName: 'Avi' }, { camperId: 6, camperName: 'Avi (2)' }, { camperId: 3, camperName: 'Avi Katz' }]) {
      const args = k === 'solaAll' ? [who, v.transactions, method, v.holds] : [who, v.transactions, v.holds];
      const a = norm(now[k].depositsFor(...args)), b = norm(old[k].depositsFor(...args));
      if (a === b) same++; else { differ++; if (examples.length < 3) examples.push(`${k} ${JSON.stringify(who)}: now ${a.slice(0, 200)} | before ${b.slice(0, 200)}`); }
    }
  }
}
  return { same, differ, examples };
}
for (const fair of [false, true]) {
  const { same, differ, examples } = compare(fair);
  console.log(`\n2${fair ? 'b' : 'a'}. today's answers vs before the change (fef6edb), 400 random ledgers${fair ? ' — WITHOUT a balance floor and without failed-refund rows on non-Stripe payments (the two rules that changed on purpose)' : ' (floors and failed refunds on any payment)'}: ${same} the same, ${differ} different`);
  examples.forEach((e) => console.log('   ' + e));
}
