// smarttile_honor_adapter_sim.js
// V44.6 HONOR-ADAPTER: the camp-wide budget layer must not discard a special
// the adapter lawfully placed in a still-free room ("NO BUDGET → Sports Slot"
// while Arts & Crafts sat empty — the "program leaves specials on the table"
// bug, live-traced 2026-07-02). Drives the REAL routeActivity source extracted
// from scheduler_core_main.js with a stubbed closure environment.
//
// Run: node tests/smarttile_honor_adapter_sim.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_main.js'), 'utf8');

// ---- extract the routeActivity function via brace matching ----
const startIdx = src.indexOf('function routeActivity(bunk, activityLabel, blockInfo) {');
if (startIdx === -1) { console.error('FAIL: routeActivity not found'); process.exit(1); }
let depth = 0, endIdx = -1;
for (let i = src.indexOf('{', startIdx); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
}
const fnSrc = src.slice(startIdx, endIdx);

// ---- harness: build routeActivity with a controllable closure ----
function makeEnv(opts = {}) {
    const env = {
        placed: [],            // fillBlock calls
        queued: [],            // schedulableSlotBlocks pushes
        claims: [],            // _registerClaim calls
        tracker: Object.assign({}, opts.tracker || {}),
        specialsToday: opts.specialsToday || {},
        deferred: [],          // _noBudgetDeferred pushes (V44.6 settle pass)
        consumed: new Set(),   // _budgetConsumed marks
    };
    const knownSpecialNames = new Set((opts.specials || ['sushi making', 'arts & crafts', 'gaming center', 'archery']));
    const budget = opts.budget || {};
    const claimable = opts.claimable !== undefined ? opts.claimable : true;
    const gated = opts.gated || (() => false);

    const windowObj = {
        __smartTileHonorAdapterSpecials: opts.killSwitch === false ? false : undefined,
        scheduleAssignments: {},
        fillBlock: (blk, fill) => env.placed.push({ bunk: blk.bunk, activity: fill._activity }),
        isFullGradeForDivision: () => false,
        GlobalFieldLocks: { isFieldLocked: () => false },
    };

    const fn = new Function(
        'window', 'Utils', 'divName', 'job', 'smartTileBudget', 'knownSpecialNames', 'knownSportNames',
        '_bunkSpecialsToday', '_specialGateBlocks', '_getSharableWith', '_canClaim', '_registerClaim',
        'fieldUsageBySlot', 'yesterdayHistory', 'activityProperties', 'schedulableSlotBlocks',
        '_groupOpenUsed', 'bunkList', 'normalizeCategoryLabel', 'sharedCapacityTracker', 'historicalCounts',
        'getLocationForActivity', '_canClaimDirectFill', '_registerDirectFillClaim', '_directFillCap', '_mayTakeCapped',
        '_noBudgetDeferred', '_budgetConsumed',
        `function needsGeneration(activityLabel) {
            const cat = normalizeCategoryLabel(activityLabel);
            if (!cat) return false;
            if (cat === 'sport' && (activityProperties?.["Sports"] || activityProperties?.["sports"])) return false;
            return true;
        }
        return (${fnSrc});`
    )(
        windowObj,
        { findSlotsForRange: () => [0], canBlockFit: () => true },
        opts.divName || '7',
        opts.job || { main1: 'Special', main2: 'Swim', fallbackActivity: 'Sports' },
        budget,
        knownSpecialNames,
        new Set(['kickball']),
        env.specialsToday,
        gated,
        () => ({ capacity: 1 }),
        () => claimable,
        (name, s, e, d) => env.claims.push(name),
        {}, {}, {},
        { push: (b) => env.queued.push(b) },
        {},
        opts.bunkList || ['b1'],
        (label) => {
            const l = String(label || '').toLowerCase().trim();
            if (/sport/.test(l)) return 'sport';
            if (/special/.test(l)) return 'special';
            if (/activit/.test(l)) return 'activity';
            return null;
        },
        env.tracker,
        {},
        () => null,          // getLocationForActivity
        () => true,          // _canClaimDirectFill
        () => {},            // _registerDirectFillClaim
        () => Infinity,      // _directFillCap
        () => true,          // _mayTakeCapped
        env.deferred,        // _noBudgetDeferred
        env.consumed         // _budgetConsumed
    );
    env.route = fn;
    return env;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// TEST 1 — the live bug: budget=false, adapter resolved a special, room free → HONORED
{
    const env = makeEnv({ budget: { '7|b1|930|1010': false } });
    env.route('b1', 'Sushi Making', { startMin: 930, endMin: 1010 });
    check('T1 budget-veto lifted: free special honored',
        env.placed.length === 1 && env.placed[0].activity === 'Sushi Making'
        && env.claims.includes('Sushi Making') && env.queued.length === 0,
        JSON.stringify({ placed: env.placed, queued: env.queued.map(q => q.event) }));
    check('T1b no-doubles set updated', env.specialsToday['b1'] && env.specialsToday['b1'].has('sushi making'));
}

// TEST 2 — room claim-blocked → DEFERRED to the settle pass (not demoted yet;
// the blocker may be a stranded budget claim that settle releases)
{
    const env = makeEnv({ budget: { '7|b1|930|1010': false }, claimable: false });
    env.route('b1', 'Sushi Making', { startMin: 930, endMin: 1010 });
    check('T2 claim-blocked special is deferred, not demoted',
        env.placed.length === 0 && env.queued.length === 0
        && env.deferred.length === 1 && env.deferred[0].activityLabel === 'Sushi Making'
        && env.deferred[0].bunk === 'b1' && env.deferred[0].fbAct === 'Sports',
        JSON.stringify({ queued: env.queued, deferred: env.deferred }));
}

// TEST 3 — bunk rotation-gated (cooldown/maxUsage) → demotes, never honored
{
    const env = makeEnv({ budget: { '7|b1|930|1010': false }, gated: () => true });
    env.route('b1', 'Sushi Making', { startMin: 930, endMin: 1010 });
    check('T3 gated bunk still demotes', env.placed.length === 0 && env.queued.length === 1);
}

// TEST 4 — bunk already had this special today → demotes (no doubling)
{
    const env = makeEnv({
        budget: { '7|b1|930|1010': false },
        specialsToday: { b1: new Set(['sushi making']) },
    });
    env.route('b1', 'Sushi Making', { startMin: 930, endMin: 1010 });
    check('T4 had-today still demotes', env.placed.length === 0 && env.queued.length === 1);
}

// TEST 5 — kill switch restores legacy demote
{
    const env = makeEnv({ budget: { '7|b1|930|1010': false }, killSwitch: false });
    env.route('b1', 'Sushi Making', { startMin: 930, endMin: 1010 });
    check('T5 kill switch → legacy NO BUDGET demote',
        env.placed.length === 0 && env.queued.length === 1 && env.queued[0].event === 'Sports Slot');
}

// TEST 6 — PRE-ASSIGNED name differs from adapter: tracker rebalanced (the
// phantom "Gaming Center 1 used by other grades" corruption from the trace)
{
    const env = makeEnv({
        budget: { '7|b1|740|805': 'Archery' },
        tracker: { 'Gaming Center|740|805': 1 },
    });
    env.route('b1', 'Gaming Center', { startMin: 740, endMin: 805 });
    check('T6 pre-assigned placed under budget name',
        env.placed.length === 1 && env.placed[0].activity === 'Archery');
    check('T6b tracker: adapter name released, budget name recorded',
        env.tracker['Gaming Center|740|805'] === 0 && env.tracker['Archery|740|805'] === 1,
        JSON.stringify(env.tracker));
    check('T6c no-doubles records the ACTUAL placement', env.specialsToday['b1'].has('archery'));
}

// TEST 7 — PRE-ASSIGNED same name as adapter: tracker untouched (adapter already recorded)
{
    const env = makeEnv({
        budget: { '7|b1|740|805': 'Gaming Center' },
        tracker: { 'Gaming Center|740|805': 1 },
    });
    env.route('b1', 'Gaming Center', { startMin: 740, endMin: 805 });
    check('T7 same-name pre-assign leaves tracker alone',
        env.tracker['Gaming Center|740|805'] === 1 && env.placed[0].activity === 'Gaming Center');
    check('T7b pre-assign marks budget key CONSUMED (settle must not release its claim)',
        env.consumed.has('7|b1|740|805'));
}

// TEST 8 — direct-fill label (Swim) bypasses budget/honor entirely (unchanged path)
{
    const env = makeEnv({ budget: { '7|b1|930|1010': false } });
    env.route('b1', 'Swim', { startMin: 930, endMin: 1010 });
    check('T8 Swim direct-fill path untouched by honor logic',
        !env.placed.some(p => p.activity !== 'Swim') && env.queued.length === 0);
}

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
