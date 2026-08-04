/**
 * Tests for the custom schedule layout model (schedule_layout_model.js).
 *
 * The model is the single source of truth for the shape of every schedule
 * grid: which way time runs, whether the other axis lists grades or bunks,
 * and what the time ruler looks like. Both builders, the touch layer and the
 * print center all read their geometry from here, so a regression here is a
 * regression everywhere at once.
 *
 * The load-bearing guarantee is the FIRST group: the built-in Classic layout
 * must reproduce the geometry the app drew before this module existed, to the
 * pixel. Camps that never open the designer must see no change at all.
 *
 * Run with: node --test tests/schedule_layout_model.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SL = require(path.join(__dirname, '..', 'schedule_layout_model.js'));

// The constants the two builders used before the model existed.
const DA_PPM = 2.5;
const MS_PPM = 2;

function classicGeo(opts) {
  return SL.geometry(SL.builtInDefault(), { startMin: 540, endMin: 960 },
    Object.assign({ laneCount: 3, laneGap: 4, classicPxPerMinute: DA_PPM, laneInsetPct: 3 }, opts || {}));
}

describe('classic layout is unchanged', () => {
  it('positions a tile exactly where the old (min - earliest) * 2.5 math did', () => {
    const geo = classicGeo();
    // 10:00–11:00 in a day starting 9:00.
    assert.equal(geo.timePx(600), (600 - 540) * DA_PPM);
    assert.equal(geo.tileStyle(600, 660), 'top:150px;height:148px;');
  });

  it('emits no width or left for a single-lane tile, as the stylesheet expects', () => {
    // .da-event carries width:94%; left:3% — the old code only overrode width
    // when a tile spanned columns, and anything else would shift every tile.
    const style = classicGeo().tileStyle(600, 660);
    assert.ok(!style.includes('width'), style);
    assert.ok(!style.includes('left'), style);
  });

  it('spans columns with the same calc() the old span code produced', () => {
    const style = classicGeo().tileStyle(600, 660, { lanes: 3 });
    assert.ok(style.includes('width:calc(300% + 8px - 6%);'), style);
  });

  it('honours each builder\'s own scale for the built-in layout', () => {
    // Daily Adjustments has always drawn at 2.5 px/min and the Master Schedule
    // Builder at 2. Adopting the model must not flatten them together.
    const da = classicGeo({ classicPxPerMinute: DA_PPM });
    const ms = classicGeo({ classicPxPerMinute: MS_PPM });
    assert.equal(da.timePx(600), 150);
    assert.equal(ms.timePx(600), 120);
  });

  it('lets a custom layout override the per-surface scale', () => {
    const custom = SL.normalize({ id: 'c1', pxPerMinute: 4 });
    const geo = SL.geometry(custom, { startMin: 540, endMin: 960 }, { classicPxPerMinute: MS_PPM });
    assert.equal(geo.pxPerMinute, 4, 'a camp-chosen density applies on every surface');
  });

  it('rules the day off every 30 minutes starting at the first activity', () => {
    const ticks = classicGeo().rulerTiers()[0].ticks;
    assert.equal(ticks.length, 14);              // 9:00 → 4:00 in 30-minute steps
    assert.equal(ticks[0].timeLabel, '9:00am');
    assert.equal(ticks[0].pos, 0);
    assert.equal(ticks[1].pos, 30 * DA_PPM);
  });
});

describe('orientation', () => {
  const horiz = SL.normalize({ id: 'h', orientation: 'horizontal', pxPerMinute: 2, laneSize: 80 });

  it('lays a tile along the horizontal axis and gives it its lane thickness', () => {
    const geo = SL.geometry(horiz, { startMin: 540, endMin: 960 }, { laneCount: 3, laneGap: 4 });
    const style = geo.tileStyle(600, 660);
    assert.ok(style.includes('left:120px;'), style);   // 60 min * 2 px
    assert.ok(style.includes('width:118px;'), style);
    assert.ok(style.includes('height:76px;'), style);  // 80 - 4
  });

  it('stacks a multi-lane tile across its lanes and their gaps', () => {
    const geo = SL.geometry(horiz, { startMin: 540, endMin: 960 }, { laneCount: 6, laneGap: 4 });
    const style = geo.tileStyle(600, 660, { lanes: 3 });
    // 3 lanes of 80 + 2 gaps of 4 = 248, less the 4px inset.
    assert.ok(style.includes('height:244px;'), style);
  });

  it('reads the pointer along the correct axis in each orientation', () => {
    const rect = { top: 100, left: 200 };
    const evt = { clientX: 260, clientY: 160 };
    const v = classicGeo();
    const h = SL.geometry(horiz, { startMin: 540, endMin: 960 });
    assert.equal(v.pointerTimePx(evt, rect), 60, 'time runs down: use clientY');
    assert.equal(h.pointerTimePx(evt, rect), 60, 'time runs across: use clientX');
    assert.equal(v.pointerLanePx(evt, rect), 60);
    assert.equal(h.pointerLanePx(evt, rect), 60);
  });

  it('names the tile edges that resize along time', () => {
    assert.equal(classicGeo().startEdgeProp, 'top');
    assert.equal(classicGeo().sizeProp, 'height');
    const h = SL.geometry(horiz, { startMin: 540, endMin: 960 });
    assert.equal(h.startEdgeProp, 'left');
    assert.equal(h.sizeProp, 'width');
  });
});

describe('ruler tiers', () => {
  it('stacks several tiers over one linear minute axis', () => {
    // The camp writes 11:00-12:00 on one row and 11:00 / 11:15 / ... beneath it.
    const layout = SL.normalize({
      id: 'multi',
      rulers: [
        { kind: 'uniform', increment: 60 },
        { kind: 'uniform', increment: 15 },
        { kind: 'periods', slots: [{ start: '11:00am', end: '12:00pm', label: 'Period 3' }] }
      ]
    });
    const tiers = SL.geometry(layout, { startMin: 540, endMin: 960 }).rulerTiers();
    assert.equal(tiers.length, 3);
    assert.equal(tiers[0].ticks.length, 7);    // 7 hours
    assert.equal(tiers[1].ticks.length, 28);   // 28 quarter-hours
    assert.equal(tiers[2].ticks[0].label, 'Period 3');

    // Crucially, all three describe the SAME axis — a tick at 11:00 sits at the
    // same pixel in every tier, which is what keeps overlap maths valid.
    const at11 = t => t.ticks.find(x => x.startMin === 660).pos;
    assert.equal(at11(tiers[0]), at11(tiers[1]));
    assert.equal(at11(tiers[1]), at11(tiers[2]));
  });

  it('clips a bell schedule to the drawn day and drops periods outside it', () => {
    const layout = SL.normalize({
      id: 'bells',
      rulers: [{ kind: 'periods', slots: [
        { start: '7:00am', end: '8:00am', label: 'Before' },
        { start: '9:30am', end: '10:30am', label: 'P1' },
        { start: '10:00pm', end: '11:00pm', label: 'After' }
      ] }]
    });
    const ticks = SL.geometry(layout, { startMin: 540, endMin: 960 }).rulerTiers()[0].ticks;
    assert.deepEqual(ticks.map(t => t.label), ['P1']);
  });

  it('drops a periods tier with no usable slots rather than drawing an empty band', () => {
    const layout = SL.normalize({ id: 'x', rulers: [
      { kind: 'periods', slots: [{ start: 'nonsense', end: 'also nonsense' }] },
      { kind: 'uniform', increment: 30 }
    ] });
    assert.equal(layout.rulers.length, 1);
    assert.equal(layout.rulers[0].kind, 'uniform');
  });

  it('shortens then drops a tick label as its band gets too narrow', () => {
    // A 15-minute band at a normal zoom is narrower than "10:15am" renders.
    const layout = SL.normalize({ id: 'h', orientation: 'horizontal', pxPerMinute: 2,
      rulers: [{ kind: 'uniform', increment: 15 }] });
    const geo = SL.geometry(layout, { startMin: 540, endMin: 960 });
    const tick = geo.rulerTiers()[0].ticks[0];
    assert.equal(tick.size, 30);
    assert.equal(geo.tickLabel(tick), '9:00', 'falls back to the meridiem-less form');

    const tiny = SL.geometry(SL.normalize({ id: 'h2', orientation: 'horizontal', pxPerMinute: 0.5,
      rulers: [{ kind: 'uniform', increment: 15 }] }), { startMin: 540, endMin: 960 });
    assert.equal(tiny.tickLabel(tiny.rulerTiers()[0].ticks[0]), '', 'no label beats a clipped one');
  });
});

describe('snapping', () => {
  const bells = SL.normalize({ id: 'b', rulers: [{ kind: 'periods', slots: [
    { start: '9:00am', end: '10:00am', label: 'P1' },
    { start: '10:00am', end: '11:15am', label: 'P2' }
  ] }] });

  it('pulls a time onto the nearest bell when the camp runs a bell schedule', () => {
    assert.equal(SL.snap(bells, 607), 600);    // 10:07 → 10:00
    assert.equal(SL.snap(bells, 670), 675);    // 11:10 → 11:15
  });

  it('falls back to the layout\'s minute grid when bell snapping is off', () => {
    const off = SL.normalize(Object.assign({}, bells, { snapToBells: false, snapMins: 5 }));
    assert.equal(SL.snap(off, 607), 605);
  });

  it('uses a plain minute grid when there is no bell schedule', () => {
    assert.equal(SL.snap(SL.builtInDefault(), 607), 605);
  });

  it('gives a new tile the length of the period it landed in', () => {
    assert.equal(SL.defaultDurationAt(bells, 570), 60, '9:30 is inside the 60-minute P1');
    assert.equal(SL.defaultDurationAt(bells, 630), 75, '10:30 is inside the 75-minute P2');
    // Outside every period, fall back to the finest uniform tier.
    const mixed = SL.normalize({ id: 'm', rulers: [{ kind: 'uniform', increment: 20 }] });
    assert.equal(SL.defaultDurationAt(mixed, 800), 20);
  });
});

describe('lanes', () => {
  const divisions = {
    Aleph: { color: '#111', bunks: ['A1', 'A2', 'A3'] },
    Bais: { color: '#222', bunks: ['B1', 'B2'] },
    Empty: { color: '#333', bunks: [] }
  };
  const order = ['Aleph', 'Bais', 'Empty'];

  it('gives one lane per grade in grade mode', () => {
    const lanes = SL.lanesFor(SL.builtInDefault(), divisions, order);
    assert.deepEqual(lanes.map(l => l.label), ['Aleph', 'Bais', 'Empty']);
  });

  it('gives one lane per bunk, grouped under its grade, in bunk mode', () => {
    const layout = SL.normalize({ id: 'b', entityAxis: 'bunk' });
    const lanes = SL.lanesFor(layout, divisions, order);
    assert.deepEqual(lanes.map(l => l.label), ['A1', 'A2', 'A3', 'B1', 'B2', 'Empty']);
    assert.deepEqual(lanes.map(l => l.division), ['Aleph', 'Aleph', 'Aleph', 'Bais', 'Bais', 'Empty']);
    // Only the first lane of each grade is a group start — that's the lane that
    // paints the grade's tiles and carries the column-reorder handle.
    assert.deepEqual(lanes.map(l => l.groupStart), [true, false, false, true, false, true]);
  });

  it('still gives a bunkless grade a lane, so its tiles do not vanish', () => {
    const lanes = SL.lanesFor(SL.normalize({ id: 'b', entityAxis: 'bunk' }), divisions, order);
    assert.ok(lanes.some(l => l.division === 'Empty'));
  });

  it('reports the lane block a grade occupies', () => {
    const lanes = SL.lanesFor(SL.normalize({ id: 'b', entityAxis: 'bunk' }), divisions, order);
    assert.deepEqual(SL.laneRangeForDivision(lanes, 'Aleph'), { first: 0, last: 2, count: 3 });
    assert.deepEqual(SL.laneRangeForDivision(lanes, 'Bais'), { first: 3, last: 4, count: 2 });
    assert.equal(SL.laneRangeForDivision(lanes, 'Nope'), null);
  });
});

describe('normalize refuses to produce an unusable layout', () => {
  it('falls back to the classic shape for junk input', () => {
    [null, undefined, 42, 'nope', {}].forEach(bad => {
      const l = SL.normalize(bad);
      assert.equal(l.orientation, 'vertical');
      assert.equal(l.entityAxis, 'division');
      assert.ok(l.rulers.length >= 1);
      assert.ok(l.pxPerMinute > 0);
    });
  });

  it('rejects unknown enum values instead of storing them', () => {
    const l = SL.normalize({ id: 'x', orientation: 'diagonal', entityAxis: 'counselor' });
    assert.equal(l.orientation, 'vertical');
    assert.equal(l.entityAxis, 'division');
  });

  it('clamps a density that would make the grid unusable', () => {
    assert.equal(SL.normalize({ id: 'x', pxPerMinute: 9999 }).pxPerMinute, 12);
    assert.equal(SL.normalize({ id: 'x', pxPerMinute: -3 }).pxPerMinute, 2.5);
  });

  it('drops periods that run backwards and sorts the rest', () => {
    const l = SL.normalize({ id: 'x', rulers: [{ kind: 'periods', slots: [
      { start: '11:00am', end: '12:00pm', label: 'Third' },
      { start: '2:00pm', end: '1:00pm', label: 'Backwards' },
      { start: '9:00am', end: '10:00am', label: 'First' }
    ] }] });
    assert.deepEqual(l.rulers[0].slots.map(s => s.label), ['First', 'Third']);
  });

  it('always keeps at least one ruler tier', () => {
    assert.equal(SL.normalize({ id: 'x', rulers: [] }).rulers.length, 1);
  });
});

describe('time parsing and formatting', () => {
  it('reads the formats a camp actually types', () => {
    assert.equal(SL.parseTime('9:00am'), 540);
    assert.equal(SL.parseTime('2:30pm'), 870);
    assert.equal(SL.parseTime('14:30'), 870);
    assert.equal(SL.parseTime('1430'), 870);
    assert.equal(SL.parseTime('12:00pm'), 720);
    assert.equal(SL.parseTime('12:00am'), 0);
    assert.equal(SL.parseTime(600), 600);
  });

  it('returns null rather than a wrong time for junk', () => {
    ['', 'lunch', '25:00', '9:70am', null, undefined].forEach(v => {
      assert.equal(SL.parseTime(v), null, JSON.stringify(v));
    });
  });

  it('round-trips through the app\'s compact format', () => {
    [0, 540, 720, 870, 1439].forEach(m => {
      assert.equal(SL.parseTime(SL.fmtTime(m)), m, String(m));
    });
  });
});
