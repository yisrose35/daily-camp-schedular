// =============================================================================
// closeout_not_a_sale.test.js — TED-152, the Snacks page's own code.
//
// Me's season close-out (migration 280) takes a child's canteen money off with
// a 'closeout' line. Snacks counted every debit that was not a cash-out or a
// refund as a SALE, so a $37 close-out made "Sales today" and Revenue jump
// from $3 to $40, the week's chart showed $40, and the line read "Purchase".
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SN = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks.js'), 'utf8');
function cut(name) {
    const at = SN.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = SN.indexOf('{', at), d = 0;
    for (; i < SN.length; i++) { if (SN[i] === '{') d++; else if (SN[i] === '}' && --d === 0) break; }
    return SN.slice(at, i + 1);
}

function day() {
    const els = {};
    const ctx = {
        camperList: ['Avi'], esc: (s) => String(s),
        document: { getElementById: (id) => (els[id] = els[id] || { textContent: '', innerHTML: '' }) },
        cashOutTotal: () => 0,
    };
    vm.createContext(ctx);
    vm.runInContext(cut('todayStr') + '\n' + cut('_isSale') + '\n' + cut('renderStats') + '\n' + cut('_histRowHtml')
        + '\nthis.renderStats = renderStats; this.todayStr = todayStr; this.isSale = _isSale; this.row = _histRowHtml;', ctx);
    const today = ctx.todayStr();
    ctx.snacks = { accounts: { Avi: { balance: 0 } }, inventory: [], transactions: [
        { date: today, type: 'debit', amount: 3, items: 'Chips', camper: 'Avi' },
        { date: today, type: 'debit', kind: 'closeout', amount: 37, items: 'Season close-out: cash', camper: 'Avi' },
        { date: today, type: 'debit', kind: 'cash_out', amount: 5, camper: 'Avi' },
        { date: today, type: 'debit', kind: 'refund', amount: 10, camper: 'Avi' },
        { date: today, type: 'credit', amount: 50, camper: 'Avi' },
    ] };
    return { ctx, els };
}

test('TED-152: a $37 close-out is not a sale — "Sales today" stays $3', () => {
    const { ctx, els } = day();
    ctx.renderStats();
    assert.strictEqual(els.sS.textContent, '$3', 'the close-out was counted as sales');
});

test('TED-152: one rule for a sale — purchases and shop orders only', () => {
    const { ctx } = day();
    assert.strictEqual(ctx.isSale({ type: 'debit' }), true);
    assert.strictEqual(ctx.isSale({ type: 'debit', kind: 'shop' }), true);
    assert.strictEqual(ctx.isSale({ type: 'debit', kind: 'offline_sale' }), true);
    for (const kind of ['closeout', 'cash_out', 'refund']) assert.strictEqual(ctx.isSale({ type: 'debit', kind }), false, kind);
    assert.strictEqual(ctx.isSale({ type: 'credit' }), false);
    // the day's revenue and the week's chart use the same rule
    assert.match(cut('rAnalytics'), /todayTx\.filter\(_isSale\)/);
    assert.match(cut('rAnalytics'), /t\.date === key && _isSale\(t\)/);
    assert.ok(!/kind !== 'cash_out' && t\.kind !== 'refund'\)/.test(SN), 'an older sales rule is still in use somewhere');
});

test('TED-152: the close-out line is labelled as a close-out, not a purchase', () => {
    const { ctx } = day();
    const html = ctx.row({ date: '2026-08-20', type: 'debit', kind: 'closeout', amount: 37, items: 'Season close-out: cash' });
    assert.match(html, /Season close-out: cash/);
    assert.match(SN, /t\.kind === 'closeout' \? '<span class="badge badge-amber">Season close-out<\/span>'/);
});
