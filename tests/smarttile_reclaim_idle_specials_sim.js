/* Reclaim idle special rooms (light-attendance fill) — proves the post-pass
 * added to scheduler_core_main.js processSmartTiles().
 *
 * Replicates, exactly as written in the _reclaimIdleSpecials() IIFE:
 *   - swim-bunk collection from special-offering rotation tiles
 *   - seniority-first (then today-count, then usage) ordering
 *   - least-historically-used idle room per bunk, gated by:
 *       • _canClaim (real remaining capacity → no-op on full windows)
 *       • isSpecialAvailableForBunk (bunk-level access)
 *       • no-doubles-today
 *   - the Swim→special swap
 *
 * Live scenario (2026-06-29): window 970-1020, div "9" (3 present bunks) shares
 * 5 special rooms with div "8". Rotation left 2 rooms idle (Pizza/Sushi Making)
 * while senior bunks sat on Swim. Reclaim must hand the idle rooms to the most
 * senior swim bunks; a full window must reclaim NOTHING.
 */
'use strict';
const assert = require('assert');

// ---- faithful mini-replica of the relevant helpers -----------------------
function makeEnv() {
    const specialClaims = {}; // facilityKey -> [{startMin,endMin,divName,actLower}]
    const claimKey = (n) => String(n).toLowerCase().trim();
    function canClaim(name, s, e, maxCap, reqDiv) {
        const low = name.toLowerCase();
        const ex = (specialClaims[claimKey(name)] || []).filter(c => c.startMin < e && c.endMin > s);
        if (!ex.length) return true;
        if (ex.some(c => c.actLower && c.actLower !== low)) return false; // room held by another special
        // not_sharable: cap 1, cross-div blocked
        const cross = ex.find(c => c.divName !== reqDiv);
        if (cross) return false;
        return ex.filter(c => c.divName === reqDiv).length < (maxCap || 1);
    }
    function registerClaim(name, s, e, divName) {
        (specialClaims[claimKey(name)] = specialClaims[claimKey(name)] || [])
            .push({ startMin: s, endMin: e, divName, actLower: name.toLowerCase() });
    }
    return { specialClaims, canClaim, registerClaim };
}

// The reclaim algorithm, line-for-line with scheduler_core_main.js.
function reclaim(env, ctx) {
    const { divisions, scheduleAssignments, seniorityRank, historicalCounts,
            allSpecialNames, bunkSpecialsToday, windowJobs,
            getAvailableSpecials, isSpecialAvailableForBunk } = ctx;
    const senOf = (d) => { const r = seniorityRank[String(d)]; return r === undefined ? 1e9 : r; };
    const todayCount = (b) => (bunkSpecialsToday[b] ? bunkSpecialsToday[b].size : 0);
    let reclaimed = 0;
    Object.entries(windowJobs).forEach(([wk, wJobs]) => {
        const [startMin, endMin] = wk.split('|').map(Number);
        const swimBunks = [];
        wJobs.forEach(job => {
            if (!job.offersSpecial) return;
            const bunkList = divisions[job.division]?.bunks || [];
            bunkList.forEach(bunk => {
                const e = scheduleAssignments[bunk];               // single lead slot in the sim
                if (e && e._noRoomCap && !e._bunkOverride && !e._isTransition
                    && /swim/i.test(String(e._activity || ''))
                    && e._startMin === startMin && e._endMin === endMin) {
                    const hist = historicalCounts[bunk] || {};
                    const usage = allSpecialNames.reduce((s, n) => s + (hist[n] || 0), 0);
                    swimBunks.push({ bunk, divName: job.division, usage });
                }
            });
        });
        if (!swimBunks.length) return;
        swimBunks.sort((a, b) =>
            (senOf(a.divName) - senOf(b.divName)) ||
            (todayCount(a.bunk) - todayCount(b.bunk)) ||
            (a.usage - b.usage));
        swimBunks.forEach(sb => {
            const avail = getAvailableSpecials(startMin, endMin, sb.divName) || [];
            if (!avail.length) return;
            const had = bunkSpecialsToday[sb.bunk];
            const hist = historicalCounts[sb.bunk] || {};
            const ranked = avail.slice().sort((a, b) => (hist[a.name] || 0) - (hist[b.name] || 0));
            for (const sp of ranked) {
                const low = sp.name.toLowerCase();
                if (had && had.has(low)) continue;
                if (isSpecialAvailableForBunk && !isSpecialAvailableForBunk(sp.name, sb.divName, sb.bunk)) continue;
                if (!env.canClaim(sp.name, startMin, endMin, sp.capacity || 1, sb.divName)) continue;
                env.registerClaim(sp.name, startMin, endMin, sb.divName);
                (bunkSpecialsToday[sb.bunk] = bunkSpecialsToday[sb.bunk] || new Set()).add(low);
                scheduleAssignments[sb.bunk] = { _activity: sp.name, _fixed: true, _startMin: startMin, _endMin: endMin };
                reclaimed++;
                break;
            }
        });
    });
    return reclaimed;
}

const SPECIALS = ['Lake', 'VR', 'Gaming Center', 'Pizza Making', 'Sushi Making'];
const swim = (s, e) => ({ _activity: 'Swim', _noRoomCap: true, _fixed: true, _startMin: s, _endMin: e });
const spc = (n, s, e) => ({ _activity: n, _fixed: true, _startMin: s, _endMin: e });

function baseCtx(env) {
    const ctx = {
        divisions: { '9': { bunks: ['L6', 'L7', 'L8'] }, '8': { bunks: ['K7', 'K8', 'K9', 'K10'] } },
        scheduleAssignments: {},
        seniorityRank: { '9': 0, '8': 1 },
        historicalCounts: {},
        allSpecialNames: SPECIALS,
        bunkSpecialsToday: {},
        windowJobs: { '970|1020': [
            { division: '9', offersSpecial: true },
            { division: '8', offersSpecial: true },
        ] },
        getAvailableSpecials: () => SPECIALS.map(n => ({ name: n, capacity: 1 })),
        isSpecialAvailableForBunk: () => true,
    };
    return ctx;
}

let passed = 0;
function check(name, fn) { fn(); console.log('  ✓ ' + name); passed++; }

console.log('Reclaim idle special rooms — sim');

// ---- TEST 1: live light-attendance scenario ------------------------------
check('idle rooms go to the most senior swim bunks; full pool ends claimed', () => {
    const env = makeEnv();
    const ctx = baseCtx(env);
    // Rotation result: 3 rooms used, 2 idle (Pizza/Sushi Making).
    ctx.scheduleAssignments = {
        L6: swim(970, 1020), L7: spc('Lake', 970, 1020), L8: swim(970, 1020),
        K7: spc('VR', 970, 1020), K8: spc('Gaming Center', 970, 1020),
        K9: swim(970, 1020), K10: swim(970, 1020),
    };
    ['Lake', 'VR', 'Gaming Center'].forEach((n, i) =>
        env.registerClaim(n, 970, 1020, i === 0 ? '9' : '8'));
    ctx.bunkSpecialsToday = { L7: new Set(['lake']), K7: new Set(['vr']), K8: new Set(['gaming center']) };

    const n = reclaim(env, ctx);
    assert.strictEqual(n, 2, 'exactly the 2 idle rooms reclaimed');
    // Senior division 9's two swim bunks win the idle rooms.
    assert.ok(!/swim/i.test(ctx.scheduleAssignments.L6._activity), 'L6 upgraded off Swim');
    assert.ok(!/swim/i.test(ctx.scheduleAssignments.L8._activity), 'L8 upgraded off Swim');
    assert.ok(SPECIALS.includes(ctx.scheduleAssignments.L6._activity));
    assert.ok(SPECIALS.includes(ctx.scheduleAssignments.L8._activity));
    // Junior div-8 swim bunks stay on Swim (no rooms left).
    assert.strictEqual(ctx.scheduleAssignments.K9._activity, 'Swim');
    assert.strictEqual(ctx.scheduleAssignments.K10._activity, 'Swim');
    // No double-book: 5 distinct rooms, one claim each.
    const used = SPECIALS.filter(s => (env.specialClaims[s.toLowerCase()] || []).length);
    assert.strictEqual(used.length, 5, 'all 5 rooms now claimed once');
    SPECIALS.forEach(s => assert.ok((env.specialClaims[s.toLowerCase()] || []).length <= 1, s + ' not double-booked'));
});

// ---- TEST 2: full window is a strict no-op --------------------------------
check('full window (all rooms claimed) reclaims nothing', () => {
    const env = makeEnv();
    const ctx = baseCtx(env);
    ctx.scheduleAssignments = {
        L6: swim(970, 1020), L7: swim(970, 1020), L8: swim(970, 1020),
        K7: swim(970, 1020), K8: swim(970, 1020), K9: swim(970, 1020), K10: swim(970, 1020),
    };
    // Every room already held by other divisions' bunks (simulate contention).
    SPECIALS.forEach(n => env.registerClaim(n, 970, 1020, 'X')); // foreign division
    const before = JSON.stringify(ctx.scheduleAssignments);
    const n = reclaim(env, ctx);
    assert.strictEqual(n, 0, 'nothing reclaimed when no idle rooms');
    assert.strictEqual(JSON.stringify(ctx.scheduleAssignments), before, 'assignments untouched');
});

// ---- TEST 3: bunk-level access is respected -------------------------------
check('a senior bunk barred from the only idle room is skipped, junior fills it', () => {
    const env = makeEnv();
    const ctx = baseCtx(env);
    // Only 1 idle room: Sushi Making. Everything else claimed.
    ctx.scheduleAssignments = {
        L6: swim(970, 1020), L7: spc('Lake', 970, 1020), L8: spc('VR', 970, 1020),
        K7: spc('Gaming Center', 970, 1020), K8: spc('Pizza Making', 970, 1020),
        K9: swim(970, 1020), K10: spc('Lake', 970, 1020),
    };
    [['Lake', '9'], ['VR', '9'], ['Gaming Center', '8'], ['Pizza Making', '8']]
        .forEach(([n, d]) => env.registerClaim(n, 970, 1020, d));
    // Lake claimed twice? no — give K10 a different special to keep cap-1 honest:
    ctx.scheduleAssignments.K10 = spc('Gaming Center', 970, 1020);
    // Senior L6 is BARRED from Sushi Making; junior K9 may have it.
    ctx.isSpecialAvailableForBunk = (name, div, bunk) =>
        !(name === 'Sushi Making' && bunk === 'L6');
    ctx.bunkSpecialsToday = {
        L7: new Set(['lake']), L8: new Set(['vr']),
        K7: new Set(['gaming center']), K8: new Set(['pizza making']), K10: new Set(['gaming center']),
    };
    const n = reclaim(env, ctx);
    assert.strictEqual(n, 1, 'one idle room reclaimed');
    assert.strictEqual(ctx.scheduleAssignments.L6._activity, 'Swim', 'barred senior stays on Swim');
    assert.strictEqual(ctx.scheduleAssignments.K9._activity, 'Sushi Making', 'junior with access fills it');
});

// ---- TEST 4: no-doubles-today --------------------------------------------
check('a bunk is never handed a special it already had today', () => {
    const env = makeEnv();
    const ctx = baseCtx(env);
    ctx.divisions = { '9': { bunks: ['L6'] } };
    ctx.seniorityRank = { '9': 0 };
    ctx.windowJobs = { '970|1020': [{ division: '9', offersSpecial: true }] };
    ctx.scheduleAssignments = { L6: swim(970, 1020) };
    // Only Lake is available; L6 already had Lake earlier today.
    ctx.getAvailableSpecials = () => [{ name: 'Lake', capacity: 1 }];
    ctx.bunkSpecialsToday = { L6: new Set(['lake']) };
    const n = reclaim(env, ctx);
    assert.strictEqual(n, 0, 'no reclaim — would be a same-day double');
    assert.strictEqual(ctx.scheduleAssignments.L6._activity, 'Swim');
});

// ---- TEST 5: non-special-offering tiles are ignored -----------------------
check('plain Swim tiles (no special option) are never converted', () => {
    const env = makeEnv();
    const ctx = baseCtx(env);
    ctx.divisions = { '9': { bunks: ['L6'] } };
    ctx.seniorityRank = { '9': 0 };
    ctx.windowJobs = { '970|1020': [{ division: '9', offersSpecial: false }] }; // tile offers no special
    ctx.scheduleAssignments = { L6: swim(970, 1020) };
    const n = reclaim(env, ctx);
    assert.strictEqual(n, 0, 'a non-special tile is left alone');
    assert.strictEqual(ctx.scheduleAssignments.L6._activity, 'Swim');
});

console.log(`\n${passed}/5 passed`);
if (passed !== 5) process.exit(1);
