// node --test tests/setup_checklist.test.js
//
// The checklist's whole value is that the ORDER is right and every item says
// where it is done. A broken link or a duplicated key turns a camp's setup
// guide into a source of wrong turns, and neither fails loudly in a browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../campistry_setup_checklist.js');

const ROOT = path.join(__dirname, '..');

test('every item has a unique key', () => {
    const keys = C.items().map((r) => r.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate keys would share a tick');
});

test('every item says what, why and where', () => {
    C.items().forEach(({ key, item }) => {
        assert.ok(item.title && item.title.length > 3, key + ' has no title');
        assert.ok(item.detail && item.detail.length > 30, key + ' has no reason given');
        assert.ok(item.where && item.where.length > 3, key + ' does not say where it is done');
        assert.ok(item.href, key + ' has no link');
    });
});

test('every link points at a page that exists', () => {
    // A checklist that sends a camp to a 404 is worse than no checklist.
    C.items().forEach(({ key, item }) => {
        const file = item.href.split('#')[0].split('?')[0];
        if (!file) return;
        assert.ok(fs.existsSync(path.join(ROOT, file)), key + ' links to missing ' + file);
    });
});

test('the phases run in the order the work has to happen', () => {
    // Structure before campers, campers before households, money before
    // automatic posting, and the schedule after there is a camp to schedule.
    // These are the dependencies that actually bite; pin them so a later edit
    // cannot quietly reorder them.
    const order = C.items().map((r) => r.key);
    const before = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), a + ' must come before ' + b);

    before('camp.dates', 'camp.sessions');           // pricing is per session per date
    before('people.structure', 'people.roster');     // a camper needs a bunk to land in
    before('people.roster', 'people.families');      // households are built from campers
    before('money.dep_address', 'money.dep_alerts'); // nothing to point the bank at otherwise
    before('money.dep_alerts', 'money.dep_test');    // a test with nothing sending proves nothing
    before('money.dep_test', 'money.dep_lock');      // lock to a domain you have actually seen
    before('money.dep_lock', 'money.dep_auto');      // automatic last, on a locked address
    before('people.structure', 'schedule.generate'); // the most common wasted afternoon
    before('schedule.facilities', 'schedule.generate');
    before('schedule.generate', 'schedule.print');

    before('money.processor', 'money.card_fees');    // the fee model needs a processor to attach to
    before('people.staff', 'people.payroll');         // pay rate is entered per staff member
    before('people.roster', 'snacks.policy');         // the daily limit is set per camper account
    before('people.families', 'daily.link_invite');   // a portal invite needs a household to land in
    before('camp.profile', 'daily.link_contact');     // it is a field on the profile card itself
    before('people.staff', 'daily.link_tips');        // suggested amounts are keyed by staff position
});

test('forwarding sits with the deposit steps, not on its own', () => {
    const order = C.items().map((r) => r.key);
    assert.ok(order.includes('money.dep_forward'));
    assert.ok(order.indexOf('money.dep_address') < order.indexOf('money.dep_forward'),
        'there is nothing to forward TO until the address exists');
    assert.ok(order.indexOf('money.dep_forward') < order.indexOf('money.dep_auto'),
        'automatic posting is the last step, after mail actually arrives');
});

test('progress and next-up read the saved state', () => {
    const empty = C.progress({});
    assert.strictEqual(empty.done, 0);
    assert.strictEqual(empty.total, C.count());
    assert.strictEqual(C.nextUp({}).key, 'camp.profile', 'the first thing is the first item');

    // Ticking the first item moves the pointer to the second, not to nothing.
    const one = { 'camp.profile': { done: true } };
    assert.strictEqual(C.progress(one).done, 1);
    assert.strictEqual(C.nextUp(one).key, 'camp.dates');

    // An un-ticked item stored as done:false is not done.
    assert.strictEqual(C.progress({ 'camp.profile': { done: false } }).done, 0);

    const all = {};
    C.items().forEach((r) => { all[r.key] = { done: true }; });
    assert.strictEqual(C.progress(all).pct, 100);
    assert.strictEqual(C.nextUp(all), null, 'nothing left to point at');
});

test('the dashboard actually loads and shows it', () => {
    // The module can be perfect and still never render: this list exists only
    // if the page loads the script, has the panel to draw into, and the tab
    // that reveals it.
    const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

    assert.match(html, /<script src="campistry_setup_checklist\.js\?v=/, 'script tag missing');
    assert.match(html, /id="dash-setup-checklist"/, 'panel missing');
    assert.match(html, /data-tab="checklist"/, 'tab button missing');
    assert.match(js, /checklist:\s*'dash-setup-checklist'/, 'tab is not in the panel map');
    assert.match(js, /CampistrySetupChecklist\.mount\(\)/, 'nothing ever mounts it');

    // The tab sits after Team & Access, which is where it was asked for.
    assert.ok(html.indexOf('data-tab="team"') < html.indexOf('data-tab="checklist"'),
        'the checklist tab belongs at the end, after Team & Access');
});

test('the checklist ships on the same cache-bust as the dashboard', () => {
    // Same trap the deposit modules already hit: a new list behind an old ?v=
    // is a list nobody sees.
    const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
    const v = (name) => (html.match(new RegExp(name.replace('.', '\\.') + '\\?v=([0-9A-Za-z-]+)')) || [])[1];
    assert.strictEqual(v('campistry_setup_checklist.js'), v('dashboard.js'),
        'bump both together, or the browser runs one without the other');
});
