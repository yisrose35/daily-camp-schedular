// =============================================================================
// payroll_run_dates.test.js — TED-166, the real New Pay Run window.
//
// The window filled in "Sunday of last week → today", which takes the week
// still being worked. Two weekly runs made a week apart both paid the middle
// week (Ana: 112 h paid for 96 worked); two-weekly runs never paid the rest of
// the week they were made in. Now the defaults are the complete weeks since the
// last run, and a range that pays a week twice (or a week not over) is said
// out loud before it is saved.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const CORE = require('../campistry_payroll_core.js');
function cut(name) {
    const at = ME.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}

function office(payroll) {
    let today = '2026-07-07', onOk = null, lastHtml = '', answer = true;
    const dialogs = [];
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(today + 'T12:00:00'); }
        static now() { return new RealDate(today + 'T12:00:00').getTime(); }
    }
    const inputs = {};
    const ctx = {
        payroll, Date: FakeDate, PC: () => CORE, esc: (s) => String(s),
        ff: (label, id, val) => { inputs[id] = { value: val }; return ''; },
        showModal: (t, h, ok) => { onOk = ok; lastHtml = h; }, closeModal() {}, save() {}, renderPayroll() {}, toast() {},
        confirmDialog: async (o) => { dialogs.push(o); return answer; }, _prTab: '',
        document: { getElementById: (id) => inputs[id] || (id === 'runFinal' ? { checked: false } : null) },
    };
    const names = ['_prToday', '_prWeekStart', '_prShiftWeek', '_prAddDays', '_prDefaultRange', '_prOverlappingRuns', 'prNewRun'];
    const fns = new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(ctx));
    return {
        fns, inputs, dialogs, html: () => lastHtml,
        on: (d) => { today = d; }, answer: (a) => { answer = a; },
        make: async () => { fns.prNewRun(); await onOk(); },
        open: () => fns.prNewRun(),
        press: async () => onOk(),
    };
}
// Ana works 48 h every week (Sunday-dated sheets); Ben is paid $300 a week.
function season() {
    const sheet = (id, wk, h) => ({ staffId: id, weekOf: wk, status: 'approved', supervisorSigned: true,
        days: { mon: h / 6, tue: h / 6, wed: h / 6, thu: h / 6, fri: h / 6, sun: h / 6 } });
    return {
        staff: [{ id: 'ana', name: 'Ana', payType: 'hourly', payRate: 15 }, { id: 'ben', name: 'Ben', payType: 'weekly', payRate: 300 }],
        timesheets: ['2026-06-28', '2026-07-05', '2026-07-12'].flatMap(w => [sheet('ana', w, 48), sheet('ben', w, 40)]),
        payRuns: [],
    };
}
const hoursIn = (run, id) => (run.lines.find(l => String(l.staffId) === id) || { hours: 0 }).hours;

test('TED-166: weekly runs with the defaults — every week paid exactly once', async () => {
    const pr = season();
    const o = office(pr);
    o.on('2026-07-07'); await o.make();          // Tuesday
    o.on('2026-07-14'); await o.make();          // the next Tuesday
    assert.deepStrictEqual(pr.payRuns.map(r => [r.from, r.to]), [['2026-06-28', '2026-07-04'], ['2026-07-05', '2026-07-11']]);
    const ana = pr.payRuns.reduce((t, r) => t + hoursIn(r, 'ana'), 0);
    assert.strictEqual(ana, 96, 'Ana worked 2 finished weeks (96 h) and was paid for ' + ana);
    assert.strictEqual(o.dialogs.length, 0, 'the defaults themselves were warned about');
});

test('TED-166: two-weekly runs with the defaults — nothing skipped', async () => {
    const pr = season();
    const o = office(pr);
    o.on('2026-07-07'); await o.make();
    o.on('2026-07-21'); await o.make();          // two weeks later
    const ana = pr.payRuns.reduce((t, r) => t + hoursIn(r, 'ana'), 0);
    assert.strictEqual(ana, 144, 'three finished weeks, 144 h; paid ' + ana);
    assert.deepStrictEqual(pr.payRuns.map(r => [r.from, r.to]), [['2026-06-28', '2026-07-04'], ['2026-07-05', '2026-07-18']]);
});

test('TED-166: a range that pays a week twice, or a week not over, is said before saving (and Cancel saves nothing)', async () => {
    const pr = season();
    const o = office(pr);
    o.on('2026-07-07'); await o.make();                       // Jun 28 – Jul 4
    o.on('2026-07-14');
    o.answer(false);                                          // the office cancels
    o.open();
    o.inputs.runFrom.value = '2026-06-28'; o.inputs.runTo.value = '2026-07-14';
    await o.press();
    assert.strictEqual(pr.payRuns.length, 1, 'a run that pays a week twice was saved without asking');
    const msg = o.dialogs[0].message;
    assert.match(msg, /already paid — those hours would be paid twice/);
    assert.match(msg, /the week of 2026-07-12, which is not over/);
    o.answer(true);                                           // or goes ahead knowingly
    o.open();
    o.inputs.runFrom.value = '2026-06-28'; o.inputs.runTo.value = '2026-07-14';
    await o.press();
    assert.strictEqual(pr.payRuns.length, 2);
});

test('TED-166: nothing new to pay — the window says so', () => {
    const pr = season();
    pr.payRuns = [{ id: 'r1', from: '2026-06-28', to: '2026-07-11' }];
    const o = office(pr);
    o.on('2026-07-14');
    o.open();
    assert.match(o.html(), /No complete week since the last pay run ended/);
});

test('TED-166: the overlap rule itself', () => {
    const pr = season();
    pr.payRuns = [{ id: 'r1', from: '2026-06-28', to: '2026-07-07' }];
    const o = office(pr);
    assert.strictEqual(o.fns._prOverlappingRuns('2026-07-05', '2026-07-14').length, 1, 'the week of Jul 5 is in both');
    assert.strictEqual(o.fns._prOverlappingRuns('2026-07-12', '2026-07-18').length, 0);
    assert.strictEqual(o.fns._prOverlappingRuns('2026-07-08', '2026-07-11').length, 0, 'no Sunday in the shared days');
});
