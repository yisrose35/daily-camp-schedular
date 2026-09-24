// Probe (8th pass, TED-101/107 re-check): new edge cases for the builder's two
// new rules, with Me's REAL resolveCharge (cut from campistry_me.js) and the real
// campistry_tax_statement.js.
//   F. dated: Dec 2025 deposit 500, 2026 pays 2500, then cancels in 2026 and gets ALL 3000 back
//   G. dated: Dec 2025 deposit 500, 2026 pays 2500, then 2026 refund of 800 (part of the deposit era)
//   J. UNDATED session, re-enrolled during camp: charged 2026-08-01 for next summer, deposit paid 2026-08-01, rest 2027
//   K. UNDATED fall program charged 2026-09-05, paid 2026-09-05, care given Oct 2026 (same year)
//   L. printed Total row (claimedTotal) vs child rows for A (dated) 2026
// Run: node ted/probes/2026-09-24-billing-8/tax_edges.js
const fs = require('fs');
const T = require('/home/user/daily-camp-schedular/campistry_tax_statement.js');
const src = fs.readFileSync('/home/user/daily-camp-schedular/campistry_me.js', 'utf8');
const m = src.match(/function resolveCharge\(entry\)\{[\s\S]*?\n    \}\n/);
if (!m) throw new Error('resolveCharge not found in campistry_me.js');
const makeResolve = (enrollments, sessions) => new Function('enrollments', 'sessions', '_camperIdOf', m[0] + '; return resolveCharge;')(enrollments, sessions, () => null);
const enr = { e26: { camperName: 'Avi Katz', camperId: 7, session: 'Summer 2026' }, e27: { camperName: 'Avi Katz', camperId: 7, session: 'Summer 2027' },
              ef: { camperName: 'Avi Katz', camperId: 7, session: 'Fall Sundays' } };
const dated = [{ name: 'Summer 2026', startDate: '2026-07-01', endDate: '2026-08-15' }];
const undated = [{ name: 'Summer 2027' }, { name: 'Fall Sundays' }];
function show(label, entries, sessions, years) {
  const resolve = makeResolve(enr, sessions);
  for (const y of years) {
    const r = T.build({ year: y, entries, resolveCharge: resolve });
    const rowTotal = r.byCamper.reduce((s, b) => s + b.total, 0);
    console.log(`${label} | ${y}: claimable ${r.qualifying} | prepaid ${r.prepaid} | paidEarlier ${r.paidEarlier} | paid.net ${r.paid.net} | rows ${rowTotal} | claimedTotal ${r.claimedTotal}`);
    r.warnings.forEach(w => console.log('      warn: ' + w.slice(0, 150)));
  }
}
const tuition26 = { type: 'charge', amount: 3000, date: '2025-10-01', desc: 'Avi — Summer 2026', category: 'Tuition', ref: 'e26' };
show('F full cancel ', [tuition26, { type: 'payment', amount: 500, date: '2025-12-10' }, { type: 'payment', amount: 2500, date: '2026-05-01' },
  { type: 'credit', amount: 3000, date: '2026-06-01', desc: 'Cancelled' }, { type: 'payment', amount: -3000, date: '2026-06-02', desc: 'Refund' }], dated, [2025, 2026]);
show('G part refund ', [tuition26, { type: 'payment', amount: 500, date: '2025-12-10' }, { type: 'payment', amount: 2500, date: '2026-05-01' },
  { type: 'payment', amount: -800, date: '2026-06-02', desc: 'Refund' }], dated, [2026]);
show('J undated Aug ', [{ type: 'charge', amount: 3000, date: '2026-08-01', desc: 'Avi — Summer 2027', category: 'Tuition', ref: 'e27' },
  { type: 'payment', amount: 500, date: '2026-08-01' }, { type: 'payment', amount: 2500, date: '2027-05-01' }], undated, [2026, 2027]);
show('K undated fall', [{ type: 'charge', amount: 400, date: '2026-09-05', desc: 'Avi — Fall Sundays', category: 'Tuition', ref: 'ef' },
  { type: 'payment', amount: 400, date: '2026-09-05' }], undated, [2026, 2027]);
console.log('Expected: F 2026 → 0. G 2026 → 2200 (3000 care − 800 refunded). J → 2026 0 (prepaid 500), 2027 3000 — or at least a warning. K → 2026 400 (care given in 2026) — or at least a warning.');
