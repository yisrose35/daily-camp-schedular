// Probe (6th pass): a December deposit for next summer. The module says (Pub 503)
// prepaid money belongs on the return for the year the care is GIVEN. Does the
// NEXT year's statement then include it?
const T = require('/home/user/daily-camp-schedular/campistry_tax_statement.js');
const entries = [
  { type: 'payment', amount: 500, date: '2025-12-10', desc: 'Deposit for summer 2026' },
  { type: 'charge', amount: 3000, date: '2026-01-15', desc: 'Tuition', category: 'tuition' },
  { type: 'payment', amount: 2500, date: '2026-05-01' },
];
const who = () => ({ camperName: 'Avi', camperId: 7 });
for (const y of [2025, 2026]) {
  const r = T.build({ year: y, entries, resolveCharge: who });
  console.log(y, 'paid.net', r.paid.net, '| qualifying', r.qualifying, '| prepaid', r.prepaid, '| warnings:', r.warnings.join(' / ').slice(0, 160));
}
console.log('care given in 2026 cost 3000; the parent can claim at most (2025 statement 0) + (2026 statement) — should be 3000');

// The realistic order: the child is ENROLLED for summer 2026 in October 2025 —
// Me dates the tuition charge on enrolledDate (campistry_me.js:16403) — then
// the family pays a December deposit and the rest in spring.
const real = [
  { type: 'charge', amount: 3000, date: '2025-10-01', desc: 'Avi — Summer 2026', category: 'Tuition', ref: 'e26' },
  { type: 'payment', amount: 500, date: '2025-12-10' },
  { type: 'payment', amount: 2500, date: '2026-05-01' },
];
for (const y of [2025, 2026]) {
  const r = T.build({ year: y, entries: real, resolveCharge: who });
  console.log('enrolled Oct 2025 for summer 2026:', y, 'statement → claimable', r.qualifying, '| prepaid (not claimable yet)', r.prepaid);
}
console.log('Pub 503 (quoted in the module): all 3000 belongs on the 2026 return, 0 on 2025');
