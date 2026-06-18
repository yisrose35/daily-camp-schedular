'use strict';
// Tests for PeriodTiler.packBunkDay — the whole-day duration-first packer.
// Reproduces the user's Harmony 4 worked example: 165 min of special-budget
// between a fixed morning swim and a pinned end-of-day Main Activity should be
// tiled by EIGHT 20-min specials (Slush dropped), leaving exactly 5 min before
// Main Activity — no scattered mid-day floats.

const test = require('node:test');
const assert = require('node:assert');
const PeriodTiler = require('../period_tiler.js');

function contiguityGap(placements, dayStart, dayEnd) {
  // total empty minutes inside [dayStart,dayEnd] not covered by a placement
  const sorted = placements.slice().sort((a, b) => a.start - b.start);
  let cursor = dayStart, gap = 0;
  for (const p of sorted) { if (p.start > cursor) gap += p.start - cursor; cursor = Math.max(cursor, p.end); }
  if (cursor < dayEnd) gap += dayEnd - cursor;
  return gap;
}

test('packBunkDay — Harmony 4: slides lunch, drops Slush, leaves 5 min before pinned Main', () => {
  const dayStart = 555, dayEnd = 900; // 9:15am–3:00pm
  const input = {
    dayStart, dayEnd, minFill: 10,
    anchors: [
      // swim envelope — pinned (window == duration)
      { id: 'c1', name: 'Change', dur: 15, winStart: 555, winEnd: 570, pinned: true, kind: 'change' },
      { id: 'sw', name: 'swim',   dur: 30, winStart: 570, winEnd: 600, pinned: true, kind: 'swim' },
      { id: 'c2', name: 'Change', dur: 15, winStart: 600, winEnd: 615, pinned: true, kind: 'change' },
      // windowed anchors — slide to abut
      { id: 'dav', name: 'Davening', dur: 20, winStart: 615, winEnd: 675, kind: 'custom' },
      { id: 'ma',  name: 'Morning activity', dur: 40, winStart: 635, winEnd: 800, kind: 'custom' },
      { id: 'lun', name: 'lunch', dur: 20, winStart: 720, winEnd: 765, kind: 'lunch' }, // 12:00–12:45 window
      // end anchor — pinned at day end (window == duration)
      { id: 'main', name: 'Main Activity', dur: 40, winStart: 860, winEnd: 900, pinned: true, kind: 'custom' },
    ],
    existingSpecials: [
      { id: 'e1', name: 'Foam Pit', dur: 20 },
      { id: 'e2', name: 'Arts & Crafts 3', dur: 20 },
      { id: 'e3', name: 'Arts & Crafts 1', dur: 20 },
      { id: 'e4', name: 'Neranitas', dur: 20 },
      { id: 'e5', name: 'Arts & Crafts 2', dur: 20 },
      { id: 'e6', name: 'Shiur 1', dur: 20 },
      { id: 'e7', name: 'Slush', dur: 10 },
    ],
    pool: [
      { name: 'Shiur 2', dur: 20, score: 1 },
      { name: 'VR', dur: 20, score: 1 },
      { name: 'Ice Cream', dur: 20, score: 2 },
      { name: 'Baking', dur: 40, score: 3 },
    ],
  };

  const r = PeriodTiler.packBunkDay(input);

  // Pinned anchors stayed exactly put.
  const main = r.placements.find(p => p.id === 'main');
  assert.strictEqual(main.start, 860, 'Main Activity stays pinned at 2:20pm');
  const swim = r.placements.find(p => p.id === 'sw');
  assert.strictEqual(swim.start, 570, 'swim stays pinned');

  // lunch slid earlier than its 12:45 latest to abut its neighbour (no gap before it).
  const lunch = r.placements.find(p => p.id === 'lun');
  assert.ok(lunch.start >= 720 && lunch.start <= 745, 'lunch within its window');
  const beforeLunch = r.placements.filter(p => p.end <= lunch.start).sort((a,b)=>b.end-a.end)[0];
  assert.strictEqual(beforeLunch.end, lunch.start, 'an activity abuts lunch — no gap before it');

  // The whole day is gap-free except the unavoidable remainder, and that
  // remainder is exactly 5 min sitting right before the pinned Main Activity.
  assert.strictEqual(r.residualMin, 5, 'exactly 5 min unfillable (165 = 8×20 + 5)');
  assert.strictEqual(contiguityGap(r.placements, dayStart, dayEnd), 5, 'only 5 min of empty time in the whole day');
  const mainPrev = r.placements.filter(p => p.end <= 860).sort((a,b)=>b.end-a.end)[0];
  assert.strictEqual(860 - mainPrev.end, 5, 'the 5-min remainder is the gap right before Main Activity');

  // Slush (the wasteful 10-min filler) was dropped; 160 min of real specials placed
  // (any combination of the configured durations that sums to 160 is valid — e.g.
  // 8×20, or Baking40 + 6×20 — the packer prefers larger blocks).
  assert.ok(r.dropped.includes('Slush'), 'Slush dropped (not needed for an exact landing)');
  const specials = r.placements.filter(p => p.kind === 'special');
  const specialMin = specials.reduce((s, p) => s + p.dur, 0);
  assert.strictEqual(specialMin, 160, '160 min of specials fills the budget (165 − 5 remainder)');
  assert.ok(specials.every(p => p.dur >= 20), 'no sub-20 filler placed (Slush left out)');
});

test('packBunkDay — uses an exact-fit filler when the math needs it', () => {
  // Budget 170 before a pinned end → 8×20 + one 10 = 170 exactly; Slush SHOULD be used.
  const r = PeriodTiler.packBunkDay({
    dayStart: 0, dayEnd: 170, minFill: 10,
    anchors: [{ id: 'end', name: 'End', dur: 0, winStart: 170, winEnd: 170, pinned: true }],
    existingSpecials: [{ name: 'Slush', dur: 10 }],
    pool: Array.from({ length: 9 }, (_, i) => ({ name: 'S' + i, dur: 20, score: 1 })),
  });
  assert.strictEqual(r.residualMin, 0, 'tiles to zero when an exact filler exists');
  assert.ok(!r.dropped.includes('Slush'), 'Slush kept — it makes the tiling exact');
});

test('packBunkDay — an unfillable gap before a too-early pinned anchor is reported, not hidden', () => {
  // Only a 7-min space before a pinned anchor, smallest activity is 10 → 7 min residual.
  const r = PeriodTiler.packBunkDay({
    dayStart: 0, dayEnd: 100, minFill: 10,
    anchors: [{ id: 'p', name: 'Pinned', dur: 93, winStart: 7, winEnd: 100, pinned: true }],
    existingSpecials: [], pool: [{ name: 'X', dur: 20 }],
  });
  assert.strictEqual(r.residualMin, 7, '7-min sub-floor gap is honest residual');
});
