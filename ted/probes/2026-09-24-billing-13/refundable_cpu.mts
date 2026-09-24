// Probe (13th pass): CPU time of the REAL refundableByAccount (cut verbatim
// from supabase/functions/stripe-canteen-refund/index.ts at run time) on camps
// of growing size — the work stripe-canteen-refund does for every `holds`
// call the Snacks Refund window now makes (TED-130). Supabase edge functions
// are stopped after 2 s of CPU per request (their documented limit).
// Run: node --experimental-strip-types ted/probes/2026-09-24-billing-13/refundable_cpu.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const src = fs.readFileSync('/home/user/daily-camp-schedular/supabase/functions/stripe-canteen-refund/index.ts', 'utf8');
const piece = (name: string) => { const at = src.indexOf('function ' + name + '('); return src.slice(at, src.indexOf('\n}\n', at) + 3); };
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rba-')), 'fn.ts');
fs.writeFileSync(tmp, piece('round2') + piece('refundableByAccount') + '\nexport { refundableByAccount };\n');
const { refundableByAccount } = await import(tmp);
function view(accounts: number, each: number, refunds: number) {
  const acc: any = {}, txs: any[] = [], holds: any[] = [];
  for (let a = 1; a <= accounts; a++) {
    const key = 'Camper ' + a; acc[key] = { balance: 50, balanceFloor: 0, camperId: a };
    for (let t = 1; t <= each; t++) {
      const ref = `pi_${a}_${t}`;
      txs.push({ kind: 'deposit', method: 'stripe', stripePaymentIntentId: ref, amount: 25, camper: key, camperId: a });
      if (t <= refunds) txs.push({ kind: 'refund', method: 'stripe', stripePaymentIntentId: ref, amount: 5, camper: key, camperId: a });
    }
  }
  return { accounts: acc, transactions: txs, holds };
}
console.log(`machine: ${os.cpus()[0].model}, node ${process.version}`);
for (const [a, e, r] of [[300, 8, 2], [600, 8, 2], [600, 12, 3], [800, 12, 3], [1000, 10, 2], [1000, 15, 3]]) {
  const v = view(a, e, r);
  const t0 = process.cpuUsage();
  const out = refundableByAccount(v, 'stripe', 'stripePaymentIntentId');
  const u = process.cpuUsage(t0);
  const ms = Math.round((u.user + u.system) / 1000);
  console.log(`${String(a).padStart(5)} children × ${String(e).padStart(2)} top-ups, ${String(r)} refunds each (${v.transactions.length} ledger rows): ${String(ms).padStart(5)} ms CPU${ms > 2000 ? '  ← over 2 s' : ''}   (child 1: ${JSON.stringify(out['Camper 1'])})`);
}
