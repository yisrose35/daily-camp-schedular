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

test('TED-156: on, or off by the parent — no "Switch it back on", and no camp note', () => {
    const on = show({ enabled: true, thresholdEnabled: true, cardOnFile: true });
    assert.strictEqual(on.arOnBtn.style.display, 'none');
    const off = show({ enabled: false, thresholdEnabled: true, cardOnFile: true });
    assert.strictEqual(off.arOnBtn.style.display, 'none');
    assert.match(off.arStatusMsg.innerHTML, /Auto-reload is off\./);
});

test('TED-143: Link tells the parent it only charges while camp is in session', () => {
    assert.match(LINK, /Auto-reload only charges within this window, and only on days camp is in session\./);
    assert.ok(!/the camp stops it after the season either way/.test(LINK));
});
