// =============================================================================
// league_bye_audit.test.js
// -----------------------------------------------------------------------------
// window.byeAudit() — the console report that answers "is the bye landing on a
// different team each time?" after a run of days. build() takes injected
// history + dailyData, so the aggregation is exercised here without a DOM.
// =============================================================================

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const A = require('../league_bye_audit.js');

const LG = 'Soloists';
const TEAMS = ['T1', 'T2', 'T3', 'T4', 'T5'];

// ── builders for the two stores the audit reads ──────────────────────────────

// One saved league period: the tile's matchups array, exactly as the engine
// writes it, keyed the way daily data keys it (date → division → slot).
function period(label, games, byes, chinuch) {
    const matchups = [];
    (games || []).forEach(g => matchups.push(g[0] + ' vs ' + g[1] + ' @ Court 1 (Basketball)'));
    (byes || []).forEach(b => matchups.push(Array.isArray(b) ? (b[0] + ' — Bye: ' + b[1]) : (b + ' — Bye')));
    (chinuch || []).forEach(c => matchups.push(c[0] + ' — Chinuch (' + c[1] + ')'));
    return { leagueName: LG, gameLabel: label, matchups };
}
function dailyData(spec) {
    // spec: { date: [periodObj, …] }
    const out = {};
    Object.keys(spec).forEach(date => {
        const la = { Juniors: {} };
        spec[date].forEach((p, i) => { la.Juniors[String(780 + i * 60)] = p; });
        out[date] = { leagueAssignments: la };
    });
    return out;
}
// The engine's ledger for the same days, so the drift check is satisfied.
function historyFor(spec, chinuchByDate) {
    const gameLog = { [LG]: {} };
    Object.keys(spec).forEach(date => {
        gameLog[LG][date] = [];
        spec[date].forEach(p => {
            (p.matchups || []).forEach(m => {
                const g = /^(.+?) vs (.+?) @/.exec(m);
                if (g) gameLog[LG][date].push({ t1: g[1], t2: g[2], sport: 'Basketball', g: p.gameLabel });
            });
        });
    });
    return { gameLog, chinuchByDate: chinuchByDate ? { [LG]: chinuchByDate } : {} };
}
function run(spec, leagueCfg, chinuchByDate, opts) {
    const dd = dailyData(spec);
    return A.build(Object.assign({
        history: historyFor(spec, chinuchByDate),
        dailyData: dd,
        leagues: [Object.assign({ name: LG, teams: TEAMS.slice() }, leagueCfg || {})],
    }, opts || {})).leagues[0];
}
const codes = (L) => L.findings.map(f => f.code);
const find = (L, code) => L.findings.find(f => f.code === code);

// ── line parsing ─────────────────────────────────────────────────────────────

test('parseLine reads each tile line shape the engine writes', () => {
    assert.deepEqual(A.parseLine('T5 — Bye'), { kind: 'bye', team: 'T5', activity: '' });
    assert.deepEqual(A.parseLine('T5 — Bye: Pool'), { kind: 'bye', team: 'T5', activity: 'Pool' });
    assert.deepEqual(A.parseLine('T1 — Chinuch (Beis Medrash)'),
        { kind: 'chinuch', team: 'T1', room: 'Beis Medrash' });
    assert.deepEqual(A.parseLine('T1 vs T2 @ Court 1 (Basketball)'),
        { kind: 'game', teamA: 'T1', teamB: 'T2' });
    // A team whose NAME contains "vs" or a dash must not be mangled.
    assert.deepEqual(A.parseLine('Red-Sox — Bye: Canteen'),
        { kind: 'bye', team: 'Red-Sox', activity: 'Canteen' });
    // Section rows and noise are ignored.
    assert.equal(A.parseLine('Electives:'), null);
    assert.equal(A.parseLine('  • Pool'), null);
    assert.equal(A.parseLine(''), null);
    assert.equal(A.parseLine(null), null);
});

// ── the happy path ───────────────────────────────────────────────────────────

test('PASS when every team takes its turn on the bye', () => {
    // Five days, five teams, one bye each — the shape a healthy run produces.
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'].forEach((d, i) => {
        const sitter = TEAMS[i];
        const rest = TEAMS.filter(t => t !== sitter);
        spec[d] = [period('Game ' + (i + 1), [[rest[0], rest[1]], [rest[2], rest[3]]], [[sitter, 'Pool']])];
    });
    const L = run(spec, { byeActivity: { enabled: true, activities: ['Pool', 'Canteen'] } });

    assert.equal(L.verdict, 'PASS', 'findings: ' + JSON.stringify(L.findings));
    assert.equal(L.spread, 0);
    assert.equal(L.totalByes, 5);
    TEAMS.forEach(t => assert.equal(L.byTeam[t].byes, 1, t + ' should have exactly one bye'));
    TEAMS.forEach(t => assert.equal(L.byTeam[t].played, 4, t + ' played the other four days'));
    assert.equal(find(L, 'bye-spread').level, 'ok');
});

test('a spread of one still passes — an odd day count cannot divide evenly', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08'].forEach((d, i) => {
        const sitter = TEAMS[i % TEAMS.length];
        const rest = TEAMS.filter(t => t !== sitter);
        spec[d] = [period('Game ' + (i + 1), [[rest[0], rest[1]], [rest[2], rest[3]]], [[sitter, 'Pool']])];
    });
    const L = run(spec);
    assert.equal(L.spread, 1, JSON.stringify(L.byTeam));
    assert.equal(L.verdict, 'PASS');
});

// ── the failure this report exists to catch ──────────────────────────────────

test('FAIL when one team eats every bye', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'].forEach((d, i) => {
        spec[d] = [period('Game ' + (i + 1), [['T1', 'T2'], ['T3', 'T4']], ['T5'])];
    });
    const L = run(spec);

    assert.equal(L.verdict, 'FAIL');
    assert.equal(L.spread, 4);
    const f = find(L, 'bye-spread');
    assert.equal(f.level, 'error');
    assert.match(f.message, /T5 sat out 4/, f.message);
    // Back-to-back byes are called out separately — the totals are not the
    // only way this shows up in real life.
    assert.ok(codes(L).includes('bye-streak'), 'consecutive-day byes should be flagged');
});

test('back-to-back byes are flagged even when the totals come out even', () => {
    // Ten days, each team sitting twice — a perfectly even 2/2/2/2/2 — but each
    // team takes both of its byes on consecutive days. The totals say fine; the
    // camp would say T1 sat out twice in a row.
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07',
                  '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13', '2026-07-14'];
    const spec = {};
    days.forEach((d, i) => {
        const sitter = TEAMS[Math.floor(i / 2)];
        const rest = TEAMS.filter(t => t !== sitter);
        spec[d] = [period('Game ' + (i + 1), [[rest[0], rest[1]], [rest[2], rest[3]]], [[sitter, 'Pool']])];
    });
    const L = run(spec);
    assert.equal(L.spread, 0, 'totals are even: ' + JSON.stringify(L.byTeam));
    assert.equal(L.verdict, 'WARN', 'findings: ' + JSON.stringify(L.findings));
    const streaks = L.findings.filter(f => f.code === 'bye-streak');
    assert.equal(streaks.length, TEAMS.length, 'every team flagged: ' + JSON.stringify(streaks));
    assert.equal(find(L, 'bye-spread').level, 'ok', 'the spread itself is still clean');
});

// ── the bye activity that rides along ────────────────────────────────────────

test('warns when a benched team always draws the same activity from a bigger pool', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])],
        '2026-07-03': [period('Game 2', [['T1', 'T3'], ['T2', 'T4']], [['T5', 'Pool']])],
    };
    const L = run(spec, { byeActivity: { enabled: true, activities: ['Pool', 'Canteen', 'Rink'] } });
    const f = find(L, 'activity-monotony');
    assert.ok(f, 'expected the monotony warning: ' + JSON.stringify(L.findings));
    assert.match(f.message, /T5 got "Pool" on all 2/, f.message);

    // Rotating through the pool is clean.
    const spec2 = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])],
        '2026-07-03': [period('Game 2', [['T1', 'T3'], ['T2', 'T4']], [['T5', 'Canteen']])],
    };
    const L2 = run(spec2, { byeActivity: { enabled: true, activities: ['Pool', 'Canteen', 'Rink'] } });
    assert.ok(!codes(L2).includes('activity-monotony'), JSON.stringify(L2.findings));
    assert.deepEqual(Object.keys(L2.byTeam.T5.activities).sort(), ['Canteen', 'Pool']);
});

test('warns when Bye Activity is on but a benched team got nothing', () => {
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], ['T5'])] };
    const on = run(spec, { byeActivity: { enabled: true, activities: ['Pool'] } });
    assert.ok(codes(on).includes('bye-no-activity'), JSON.stringify(on.findings));
    assert.ok(!codes(on).includes('bye-activity-off'), 'not both at once');
});

test('says so plainly when a bare bye is because the feature is off', () => {
    // Silence here cost a debugging round: the tiles said "Team 29 — Bye", the
    // report said nothing, and the config being off looked like a regression.
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], ['T5'])] };

    const off = run(spec, {});                       // no byeActivity block at all
    var f = find(off, 'bye-activity-off');
    assert.ok(f, JSON.stringify(off.findings));
    assert.equal(f.level, 'info');
    assert.match(f.message, /T5 got a bare bye/);
    assert.match(f.message, /switched off/);
    assert.ok(!codes(off).includes('bye-no-activity'), 'that warning is for a DIFFERENT problem');

    // Enabled but with nothing picked reads differently, and just as plainly.
    const empty = run(spec, { byeActivity: { enabled: true, activities: [], teamActivities: {} } });
    assert.match(find(empty, 'bye-activity-off').message, /on but has no activities picked/);

    // A bye that DID get an activity says nothing at all.
    const good = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])] };
    const okRun = run(good, { byeActivity: { enabled: true, activities: ['Pool'] } });
    assert.ok(!codes(okRun).includes('bye-activity-off'), JSON.stringify(okRun.findings));
});

// ── chinuch rooms ────────────────────────────────────────────────────────────

test('FAIL when a chinuch room was over-filled in one period', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2']],
            [['T5', 'Pool']], [['T3', 'Beis Medrash'], ['T4', 'Beis Medrash']])],
    };
    const L = run(spec, { chinuch: { enabled: true, roomCapacity: { 'Beis Medrash': 1 } } });
    assert.equal(L.verdict, 'FAIL');
    const f = find(L, 'room-overflow');
    assert.match(f.message, /"Beis Medrash" holds 1 but 2 teams/, f.message);
    assert.equal(L.roomIssues.length, 1);
    assert.deepEqual(L.roomIssues[0].teams, ['T3', 'T4']);

    // Same day, room raised to hold both → clean.
    const ok = run(spec, { chinuch: { enabled: true, roomCapacity: { 'Beis Medrash': 2 } } });
    assert.ok(!codes(ok).includes('room-overflow'), JSON.stringify(ok.findings));
});

test('teams in DIFFERENT periods share a room without complaint', () => {
    const spec = {
        '2026-07-01': [
            period('Game 1', [['T1', 'T2']], [['T5', 'Pool']], [['T3', 'Beis Medrash']]),
            period('Game 2', [['T1', 'T3']], [['T5', 'Canteen']], [['T4', 'Beis Medrash']]),
        ],
    };
    const L = run(spec, { chinuch: { enabled: true, roomCapacity: { 'Beis Medrash': 1 } } });
    assert.equal(L.roomIssues.length, 0, JSON.stringify(L.roomIssues));
});

test('a chinuch session is not counted as a bye', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T4', 'T5']], [], [['T3', 'Beis Medrash']])],
    };
    const L = run(spec, { chinuch: { enabled: true } }, { '2026-07-01': ['T3'] });
    assert.equal(L.byTeam.T3.chinuch, 1);
    assert.equal(L.byTeam.T3.byes, 0);
    assert.equal(L.totalByes, 0);
    assert.equal(L.verdict, 'PASS');
    assert.equal(find(L, 'no-byes').level, 'ok');
});

// ── cross-checks and plumbing ────────────────────────────────────────────────

test('flags drift between the saved schedules and the engine ledger', () => {
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])] };
    // History that never learned about this day at all — the grid shows a bye,
    // the fairness ledger sees nothing.
    const L = A.build({
        history: { gameLog: {}, chinuchByDate: {} },
        dailyData: dailyData(spec),
        leagues: [{ name: LG, teams: TEAMS.slice() }],
    }).leagues[0];
    const f = find(L, 'history-drift');
    assert.ok(f, JSON.stringify(L.findings));
    assert.match(f.message, /T5 \(1 on the grid, 0 in history\)/, f.message);
});

test('a game spanning two divisions counts once, not twice', () => {
    const p = period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']]);
    const dd = { '2026-07-01': { leagueAssignments: { Juniors: { '780': p }, Seniors: { '780': p } } } };
    const L = A.build({
        history: historyFor({ '2026-07-01': [p] }),
        dailyData: dd,
        leagues: [{ name: LG, teams: TEAMS.slice() }],
    }).leagues[0];
    assert.equal(L.totalByes, 1, 'the bye is one bye, not two');
    assert.equal(L.byTeam.T1.played, 1, 'the game counts once');
    assert.equal(L.periodCount, 1);
});

test('date range filtering only audits the days asked for', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03'].forEach((d, i) => {
        spec[d] = [period('Game ' + (i + 1), [['T1', 'T2'], ['T3', 'T4']], ['T5'])];
    });
    const all = run(spec);
    assert.equal(all.totalByes, 3);
    const narrowed = run(spec, null, null, { from: '2026-07-02', to: '2026-07-03' });
    assert.equal(narrowed.totalByes, 2);
    assert.deepEqual(narrowed.dates, ['2026-07-02', '2026-07-03']);
});

test('other leagues in the same saved day are ignored', () => {
    const mine = period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']]);
    const theirs = { leagueName: 'Other League', gameLabel: 'Game 1', matchups: ['A vs B @ Court 9 (Soccer)', 'C — Bye'] };
    const dd = { '2026-07-01': { leagueAssignments: { Juniors: { '780': mine, '900': theirs } } } };
    const L = A.build({
        history: historyFor({ '2026-07-01': [mine] }),
        dailyData: dd,
        leagues: [{ name: LG, teams: TEAMS.slice() }],
    }).leagues[0];
    assert.equal(L.totalByes, 1);
    assert.ok(!L.teams.includes('C'), 'another league\'s team leaked in: ' + JSON.stringify(L.teams));
});

test('no saved data reports NO DATA instead of a false pass', () => {
    const L = A.build({ history: {}, dailyData: {}, leagues: [{ name: LG, teams: TEAMS.slice() }] }).leagues[0];
    assert.equal(L.verdict, 'NO DATA');
    assert.equal(find(L, 'no-data').level, 'info');
});

test('a team that only appears in the saved tiles is still audited', () => {
    // Renamed or removed from the roster, but it played — it must not vanish.
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['Ghost', 'T4']], [['T5', 'Pool']])] };
    const L = A.build({
        history: historyFor(spec),
        dailyData: dailyData(spec),
        leagues: [{ name: LG, teams: ['T1', 'T2', 'T4', 'T5'] }],
    }).leagues[0];
    assert.ok(L.teams.includes('Ghost'));
    assert.equal(L.byTeam.Ghost.played, 1);
});

// ── the "(Chinuch)" placeholder is not a room ────────────────────────────────

test('the bare "Chinuch" label is a placeholder, not a one-seat room', () => {
    // The engine writes "T — Chinuch (Chinuch)" when a team has NO room
    // configured; those teams are deliberately unconstrained. Reading the
    // placeholder as a room reported every one of them as an overflow.
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2']], [['T5', 'Pool']],
            [['T3', 'Chinuch'], ['T4', 'Chinuch']])],
    };
    const L = run(spec, { chinuch: { enabled: true, bunkFacilities: {} } });
    assert.equal(L.roomIssues.length, 0, 'placeholder must not be capacity-checked: ' + JSON.stringify(L.roomIssues));
    assert.ok(!codes(L).includes('room-overflow'), JSON.stringify(L.findings));
    assert.equal(L.byTeam.T3.chinuch, 1, 'the session itself still counts');
});

test('a room the league really configured is still checked', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2']], [['T5', 'Pool']],
            [['T3', 'Chinuch'], ['T4', 'Chinuch']])],
    };
    // Same tiles, but the config says both teams belong in one real room — the
    // config is what the engine planned against, so it wins over the label.
    const L = run(spec, { chinuch: { enabled: true,
        bunkFacilities: { T3: 'Beis Medrash', T4: 'Beis Medrash' },
        roomCapacity: { 'Beis Medrash': 1 } } });
    assert.equal(L.roomIssues.length, 1, JSON.stringify(L.roomIssues));
    assert.equal(L.roomIssues[0].room, 'Beis Medrash');
});

test('a camp that literally names a facility "Chinuch" is still checked', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2']], [['T5', 'Pool']],
            [['T3', 'Chinuch'], ['T4', 'Chinuch']])],
    };
    const L = run(spec, { chinuch: { enabled: true,
        bunkFacilities: { T3: 'Chinuch', T4: 'Chinuch' },
        roomCapacity: { 'Chinuch': 1 } } });
    assert.equal(L.roomIssues.length, 1, 'a configured room named "Chinuch" is a real room');
});

// ── drift is diagnosable, not just reported ─────────────────────────────────

test('drift names the days and points at the missing chinuch record', () => {
    // Two days. Day 1 has its chinuch attendance recorded, day 2 does not — so
    // history reads day 2's learning teams as benched.
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T4', 'T5']], [], [['T3', 'Beis Medrash']])],
        '2026-07-02': [period('Game 2', [['T1', 'T3'], ['T4', 'T5']], [], [['T2', 'Beis Medrash']])],
    };
    const L = run(spec, { chinuch: { enabled: true, bunkFacilities: { T2: 'Beis Medrash', T3: 'Beis Medrash' } } },
        { '2026-07-01': ['T3'] });   // day 2 missing on purpose

    assert.ok(codes(L).includes('history-drift'), JSON.stringify(L.findings));
    const days = L.findings.filter(f => f.code === 'history-drift-day');
    assert.equal(days.length, 1, 'only the bad day is named: ' + JSON.stringify(days));
    assert.match(days[0].message, /2026-07-02/);
    assert.match(days[0].message, /chinuch attendance was not recorded/);

    // …and it is escalated, because the fairness ledger is reading those numbers.
    const esc = find(L, 'chinuch-ledger-missing');
    assert.ok(esc, JSON.stringify(L.findings));
    assert.equal(esc.level, 'error');
    assert.equal(L.verdict, 'FAIL');
});

test('no drift means no per-day noise', () => {
    const spec = {
        '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T4', 'T5']], [], [['T3', 'Beis Medrash']])],
    };
    const L = run(spec, { chinuch: { enabled: true } }, { '2026-07-01': ['T3'] });
    assert.ok(!codes(L).includes('history-drift'), JSON.stringify(L.findings));
    assert.ok(!codes(L).includes('history-drift-day'));
    assert.ok(!codes(L).includes('chinuch-ledger-missing'));
});

// ── structural imbalance vs an unfair picker ─────────────────────────────────

test('a lopsided pool is a WARN about chinuch grouping, not a picker failure', () => {
    // Two periods a day. Period 1 has an even active set (no bye). Period 2
    // always has the SAME five teams active, so T1 and T2 — at chinuch during
    // period 2 every day — can never be picked for a bye. Their 0 is structural.
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'];
    const spec = {}, chinuchByDate = {};
    days.forEach((d, i) => {
        const pool = ['T3', 'T4', 'T5'];
        const sitter = pool[i % pool.length];
        const rest = pool.filter(t => t !== sitter);
        spec[d] = [
            period('Game ' + (2 * i + 1), [['T1', 'T2']], [], []),
            period('Game ' + (2 * i + 2), [[rest[0], rest[1]]], [[sitter, 'Pool']],
                [['T1', 'Beis Medrash'], ['T2', 'Beis Medrash']]),
        ];
        chinuchByDate[d] = ['T1', 'T2'];
    });
    const L = run(spec, { chinuch: { enabled: true, roomCapacity: { 'Beis Medrash': 2 } } }, chinuchByDate);

    assert.equal(L.byTeam.T1.eligible, 0, 'T1 was never in the draw');
    assert.equal(L.byTeam.T2.eligible, 0);
    assert.equal(L.byTeam.T3.eligible, 4, 'T3 was in the draw every bye period');

    const f = find(L, 'bye-spread-structural');
    assert.ok(f, 'expected the structural verdict: ' + JSON.stringify(L.findings));
    assert.equal(f.level, 'warn');
    assert.match(f.message, /never entered the draw/);
    assert.match(f.message, /T1, T2/);
    assert.ok(!codes(L).includes('bye-spread'), 'must not also blame the picker');
    assert.equal(L.verdict, 'WARN', 'a lopsided pool is not a FAIL');
});

test('an unfair picker among equally-eligible teams is still a FAIL', () => {
    // All five teams are in the draw every period, and T5 takes every bye.
    const spec = {};
    ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'].forEach((d, i) => {
        spec[d] = [period('Game ' + (i + 1), [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])];
    });
    const L = run(spec);
    TEAMS.forEach(t => assert.equal(L.byTeam[t].eligible, 4, t + ' was eligible every period'));
    assert.equal(Math.round(L.byTeam.T5.expected * 10) / 10, 0.8, 'fair share is 4/5 of a bye');

    const f = find(L, 'bye-spread');
    assert.ok(f, JSON.stringify(L.findings));
    assert.equal(f.level, 'error');
    assert.match(f.message, /this is the picker/);
    assert.equal(L.verdict, 'FAIL');
});

// ── history reaching further back than the saved schedules ───────────────────

test('history days with no saved schedule are reported, not miscalled drift', () => {
    const spec = { '2026-07-06': [period('Game 3', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])] };
    // History also remembers two earlier days this browser has no schedules for.
    const history = historyFor(spec);
    history.gameLog[LG]['2026-07-01'] = [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' }];
    history.gameLog[LG]['2026-07-02'] = [{ t1: 'T3', t2: 'T4', sport: 'Basketball', g: 'Game 2' }];
    const L = A.build({
        history: history, dailyData: dailyData(spec),
        leagues: [{ name: LG, teams: TEAMS.slice() }],
    }).leagues[0];

    // The extra days are called out on their own…
    const info = find(L, 'history-only-days');
    assert.ok(info, JSON.stringify(L.findings));
    assert.equal(info.level, 'info');
    assert.match(info.message, /2026-07-01, 2026-07-02/);
    // …and they do NOT masquerade as a grid/history disagreement.
    assert.ok(!codes(L).includes('history-drift'),
        'uncached days are not drift: ' + JSON.stringify(L.findings));
});

test('real drift on a shared day is still caught alongside uncached days', () => {
    const spec = {
        '2026-07-06': [period('Game 3', [['T1', 'T2'], ['T4', 'T5']], [], [['T3', 'Beis Medrash']])],
    };
    const history = historyFor(spec);                       // no chinuch record
    history.gameLog[LG]['2026-07-01'] = [{ t1: 'T1', t2: 'T2', sport: 'Basketball', g: 'Game 1' }];
    const L = A.build({
        history: history, dailyData: dailyData(spec),
        leagues: [{ name: LG, teams: TEAMS.slice(), chinuch: { enabled: true } }],
    }).leagues[0];

    assert.ok(codes(L).includes('history-only-days'), 'the uncached day is noted');
    const d = find(L, 'history-drift');
    assert.ok(d, 'the shared day still drifts: ' + JSON.stringify(L.findings));
    assert.match(d.message, /T3 \(0 on the grid, 1 in history\)/, d.message);
    assert.ok(codes(L).includes('chinuch-ledger-missing'), 'and the cause is named');
});

// ── the engine's own ledger, surfaced ────────────────────────────────────────

test('flags when the engine ledger disagrees with the schedules', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02'].forEach((d, i) => {
        spec[d] = [period('Game ' + (i + 1), [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])];
    });
    // Stand in for the engine: a ledger that has not seen the second day.
    const prev = global.window;
    global.window = { SchedulerCoreLeagues: { makeByeLedger: function () {
        return { count: function (t) { return t === 'T5' ? 1 : 0; }, staleness: function () { return 0; },
                 counts: { T5: 1 }, unmeasurable: ['2026-06-30'] };
    } } };
    try {
        const L = A.build({ history: historyFor(spec), dailyData: dailyData(spec),
            leagues: [{ name: LG, teams: TEAMS.slice() }] }).leagues[0];
        const f = find(L, 'ledger-mismatch');
        assert.ok(f, 'expected the ledger warning: ' + JSON.stringify(L.findings));
        assert.match(f.message, /T5 \(ledger 1, grid 2\)/, f.message);
        assert.match(f.message, /ignoring 1 day\(s\) it cannot read \(2026-06-30\)/, f.message);
        assert.match(f.message, /Regenerate the affected days IN ORDER/);
    } finally { global.window = prev; }
});

test('confirms when the engine ledger agrees', () => {
    const spec = { '2026-07-01': [period('Game 1', [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])] };
    const prev = global.window;
    global.window = { SchedulerCoreLeagues: { makeByeLedger: function () {
        return { count: function (t) { return t === 'T5' ? 1 : 0; }, staleness: function () { return 0; },
                 counts: { T5: 1 }, unmeasurable: [] };
    } } };
    try {
        const L = A.build({ history: historyFor(spec), dailyData: dailyData(spec),
            leagues: [{ name: LG, teams: TEAMS.slice() }] }).leagues[0];
        assert.ok(find(L, 'ledger-match'), JSON.stringify(L.findings));
        assert.ok(!codes(L).includes('ledger-mismatch'));
    } finally { global.window = prev; }
});

test('the ledger check is skipped for a date range it cannot be compared against', () => {
    const spec = {};
    ['2026-07-01', '2026-07-02'].forEach((d, i) => {
        spec[d] = [period('Game ' + (i + 1), [['T1', 'T2'], ['T3', 'T4']], [['T5', 'Pool']])];
    });
    const prev = global.window;
    global.window = { SchedulerCoreLeagues: { makeByeLedger: function () {
        return { count: function () { return 0; }, staleness: function () { return 0; }, counts: {}, unmeasurable: [] };
    } } };
    try {
        // The ledger spans every date on record, so comparing it against a
        // narrowed window would report a mismatch that isn't one.
        const L = A.build({ history: historyFor(spec), dailyData: dailyData(spec), from: '2026-07-02',
            leagues: [{ name: LG, teams: TEAMS.slice() }] }).leagues[0];
        assert.ok(!codes(L).includes('ledger-mismatch'), JSON.stringify(L.findings));
        assert.ok(!codes(L).includes('ledger-match'));
    } finally { global.window = prev; }
});
