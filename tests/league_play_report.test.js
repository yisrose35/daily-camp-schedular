'use strict';
// Tests for window.LeaguePlayReport.buildData / matchupCounts — the pure
// aggregation behind the league post-edit mini report and the Play History tab.
// History is injected so no window/DOM stubs beyond a bare global are needed.

const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
const LPR = require('../league_play_report.js');

// Regular-league history: gameLog[leagueName][date] = [{ t1, t2, sport, g }]
function regularHistory() {
  return {
    gameLog: {
      'Junior League': {
        '2026-07-06': [
          { t1: 'Lions', t2: 'Tigers', sport: 'Baseball', g: 'Game 1' },
          { t1: 'Bears', t2: 'Wolves', sport: 'Hockey', g: 'Game 1' }
        ],
        '2026-07-05': [
          { t1: 'Lions', t2: 'Bears', sport: 'Basketball', g: 'Game 1' },
          { t1: 'Tigers', t2: 'Wolves', sport: 'Baseball', g: 'Game 1' }
        ]
      }
    }
  };
}

const REGULAR_CFG = {
  name: 'Junior League',
  teams: ['Lions', 'Tigers', 'Bears', 'Wolves'],
  sports: ['Baseball', 'Basketball', 'Hockey']
};

test('buildData — regular league: counts per team, sport, and opponent', () => {
  const d = LPR.buildData(REGULAR_CFG, 'regular', regularHistory());
  assert.strictEqual(d.totalGames, 4);
  assert.deepStrictEqual(d.dates, ['2026-07-06', '2026-07-05']); // newest first
  assert.strictEqual(d.teams.length, 4);

  const lions = d.byTeam['Lions'];
  assert.strictEqual(lions.total, 2);
  assert.strictEqual(lions.sports['Baseball'], 1);
  assert.strictEqual(lions.sports['Basketball'], 1);
  assert.strictEqual(lions.opponents['Tigers'], 1);
  assert.strictEqual(lions.opponents['Bears'], 1);

  const wolves = d.byTeam['Wolves'];
  assert.strictEqual(wolves.total, 2);
  assert.strictEqual(wolves.sports['Hockey'], 1);
  assert.strictEqual(wolves.sports['Baseball'], 1);
});

test('buildData — games are date-desc and carry when/who/what', () => {
  const d = LPR.buildData(REGULAR_CFG, 'regular', regularHistory());
  assert.strictEqual(d.games[0].date, '2026-07-06');
  assert.strictEqual(d.games[0].teamA, 'Lions');
  assert.strictEqual(d.games[0].teamB, 'Tigers');
  assert.strictEqual(d.games[0].sport, 'Baseball');
  assert.strictEqual(d.games[0].label, 'Game 1');
  assert.strictEqual(d.games[3].date, '2026-07-05');
});

test('buildData — sport column order follows league config, extras appended', () => {
  const hist = regularHistory();
  hist.gameLog['Junior League']['2026-07-04'] = [{ t1: 'Lions', t2: 'Wolves', sport: 'Kickball', g: 'Game 1' }];
  const d = LPR.buildData(REGULAR_CFG, 'regular', hist);
  assert.deepStrictEqual(d.sports, ['Baseball', 'Basketball', 'Hockey', 'Kickball']);
});

test('buildData — team only present in the log (renamed/removed) still appears', () => {
  const hist = regularHistory();
  hist.gameLog['Junior League']['2026-07-06'].push({ t1: 'Old Name', t2: 'Lions', sport: 'Baseball', g: 'Game 2' });
  const d = LPR.buildData(REGULAR_CFG, 'regular', hist);
  assert.ok(d.teams.includes('Old Name'));
  assert.strictEqual(d.byTeam['Old Name'].total, 1);
  assert.strictEqual(d.byTeam['Lions'].total, 3);
});

test('buildData — league name matched case-insensitively in the gameLog', () => {
  const d = LPR.buildData({ name: 'junior league', teams: [] }, 'regular', regularHistory());
  assert.strictEqual(d.totalGames, 4);
});

test('buildData — empty history yields zeroed report, not a crash', () => {
  const d = LPR.buildData(REGULAR_CFG, 'regular', { gameLog: {} });
  assert.strictEqual(d.totalGames, 0);
  assert.deepStrictEqual(d.games, []);
  assert.strictEqual(d.byTeam['Lions'].total, 0);
});

// Specialty history: gameLog[leagueId][date] = [{ tA, tB, field, g, s }]
// (no per-entry sport — the league has ONE sport on its config).
test('buildData — specialty league: keyed by id, sport from config, field kept', () => {
  const hist = {
    gameLog: {
      'sl-123': {
        '2026-07-06': [
          { tA: 'Aces', tB: 'Kings', field: 'Court 1', g: 'Game 3', s: 0 },
          { tA: 'Queens', tB: 'Jacks', field: 'Court 2', g: 'Game 3', s: 1 }
        ]
      }
    }
  };
  const cfg = { id: 'sl-123', name: 'Hoops League', sport: 'Basketball', teams: ['Aces', 'Kings', 'Queens', 'Jacks'] };
  const d = LPR.buildData(cfg, 'specialty', hist);
  assert.strictEqual(d.totalGames, 2);
  assert.strictEqual(d.games[0].sport, 'Basketball'); // league-level sport
  assert.strictEqual(d.games[0].field, 'Court 1');
  assert.strictEqual(d.byTeam['Aces'].sports['Basketball'], 1);
  assert.strictEqual(d.byTeam['Aces'].opponents['Kings'], 1);
});

test('matchupCounts — unordered pairs aggregated across dates', () => {
  const hist = regularHistory();
  // Rematch on a later date, reversed order — must count as the same pair.
  hist.gameLog['Junior League']['2026-07-07'] = [{ t1: 'Tigers', t2: 'Lions', sport: 'Hockey', g: 'Game 1' }];
  const d = LPR.buildData(REGULAR_CFG, 'regular', hist);
  const mc = LPR.matchupCounts(d);
  const lt = mc.find(m => [m.teamA, m.teamB].sort().join('|') === 'Lions|Tigers');
  assert.strictEqual(lt.count, 2);
  assert.strictEqual(mc[0], lt); // most-played pair sorts first
});

test('pairSummary — count and most recent meeting, order-insensitive', () => {
  const d = LPR.buildData(REGULAR_CFG, 'regular', regularHistory());
  const s = LPR.pairSummary(null, 'regular', 'tigers', 'LIONS', d); // case/order-proof
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.last.date, '2026-07-06');
  assert.strictEqual(s.last.sport, 'Baseball');
  const none = LPR.pairSummary(null, 'regular', 'Lions', 'Wolves', d);
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.last, null);
});

test('pairNoteHtml — first meeting vs rematch annotations', () => {
  const d = LPR.buildData(REGULAR_CFG, 'regular', regularHistory());
  assert.match(LPR.pairNoteHtml(null, 'regular', 'Lions', 'Wolves', d), /First meeting/);
  assert.match(LPR.pairNoteHtml(null, 'regular', 'Lions', 'Tigers', d), /Played 1×/);
});

test('renderMiniBody / renderMiniCard — never throw without a DOM', () => {
  // Renderers are string builders; they must degrade gracefully when the
  // page globals (loadGlobalSettings etc.) are absent.
  const body = LPR.renderMiniBody('Nonexistent League', 'regular');
  assert.strictEqual(typeof body, 'string');
  const card = LPR.renderMiniCard('Nonexistent League', 'regular');
  assert.strictEqual(typeof card, 'string');
});
