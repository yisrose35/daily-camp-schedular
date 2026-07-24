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
//
// ★ DETERMINISM. _needSenCmp ends in a `(Math.random() - 0.5)` tiebreak for
//   bunks that tie on count, recency AND seniority, so ONE simulated week is a
//   coin toss — the old single-run version of T10 asserted "pickleball reached
//   >=8 of 11 bunks" against a distribution whose bottom 6% lands on 7, and
//   flaked about 1 run in 12. Nothing was wrong with the engine; the test was
//   sampling a random variable once and asserting on its tail.
//
//   Instead: replace Math.random with a seeded PRNG and run the week once per
//   seed. Every run is reproducible, and the assertions are made against the
//   DISTRIBUTION rather than a lucky draw — which is strictly stronger than
//   before, because T6-T9 now have to hold for every one of the seeds rather
//   than for whichever week happened to come out.
//
//   Thresholds come from measurement, not guesswork: over 1000 seeds the
//   pickleball spread never fell below 7/11 and was >=8/11 in 91-95% of weeks
//   (stable to within a few points across independent 200-seed bands). Because
//   the seeds are fixed these are now exact numbers, not samples — seeds 1-200
//   score 95.5%, and the same run with the recency tiebreak turned OFF (the
//   legacy seniority behaviour this whole file exists to prevent regressing to)
//   scores 84%. The 90% threshold sits between them with room on both sides.
{
    const SEEDS = 200;
    const MIN_SPREAD = 7;          // measured floor — never seen lower
    const BROAD_SPREAD = 8;        // "rotates broadly"
    const BROAD_RATE_MIN = 0.90;   // this build: 0.955 · legacy seniority: 0.84

    // mulberry32 — small, fast, well-distributed. Any seeded PRNG would do; the
    // point is only that the sequence is fixed.
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const sen = { '9': 0, '8': 1 };
    const bunks = [
        ...['ט1', 'ט2', 'ט3'].map(b => ({ b, div: '9' })),
        ...['ח1', 'ח2', 'ח3', 'ח4', 'ח5', 'ח6', 'ח7', 'ח8'].map(b => ({ b, div: '8' })),
    ];
    const ROOMS = 5, NETS = 2, DAYS = 7;

    function simulateWeek() {
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
        return {
            log,
            specs: bunks.map(({ b }) => spec(b)),
            t6: bunks.every(({ b }) => spec(b) >= 2 && spec(b) <= 4),
            t7: bunks.every(({ b }) => maxStreak(b) <= 2),
            t8: ['ט1', 'ט2', 'ט3'].every(b => log[b].some(x => x !== 'S')),
            t9: bunks.filter(x => x.div === '8').every(({ b }) => spec(b) >= 2),
            pickle: bunks.filter(({ b }) => log[b].includes('P')).length,
        };
    }

    const realRandom = Math.random;
    const runs = [];
    try {
        for (let seed = 1; seed <= SEEDS; seed++) {
            Math.random = mulberry32(seed);
            runs.push(Object.assign({ seed }, simulateWeek()));
        }
    } finally {
        Math.random = realRandom;   // never leave the global stubbed
    }

    const firstBad = (key) => runs.find(r => !r[key]);
    const bad6 = firstBad('t6'), bad7 = firstBad('t7'), bad8 = firstBad('t8'), bad9 = firstBad('t9');

    check(`T6 every bunk gets 2-4 specials over the week, in all ${SEEDS} weeks (35 slots / 11 bunks)`,
        !bad6, bad6 && `seed ${bad6.seed}: ${JSON.stringify(bad6.specs)}`);
    check(`T7 no bunk runs 3+ consecutive special days, in all ${SEEDS} weeks`,
        !bad7, bad7 && `seed ${bad7.seed}: ` + bunks.map(({ b }) => `${b}:${bad7.log[b].join('')}`).join(' '));
    check(`T8 every 9th-grade bunk gets Swim and/or Pickleball days, in all ${SEEDS} weeks`,
        !bad8, bad8 && `seed ${bad8.seed}`);
    check(`T9 8th grade is never squeezed out (>=2 specials each), in all ${SEEDS} weeks`,
        !bad9, bad9 && `seed ${bad9.seed}: ` + JSON.stringify(bad9.specs));

    const spreads = runs.map(r => r.pickle);
    const minSpread = Math.min(...spreads);
    const broadRate = spreads.filter(p => p >= BROAD_SPREAD).length / spreads.length;
    const worst = runs.find(r => r.pickle === minSpread);
    check(`T10a pickleball never collapses below ${MIN_SPREAD}/11 bunks (${SEEDS} weeks)`,
        minSpread >= MIN_SPREAD, `worst was ${minSpread}/11 at seed ${worst && worst.seed}`);
    check(`T10b pickleball reaches >=${BROAD_SPREAD}/11 in at least ${(BROAD_RATE_MIN * 100).toFixed(0)}% of weeks`,
        broadRate >= BROAD_RATE_MIN, `only ${(broadRate * 100).toFixed(1)}%`);

    const hist = {};
    spreads.forEach(p => { hist[p] = (hist[p] || 0) + 1; });
    console.log('\n  Pickleball spread over ' + SEEDS + ' seeded weeks:');
    Object.keys(hist).map(Number).sort((a, b) => a - b)
        .forEach(k => console.log(`    ${k}/11 bunks: ${hist[k]} week(s)`));

    console.log('\n  Week grid for seed 1 (S=special, P=pickleball, W=swim):');
    bunks.forEach(({ b, div }) => console.log(`    div${div} ${b}: ${runs[0].log[b].join(' ')}`));
}

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
