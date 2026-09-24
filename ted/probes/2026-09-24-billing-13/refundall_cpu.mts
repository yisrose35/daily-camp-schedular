// Probe (13th pass): CPU time of Refund All's own per-child maths — the REAL
// depositsFor, cut verbatim from supabase/functions/stripe-canteen-refund-all/
// index.ts at run time — run for every child with money on the wallet, the
// way one Refund All run does (Stripe's answers are I/O and not counted).
// Run: node --experimental-strip-types ted/probes/2026-09-24-billing-13/refundall_cpu.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const src = fs.readFileSync('/home/user/daily-camp-schedular/supabase/functions/stripe-canteen-refund-all/index.ts', 'utf8');
const piece = (name: string) => { const at = src.indexOf('function ' + name + '('); return src.slice(at, src.indexOf('\n}\n', at) + 3); };
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rall-')), 'fn.ts');
fs.writeFileSync(tmp, 'type DepositRemainder = { paymentIntentId: string; remaining: number; timestamp: number };\n' + piece('round2') + piece('depositsFor') + '\nexport { depositsFor };\n');
const { depositsFor } = await import(tmp);
for (const [a, e, r] of [[600, 8, 2], [1000, 10, 2], [1000, 15, 3]]) {
  const txs: any[] = [];
  for (let i = 1; i <= a; i++) for (let t = 1; t <= e; t++) {
    txs.push({ kind: 'deposit', method: 'stripe', stripePaymentIntentId: `pi_${i}_${t}`, amount: 25, camper: 'Camper ' + i, camperId: i, timestamp: t });
    if (t <= r) txs.push({ kind: 'refund', method: 'stripe', stripePaymentIntentId: `pi_${i}_${t}`, amount: 5, camper: 'Camper ' + i, camperId: i });
  }
  const t0 = process.cpuUsage();
  let n = 0;
  for (let i = 1; i <= a; i++) n += depositsFor({ camperId: i, camperName: 'Camper ' + i }, txs, []).length;
  const u = process.cpuUsage(t0);
  console.log(`${String(a).padStart(5)} children × ${String(e).padStart(2)} top-ups (${txs.length} ledger rows): ${String(Math.round((u.user + u.system) / 1000)).padStart(5)} ms CPU for Refund All's sums (${n} top-ups found)`);
}
