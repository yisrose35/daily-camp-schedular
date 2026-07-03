// smarttile_recency_tiebreak_sim.js
// Head-counselor rotation: with few shared special rooms, week-counts tie
// constantly and the old seniority tiebreak handed the senior division a room
// nearly EVERY day (9th grade: specials daily, never Swim/Pickleball; 8th
// squeezed out). The recency tiebreak (longest-since-any-special first) makes
// bunks CYCLE special → pickleball/swim across days. Drives the REAL
// _needSenCmp source extracted from scheduler_core_main.js.
//
// Run: node tests/smarttile_recency_tiebreak_sim.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_main.js'), 'utf8');
const start = src.indexOf('const _needSenCmp = ');
if (start === -1) { console.error('FAIL: _needSenCmp not found'); process.exit(1); }
const endMarker = '(Math.random() - 0.5);';
const end = src.indexOf(endMarker, start);
const cmpSrc = src.slice(start + 'const _needSenCmp = '.length, end + endMarker.length - 1);

function makeCmp({ counts, gaps, sen, recency = true }) {
    return new Function('_bunkSpecialCount', '_recencyTiebreak', '_bunkLastSpecialGap', '_senOf',
        `return (${cmpSrc});`)(
        (b) => counts[b] || 0,
        recency,
        (b) => (b in gaps ? gaps[b] : 99999),
        (d) => sen[d]
    );
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- comparator micro-tests ----
{
    const sen = { '9': 0, '8': 1 };
    // T1: equal week-counts → longest-since-special wins, even against seniority
    let cmp = makeCmp({ counts: { a9: 1, b8: 1 }, gaps: { a9: 1, b8: 3 }, sen });
    check('T1 equal counts: staler 8th bunk outranks fresh 9th bunk',
        cmp('b8', '8', 'a9', '9') < 0 && cmp('a9', '9', 'b8', '8') > 0);
    // T2: count still dominates recency
    cmp = makeCmp({ counts: { a9: 0, b8: 2 }, gaps: { a9: 1, b8: 5 }, sen });
    check('T2 lower week-count beats staler recency', cmp('a9', '9', 'b8', '8') < 0);
    // T3: counts AND gaps equal → seniority decides (9th first)
    cmp = makeCmp({ counts: { a9: 1, b8: 1 }, gaps: { a9: 2, b8: 2 }, sen });
    check('T3 full tie → seniority (9th first)', cmp('a9', '9', 'b8', '8') < 0);
    // T4: kill switch → pure seniority at count ties (legacy behavior)
    cmp = makeCmp({ counts: { a9: 1, b8: 1 }, gaps: { a9: 1, b8: 9 }, sen, recency: false });
    check('T4 kill switch restores seniority-at-ties', cmp('a9', '9', 'b8', '8') < 0);
    // T5: never-done bunk (gap 99999) outranks everyone at equal counts
    cmp = makeCmp({ counts: { a9: 1, b8: 1 }, gaps: { a9: 2 }, sen });
    check('T5 never-done special = neediest at equal counts', cmp('b8', '8', 'a9', '9') < 0);
}

// ---- 7-day policy simulation of the live 8/9 window ----
// 3 ninth-grade bunks + 8 eighth-grade bunks share 5 cap-1 special rooms per
// day; Pickleball = 2 nets, camp-wide least-recent queue; everyone else swims.
{
    const sen = { '9': 0, '8': 1 };
    const bunks = [
        ...['ט1', 'ט2', 'ט3'].map(b => ({ b, div: '9' })),
        ...['ח1', 'ח2', 'ח3', 'ח4', 'ח5', 'ח6', 'ח7', 'ח8'].map(b => ({ b, div: '8' })),
    ];
    const ROOMS = 5, NETS = 2, DAYS = 7;
    const weekCount = {}, lastSpecialDay = {}, lastPickleDay = {}, log = {};
    bunks.forEach(({ b }) => { weekCount[b] = 0; log[b] = []; });

    for (let day = 1; day <= DAYS; day++) {
        const gaps = {};
        bunks.forEach(({ b }) => { gaps[b] = (b in lastSpecialDay) ? (day - lastSpecialDay[b]) : 99999; });
        const cmp = makeCmp({ counts: weekCount, gaps, sen });
        // pickleball queue: 2 least-recent-pickleball winners camp-wide (stable order)
        const winners = [...bunks].sort((a, b2) =>
            ((a.b in lastPickleDay ? lastPickleDay[a.b] : -99) - (b2.b in lastPickleDay ? lastPickleDay[b2.b] : -99))
        ).slice(0, NETS).map(x => x.b);
        // specials: top-5 by the REAL comparator (prefer-main1: special beats a net win)
        const ranked = [...bunks].sort((a, b2) => cmp(a.b, a.div, b2.b, b2.div));
        const special = new Set(ranked.slice(0, ROOMS).map(x => x.b));
        bunks.forEach(({ b }) => {
            if (special.has(b)) { weekCount[b]++; lastSpecialDay[b] = day; log[b].push('S'); }
            else if (winners.includes(b)) { lastPickleDay[b] = day; log[b].push('P'); }
            else log[b].push('W');
        });
    }

    const spec = (b) => log[b].filter(x => x === 'S').length;
    const maxStreak = (b) => log[b].join('').split(/[^S]/).reduce((m, s) => Math.max(m, s.length), 0);
    const allSpecs = bunks.map(({ b }) => spec(b));
    check('T6 every bunk gets 2-4 specials over the week (35 slots / 11 bunks)',
        allSpecs.every(c => c >= 2 && c <= 4), JSON.stringify(allSpecs));
    check('T7 no bunk runs 3+ consecutive special days',
        bunks.every(({ b }) => maxStreak(b) <= 2),
        bunks.map(({ b }) => `${b}:${log[b].join('')}`).join(' '));
    check('T8 every 9th-grade bunk gets Swim and/or Pickleball days (not specials daily)',
        ['ט1', 'ט2', 'ט3'].every(b => log[b].some(x => x !== 'S')));
    check('T9 8th grade is not squeezed out: every 8th bunk gets >=2 specials',
        bunks.filter(x => x.div === '8').every(({ b }) => spec(b) >= 2));
    const gotPickle = bunks.filter(({ b }) => log[b].includes('P')).length;
    check('T10 pickleball nets rotate broadly (>=8 of 11 bunks within the week)',
        gotPickle >= 8, `got pickleball: ${gotPickle}/11`);
    console.log('\n  Week grid (S=special, P=pickleball, W=swim):');
    bunks.forEach(({ b, div }) => console.log(`    div${div} ${b}: ${log[b].join(' ')}`));
}

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
