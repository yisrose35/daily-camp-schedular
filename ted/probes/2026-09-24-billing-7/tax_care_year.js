// Probe (7th pass, TED-101 re-check): the tax statement with Me's REAL
// resolveCharge (its text is cut out of campistry_me.js's printTaxStatement and
// run against a small enrollments/sessions set), for:
//   A. enrolled Oct 2025 for a DATED summer-2026 session, Dec deposit, spring rest
//   B. the same, but the session has no dates (camps may leave them blank)
//   C. A + the family cancels in March 2026 and the deposit is refunded
//   D. arrears: summer 2025 tuition, part paid March 2026
//   E. A + a partial refund in 2026 of a 2026 payment
// Run: node ted/probes/2026-09-24-billing-7/tax_care_year.js
const fs = require('fs');
const T = require('/home/user/daily-camp-schedular/campistry_tax_statement.js');
const src = fs.readFileSync('/home/user/daily-camp-schedular/campistry_me.js', 'utf8');
const m = src.match(/function resolveCharge\(entry\)\{[\s\S]*?\n    \}\n/);
if (!m) throw new Error('resolveCharge not found in campistry_me.js');
function makeResolve(enrollments, sessions) {
  const _camperIdOf = () => null;
  // eslint-disable-next-line no-new-func
  return new Function('enrollments', 'sessions', '_camperIdOf', m[0] + '; return resolveCharge;')(enrollments, sessions, _camperIdOf);
}
const enr = { e26: { camperName: 'Avi Katz', camperId: 7, session: 'Summer 2026' }, e25: { camperName: 'Avi Katz', camperId: 7, session: 'Summer 2025' } };
const dated = [{ name: 'Summer 2026', startDate: '2026-07-01', endDate: '2026-08-15' }, { name: 'Summer 2025', startDate: '2025-07-01', endDate: '2025-08-15' }];
const undated = [{ name: 'Summer 2026' }, { name: 'Summer 2025' }];
const tuition = { type: 'charge', amount: 3000, date: '2025-10-01', desc: 'Avi Katz — Summer 2026', category: 'Tuition', ref: 'e26' };
function show(label, entries, sessions) {
  const resolve = makeResolve(enr, sessions);
  for (const y of [2025, 2026]) {
    const r = T.build({ year: y, entries, resolveCharge: resolve });
    const rowTotal = r.byCamper.reduce((s, b) => s + b.total, 0);
    console.log(`${label} | ${y}: claimable ${r.qualifying} | prepaid ${r.prepaid} | paidEarlier ${r.paidEarlier} | paid.net ${r.paid.net} | child-row total ${rowTotal}` + (r.warnings.length ? ` | warnings ${r.warnings.length}` : ''));
  }
}
console.log('careYear from Me for e26 (dated):', JSON.stringify(makeResolve(enr, dated)({ ref: 'e26' }).careYear),
            '(undated):', JSON.stringify(makeResolve(enr, undated)({ ref: 'e26' }).careYear));
const A = [tuition, { type: 'payment', amount: 500, date: '2025-12-10' }, { type: 'payment', amount: 2500, date: '2026-05-01' }];
show('A dated     ', A, dated);
show('B undated   ', A, undated);
const C = [tuition, { type: 'payment', amount: 500, date: '2025-12-10' },
           { type: 'credit', amount: 3000, date: '2026-03-01', desc: 'Cancelled' },
           { type: 'payment', amount: -500, date: '2026-03-02', desc: 'Refund' }];
show('C cancelled ', C, dated);
const D = [{ type: 'charge', amount: 3000, date: '2025-03-01', desc: 'Avi Katz — Summer 2025', category: 'Tuition', ref: 'e25' },
           { type: 'payment', amount: 2000, date: '2025-06-01' }, { type: 'payment', amount: 1000, date: '2026-03-01' }];
show('D arrears   ', D, dated);
const E = A.concat([{ type: 'payment', amount: -250, date: '2026-09-01', desc: 'Refund' }]);
show('E part-refnd', E, dated);
console.log('Expected (Pub 503 as the module quotes it): A → 2025 0/prepaid 500, 2026 3000. C → 0 claimable both years.',
            'D → 2025 2000, 2026 1000. E → 2026 2750 (3000 care − 250 refunded).');
