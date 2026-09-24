// =============================================================================
// link_autoreload_paused.test.js — TED-156, Link's own display code.
//
// A refund that empties a child's wallet switches auto-reload off with a note
// (TED-143). While paused, Link hid both of its buttons and the trigger box
// stayed ticked, so ticking it saved nothing: there was no obvious way to
// switch it back on. (That a parent's save clears the note is pgtest 282.)
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LINK = fs.readFileSync(path.join(__dirname, '..', 'campistry_link_parent.html'), 'utf8');
function cut(name) {
    const at = LINK.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = LINK.indexOf('{', at), d = 0;
    for (; i < LINK.length; i++) { if (LINK[i] === '{') d++; else if (LINK[i] === '}' && --d === 0) break; }
    return LINK.slice(at, i + 1);
}

function show(ar) {
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, style: { display: 'none' }, options: [], value: '', checked: false, textContent: '', innerHTML: '', className: '', classList: { add() {}, remove() {}, toggle() {} } });
    const ctx = { document: { getElementById: el, querySelectorAll: () => [] }, window: { _campSessionsByCamp: {} },
        _escHtml: (s) => String(s), _arRenderSessionPicker() {}, _arToggleOption() {}, _arRenderDayOptions() {}, console };
    vm.createContext(ctx);
    vm.runInContext(cut('_renderAutoReload') + '\nthis.render = _renderAutoReload;', ctx);
    ctx.render({ name: 'Avi Gold', campId: 'camp1', autoReload: ar });
    return els;
}

test('TED-156: paused by the camp — the note, and a "Switch it back on" button that saves the settings shown', () => {
    const els = show({ enabled: false, thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, cardOnFile: true,
        disabledReason: 'switched off when the camp refunded the canteen balance — switch it back on if you still want it' });
    assert.match(els.arStatusMsg.innerHTML, /Auto-reload was switched off<\/strong> — switched off when the camp refunded/);
    assert.strictEqual(els.arOnBtn.style.display, '', 'no way to switch it back on');
    assert.match(LINK, /id="arOnBtn" onclick="saveAutoReload\(\)"[^>]*>Switch it back on</);
});

test('TED-156: on — no "Switch it back on"; off by the parent — no camp note', () => {
    const on = show({ enabled: true, thresholdEnabled: true, cardOnFile: true });
    assert.strictEqual(on.arOnBtn.style.display, 'none');
    const off = show({ enabled: false, thresholdEnabled: true, cardOnFile: true });
    assert.match(off.arStatusMsg.innerHTML, /Auto-reload is off\./);
    assert.ok(!/switched off<\/strong> —/.test(off.arStatusMsg.innerHTML));
});

test('TED-143: Link tells the parent it only charges while camp is in session', () => {
    assert.match(LINK, /Auto-reload only charges within this window, and only on days camp is in session\./);
    assert.ok(!/the camp stops it after the season either way/.test(LINK));
});

// ── TED-161: the parent's own "Turn off" ─────────────────────────────────────
test('TED-161: turned off by the parent — "Switch it back on" is there when it was set up before', () => {
    const els = show({ enabled: false, thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, cardOnFile: true });
    assert.match(els.arStatusMsg.innerHTML, /Auto-reload is off\./);
    assert.strictEqual(els.arOnBtn.style.display, '', 'no way back on after the parent\'s own Turn off');
    const never = show({ enabled: false });
    assert.strictEqual(never.arOnBtn.style.display, 'none', 'never set up: ticking a trigger is the way on');
});

function autoSave(ar, targetId, checked) {
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, value: '', checked: false });
    const sent = [];
    const ctx = { document: { getElementById: el }, setTimeout: (f) => f(), clearTimeout() {},
        _activeCanteenChild: () => ({ name: 'Avi Gold', campId: 'camp1', autoReload: ar }),
        _saveAutoReloadConfig: (c, cfg) => sent.push(cfg), _arSaveTimer: null };
    vm.createContext(ctx);
    vm.runInContext('var _arSaveTimer=null;\n' + cut('_arAutoSave') + '\nthis.save = _arAutoSave;', ctx);
    el('arThEnabled').checked = true; el('arThAmount').value = '5'; el('arThReload').value = '30';
    ctx.save({ target: el(targetId), type: 'change' });
    if (checked !== undefined) el(targetId).checked = checked;
    return sent;
}

test('TED-161: editing the amount while auto-reload is OFF saves it without switching it on', () => {
    const sent = autoSave({ enabled: false, thresholdEnabled: true }, 'arThReload');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].enabled, false, 'an amount edit switched auto-reload back on');
    assert.strictEqual(sent[0].thresholdReloadAmount, 30);
});

test('TED-161: ticking a trigger is still how a parent switches it on; edits while on keep it on', () => {
    assert.strictEqual(autoSave({ enabled: false }, 'arThEnabled')[0].enabled, true);
    assert.strictEqual(autoSave({ enabled: true, thresholdEnabled: true }, 'arThReload')[0].enabled, true);
});
