// =========================================================================
// tile_removal_confirm_sim.js — the delete-confirmation impact scan
//
// Deleting a tile now applies to the already-generated day, so the Delete
// button gets a confirmation. The prompt is gated on IMPACT, not on the click:
// a tile with nothing generated under it is a pure layout edit and must not
// prompt at all. That gate is what makes "don't ask again" safe to offer —
// the prompt only ever appears when something real is about to be dropped, so
// silencing it silences a real signal rather than routine noise.
//
// Replicates verbatim: _daRemovalImpact (daily_adjustments.js).
// Run: node --test tests/tile_removal_confirm_sim.js
// =========================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// ── mirror: _daRemovalImpact (daily_adjustments.js) ────────────────────────
function _daRemovalImpact(tiles, divisions, sa, la) {
  const out = { generated: false, bunkCount: 0, activities: [], leagueGames: [] };
  const acts = new Set();
  const seenGames = new Set();
  const isGameLine = (m) => {
    const line = (m && typeof m === 'object') ? String(m.display || m.matchup || m.text || '') : String(m == null ? '' : m);
    return /\s+vs\.?\s+/i.test(line);
  };

  (tiles || []).forEach(t => {
    const dn = t && t.division != null ? String(t.division) : null;
    const s = t && t.startMin;
    if (!dn || s == null) return;
    // Entries are addressed by their own start time. A tile with no end time
    // (or a zero-length one) still matches whatever starts at its own start —
    // deriving the upper bound from `s` rather than a bogus end keeps that
    // from collapsing into an empty window that matches nothing.
    const lo = s - 2;
    const hi = (t.endMin != null && t.endMin > s) ? t.endMin - 2 : s + 2;
    const inWindow = (v) => v != null && v >= lo && v < hi;

    ((divisions[dn] || {}).bunks || []).forEach(b => {
      const arr = sa[String(b)];
      if (!Array.isArray(arr)) return;
      let hit = false;
      arr.forEach(en => {
        if (!en || en.continuation || en._isTransition) return;
        if (!inWindow(en._startMin)) return;
        const name = en._activity || en.field;
        if (!name) return;
        acts.add(String(name));
        hit = true;
      });
      if (hit) out.bunkCount++;
    });

    const map = la[dn];
    if (map && typeof map === 'object') {
      Object.keys(map).forEach(k => {
        const g = map[k];
        if (!g || !g.leagueName || !inWindow(g._startMin)) return;
        const key = g.leagueName + '|' + (g.gameLabel || k);
        if (seenGames.has(key)) return;
        seenGames.add(key);
        out.leagueGames.push({
          label: g.gameLabel || 'League game',
          league: g.leagueName,
          matchupCount: (g.matchups || []).filter(isGameLine).length
        });
      });
    }
  });

  out.activities = [...acts];
  out.generated = out.bunkCount > 0 || out.leagueGames.length > 0;
  return out;
}

const DIVS = { A: { bunks: ['A1', 'A2'] }, B: { bunks: ['B1'] } };
const ent = (a, s, extra) => Object.assign({ _activity: a, _startMin: s }, extra || {});
const LEAGUE_TILE = { division: 'A', startMin: 780, endMin: 840 };   // 1:00–2:00

// =========================================================================
test('no prompt when nothing is generated under the tile', () => {
  const r = _daRemovalImpact([LEAGUE_TILE], DIVS, { A1: [], A2: [] }, {});
  assert.strictEqual(r.generated, false, 'pure layout edit → delete straight through');
  assert.strictEqual(r.bunkCount, 0);
});

test('empty (null) slots under the tile are not "generated"', () => {
  const r = _daRemovalImpact([LEAGUE_TILE], DIVS, { A1: [null, null], A2: [null] }, {});
  assert.strictEqual(r.generated, false);
});

// =========================================================================
test('reports the league game and its real matchup count', () => {
  const la = {
    A: {
      1: {
        leagueName: 'Camp League', gameLabel: 'Game 7', _startMin: 780,
        matchups: ['T1 vs T2', 'T3 vs T4', 'T5 vs T6', 'T7 — Bye', 'T8 — Chinuch (Room 2)']
      }
    }
  };
  const r = _daRemovalImpact([LEAGUE_TILE], DIVS, { A1: [], A2: [] }, la);
  assert.strictEqual(r.generated, true);
  assert.strictEqual(r.leagueGames.length, 1);
  assert.strictEqual(r.leagueGames[0].label, 'Game 7');
  assert.strictEqual(r.leagueGames[0].league, 'Camp League');
  assert.strictEqual(r.leagueGames[0].matchupCount, 3, 'bye/chinuch lines are not matchups');
});

test('counts affected bunks and names their activities', () => {
  const sa = {
    A1: [ent('Soccer', 720), ent('Basketball', 780)],
    A2: [ent('Hockey', 720), ent('Basketball', 780)],
    B1: [ent('Swim', 780)]     // different division — not in scope
  };
  const r = _daRemovalImpact([LEAGUE_TILE], DIVS, sa, {});
  assert.strictEqual(r.bunkCount, 2, 'both A bunks, not B');
  assert.deepStrictEqual(r.activities, ['Basketball']);
});

// =========================================================================
test('the window is half-open — the next period is never swept in', () => {
  const sa = { A1: [ent('Basketball', 780), ent('Swim', 840)], A2: [] };
  const r = _daRemovalImpact([LEAGUE_TILE], DIVS, sa, {});
  assert.deepStrictEqual(r.activities, ['Basketball'], 'the 2:00 Swim is a different period');
  assert.strictEqual(r.bunkCount, 1);
});

test('a tile with no end time still matches what starts at its own start', () => {
  // Regression: deriving the bound from a missing end collapsed the window to
  // nothing, so a malformed tile silently reported "nothing generated" and
  // deleted a real period without a prompt.
  const sa = { A1: [ent('Basketball', 780)], A2: [] };
  const r = _daRemovalImpact([{ division: 'A', startMin: 780, endMin: null }], DIVS, sa, {});
  assert.strictEqual(r.generated, true);
  assert.deepStrictEqual(r.activities, ['Basketball']);
});

// =========================================================================
test('continuations and travel glue do not inflate the count', () => {
  const sa = {
    A1: [
      ent('Ropes Course', 780),
      Object.assign(ent('Ropes Course', 780), { continuation: true }),
      Object.assign(ent('Travel', 780), { _isTransition: true })
    ],
    A2: []
  };
  const r = _daRemovalImpact([LEAGUE_TILE], DIVS, sa, {});
  assert.strictEqual(r.bunkCount, 1, 'one bunk, counted once');
  assert.deepStrictEqual(r.activities, ['Ropes Course']);
});

test('one game stored across several divisions is reported once', () => {
  const la = {
    A: { 1: { leagueName: 'Camp League', gameLabel: 'Game 7', _startMin: 780, matchups: ['T1 vs T2'] } },
    B: { 0: { leagueName: 'Camp League', gameLabel: 'Game 7', _startMin: 780, matchups: ['T1 vs T2'] } }
  };
  const r = _daRemovalImpact(
    [LEAGUE_TILE, { division: 'B', startMin: 780, endMin: 840 }], DIVS, {}, la);
  assert.strictEqual(r.leagueGames.length, 1, 'deduped by league + label');
});

test('deleting several tiles at once accumulates across them', () => {
  const sa = { A1: [ent('Soccer', 720), ent('Basketball', 780)], A2: [ent('Soccer', 720)] };
  const r = _daRemovalImpact([
    { division: 'A', startMin: 720, endMin: 780 },
    LEAGUE_TILE
  ], DIVS, sa, {});
  assert.strictEqual(r.bunkCount, 3, 'A1+A2 for the morning tile, A1 again for the league tile');
  assert.deepStrictEqual(r.activities.sort(), ['Basketball', 'Soccer']);
});
