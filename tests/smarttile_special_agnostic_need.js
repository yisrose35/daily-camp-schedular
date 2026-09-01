// smarttile_special_agnostic_need.js
// POLICY (camp owner): the specials are all different, but "whose turn is it to
// get a special today" treats them as ONE interchangeable prize. If bunk 1 had a
// special yesterday and bunk 2 didn't, bunk 2 goes first today — even when the
// room actually up for grabs today is a DIFFERENT special than the one bunk 1 had.
//
// Drives the REAL sources extracted from scheduler_core_main.js:
//   _bunkSpecialCount  — sums the period count over ALL specials, never the offer
//   _needOf            — that sum + specials already placed today
//   the guarantee pre-pass bunk ordering (used to sort on lifetime totals alone,
//                        so an equal-lifetime tie fell to random and the bunk that
//                        had one yesterday could win again)
//
// Run: node tests/smarttile_special_agnostic_need.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_main.js'), 'utf8');

function extract(startMarker, endMarker, label) {
    const s = src.indexOf(startMarker);
    if (s === -1) { console.error(`FAIL: ${label} not found (marker: ${startMarker})`); process.exit(1); }
    const e = src.indexOf(endMarker, s);
    if (e === -1) { console.error(`FAIL: ${label} end not found`); process.exit(1); }
    return src.slice(s, e + endMarker.length);
}

// --- the need metric -------------------------------------------------------
const countSrc = extract('const _bunkSpecialCount = (bunk) => {', '\n        };', '_bunkSpecialCount');
const needOfSrc = extract('const _needOf = (bunk) => ', ';', '_needOf');

// Build _needOf over injected history. `perDayPerSpecial[bunk][special]` = count of
// PAST days this period the bunk did that special (what getPeriodActivityCount returns).
function makeNeedOf({ allSpecialNames, perDayPerSpecial, today = {} }) {
    return new Function(
        '_allSpecialNames', '_gpc', '_needPeriod', 'historicalCounts', '_todayCount',
        `const _scCache = {};
         ${countSrc}
         ${needOfSrc}
         return _needOf;`
    )(
        allSpecialNames,
        (bunk, name) => (perDayPerSpecial[bunk] || {})[name] || 0,
        '1week',
        {},
        (b) => (today[b] || 0)
    );
}

// --- the guarantee pre-pass bunk ordering ----------------------------------
const orderedSrc = extract('const ordered = [...bunkList].map(b => {', '.map(r => r.b);', 'guarantee ordering');

function orderBunks({ bunkList, allSpecialNames, historicalCounts, divPriority = [], needOf, gaps, needFirst = true, recency = true }) {
    return new Function(
        'bunkList', '_allSpecialNames', 'historicalCounts', 'divPriority',
        '_needFirst', '_needOf', '_recencyTiebreak', '_bunkLastSpecialGap',
        `${orderedSrc}
         return ordered;`
    )(
        bunkList, allSpecialNames, historicalCounts, divPriority,
        needFirst, needOf, recency, (b) => (b in gaps ? gaps[b] : 99999)
    );
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const SPECIALS = ['Lake', 'VR', 'Gaming', 'Pizza'];

console.log('\n--- need is summed across ALL specials, not the one on offer ---');
{
    // bunk1 had Lake yesterday; bunk2 had nothing. Today's open room is VR — a
    // DIFFERENT special. Per-special thinking would call them equal on VR (both 0).
    const needOf = makeNeedOf({
        allSpecialNames: SPECIALS,
        perDayPerSpecial: { bunk1: { Lake: 1 }, bunk2: {} }
    });
    check('bunk1 (had Lake) outranked by bunk2 (had none) even though today is VR',
        needOf('bunk1') === 1 && needOf('bunk2') === 0,
        `needOf bunk1=${needOf('bunk1')} bunk2=${needOf('bunk2')}`);

    // Same bunks scored ONLY on the special being offered would tie at 0.
    const perSpecialVR = (b) => ({ bunk1: 0, bunk2: 0 })[b];
    check('a per-special score would have tied them (the bug this rules out)',
        perSpecialVR('bunk1') === perSpecialVR('bunk2'));
}

console.log('\n--- specials already placed TODAY count too ---');
{
    const needOf = makeNeedOf({
        allSpecialNames: SPECIALS,
        perDayPerSpecial: { bunk1: {}, bunk2: {} },
        today: { bunk1: 1 }   // bunk1 already picked one up in an earlier window today
    });
    check('bunk1 (special earlier today) yields the next window to bunk2',
        needOf('bunk1') === 1 && needOf('bunk2') === 0,
        `needOf bunk1=${needOf('bunk1')} bunk2=${needOf('bunk2')}`);
}

console.log('\n--- guarantee pre-pass ordering (the pass that was still lifetime-only) ---');
{
    // Both bunks have the SAME lifetime totals (4 specials each) — the old sort tied
    // here and fell through to Math.random(). bunk1 had one yesterday (gap 1),
    // bunk2 has gone 4 days (gap 4).
    const historicalCounts = {
        bunk1: { Lake: 2, VR: 1, Gaming: 1 },
        bunk2: { Pizza: 3, VR: 1 }
    };
    const needOf = makeNeedOf({
        allSpecialNames: SPECIALS,
        perDayPerSpecial: { bunk1: { Lake: 1 }, bunk2: {} }
    });
    const ordered = orderBunks({
        bunkList: ['bunk1', 'bunk2'], allSpecialNames: SPECIALS, historicalCounts,
        needOf, gaps: { bunk1: 1, bunk2: 4 }
    });
    check('lower this-period need goes first (bunk2 before bunk1)',
        ordered[0] === 'bunk2', `order = ${ordered.join(', ')}`);

    // Equal period counts (e.g. Monday, when the week count resets to 0 for everyone):
    // only the days-since-ANY-special gap remembers who had one yesterday.
    const needOfMonday = makeNeedOf({
        allSpecialNames: SPECIALS,
        perDayPerSpecial: { bunk1: {}, bunk2: {} }
    });
    const orderedMonday = orderBunks({
        bunkList: ['bunk1', 'bunk2'], allSpecialNames: SPECIALS, historicalCounts,
        needOf: needOfMonday, gaps: { bunk1: 1, bunk2: 4 }
    });
    check('period reset (Monday): staler bunk2 still goes first on the recency gap',
        orderedMonday[0] === 'bunk2', `order = ${orderedMonday.join(', ')}`);

    // A bunk that has never had ANY special is the neediest.
    const orderedNever = orderBunks({
        bunkList: ['bunk1', 'bunk2'], allSpecialNames: SPECIALS, historicalCounts,
        needOf: needOfMonday, gaps: { bunk1: 1 }   // bunk2 absent → 99999
    });
    check('never-had-a-special bunk ranks first',
        orderedNever[0] === 'bunk2', `order = ${orderedNever.join(', ')}`);

    // Kill switch → legacy lifetime-only ordering (bunk1 lifetime 4, bunk2 4 → tie,
    // so assert only that the need/recency keys are genuinely off).
    const a = orderBunks({
        bunkList: ['bunk1', 'bunk2'], allSpecialNames: SPECIALS,
        historicalCounts: { bunk1: { Lake: 9 }, bunk2: { Pizza: 1 } },
        needOf, gaps: { bunk1: 1, bunk2: 4 }, needFirst: false
    });
    check('__smartTileNeedFirst=false restores lifetime-only ordering',
        a[0] === 'bunk2', `order = ${a.join(', ')}`);
}

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
