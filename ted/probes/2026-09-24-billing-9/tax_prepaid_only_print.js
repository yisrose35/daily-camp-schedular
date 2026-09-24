// Probe (9th pass). The REAL printTaxStatement (cut from campistry_me.js) and
// the real campistry_tax_statement.js, with a tiny fake page, for the most
// common year-end family there is: tuition for a DATED session (Summer 2026,
// starts 1 Jul 2026) billed in October 2025, and a $500 deposit paid in
// December 2025. The 2025 statement is what the office prints in January 2026.
// Correct answer: nothing claimable for 2025; the $500 is next year's.
// What does the printed page actually SAY?
//   A. only the deposit was paid in 2025
//   B. the family also paid its 2025 summer in 2025 (so a child row exists)
// Run: node ted/probes/2026-09-24-billing-9/tax_prepaid_only_print.js
const fs = require('fs');
const R = '/home/user/daily-camp-schedular';
const src = fs.readFileSync(R + '/campistry_me.js', 'utf8');
const m = src.match(/async function printTaxStatement\(famKey,year\)\{[\s\S]*?\n\}\n/);
if (!m) throw new Error('printTaxStatement not found');
const TS = require(R + '/campistry_tax_statement.js');

function run(label, entries, year) {
  let html = '';
  const window = { CampistryTaxStatement: TS, open: () => ({ document: { write: (h) => { html += h; }, close: () => {} } }), CampistryDB: null, supabase: {
    rpc: async () => ({ data: { success: true, tax_id: '12-3456789' } }) } };
  const ctx = {
    window,
    localStorage: { getItem: () => JSON.stringify({ camp_name: 'Camp Test', camp_address: '1 Lake Rd' }) },
    buildFamilyLedgers: () => ({ gold: { family: { name: 'Gold', camperIds: ['Avi'] }, pendingCamperIds: [], entries } }),
    getCampId: () => 'camp1',
    enrollments: { e25: { camperName: 'Avi', camperId: 7, session: 'Summer 2025' }, e26: { camperName: 'Avi', camperId: 7, session: 'Summer 2026' } },
    sessions: [{ name: 'Summer 2025', startDate: '2025-07-01', endDate: '2025-08-15' }, { name: 'Summer 2026', startDate: '2026-07-01', endDate: '2026-08-15' }],
    _camperIdOf: () => null, roster: {},
    esc: (s) => String(s), fm: (n) => '$' + Number(n || 0).toLocaleString('en-US'), _lbl: (k) => k, toast: () => {},
  };
  const fn = new Function(...Object.keys(ctx), m[0] + '; return printTaxStatement;')(...Object.values(ctx));
  return fn('gold', year).then(() => {
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<(div|p|tr|h1|h2)[^>]*>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
    const keep = text.split('\n').map(s => s.trim()).filter(s => /Not ready|Missing|paid in|could not|split|Total|Avi|No payments|billed/.test(s) && !/^This statement shows/.test(s));
    console.log(`\n== ${label} — ${year} statement`);
    keep.forEach(s => console.log('   ' + s.slice(0, 210)));
  });
}

const t26 = { type: 'charge', amount: 3000, date: '2025-10-01', desc: 'Avi — Summer 2026', category: 'Tuition', ref: 'e26' };
const t25 = { type: 'charge', amount: 2800, date: '2024-10-01', desc: 'Avi — Summer 2025', category: 'Tuition', ref: 'e25' };
(async () => {
  await run('A. only a December deposit for next summer', [t26, { type: 'payment', amount: 500, date: '2025-12-10' }], 2025);
  await run('B. this summer paid + a December deposit for next summer', [t25, { type: 'payment', amount: 2800, date: '2025-05-01' }, t26, { type: 'payment', amount: 500, date: '2025-12-10' }], 2025);
  console.log('\nExpected: $0 claimable for A and $2,800 for B, the $500 described as paid toward care in 2026 (claim it on the 2026 return). ' +
    'Nothing should say the $500 "could not be matched" or must be "split by hand", nor that the camp "had not been billed yet" (it was billed 1 Oct 2025).');
})();
