// node --test tests/link_parent_directory.test.js
// Campistry Link's parent directory is what its Dashboard and Parents page
// count as "Families". It used to report MORE families than Billing did for
// the same camp, because a camper who already belonged to a families[] record
// could still spawn a second, "implied" family of their own whenever the
// family's parent email didn't match the camper's parent1Email exactly.
//
// These tests pin the de-dup rule: family membership decides, and a parent is
// recognised by any of their emails or names — not just the primary's.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// campistry_link_data.js is a browser IIFE that hangs itself off `window` and
// reads localStorage at load. Give it just enough of a DOM-less environment to
// run under node, then pull the module object back off the stub window.
function loadLink(globalState) {
    const store = { campGlobalSettings_v1: JSON.stringify(globalState) };
    global.localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
    };
    global.window = { localStorage: global.localStorage };
    global.document = { addEventListener() {} };
    // The bridge is chatty on load and arms a cloud-load timer plus a
    // scheduled-broadcast interval. Neither belongs in a unit test, and a live
    // timer would keep node's event loop open forever, so both are stubbed out
    // for the duration of the require.
    const orig = { log: console.log, setTimeout: global.setTimeout, setInterval: global.setInterval };
    console.log = () => {};
    global.setTimeout = () => 0;
    global.setInterval = () => 0;
    try {
        delete require.cache[require.resolve('../campistry_link_data.js')];
        require(path.join(__dirname, '..', 'campistry_link_data.js'));
    } finally {
        console.log = orig.log;
        global.setTimeout = orig.setTimeout;
        global.setInterval = orig.setInterval;
    }
    return global.window.CampistryLink;
}

// One family, one camper in it — but the camper record carries no parent email
// while the family record does. This is the exact shape that used to double-count.
const MISMATCHED_EMAIL = {
    campistryMe: {
        roster: {
            'Ari Klein': { parent1Name: 'Dov Klein', parent1Email: '', division: 'Juniors', bunk: 'J1' }
        },
        families: {
            fam_klein_1: {
                name: 'Klein Family',
                camperIds: ['Ari Klein'],
                households: [{ parents: [{ name: 'Dov Klein', email: 'dov@example.com', phone: '555-0100' }], address: '1 Main St' }]
            }
        }
    }
};

test('a camper already in a family never spawns a second implied family', () => {
    const L = loadLink(MISMATCHED_EMAIL);
    const dir = L.data.getParentDirectory();
    assert.strictEqual(dir.length, 1, 'one family record + one camper in it = one directory entry');
    assert.strictEqual(dir[0].familyId, 'fam_klein_1');
    assert.deepStrictEqual(dir[0].children.map(c => c.name), ['Ari Klein']);
});

test('directory count matches the family count when every camper is in a family', () => {
    const L = loadLink(MISMATCHED_EMAIL);
    assert.strictEqual(
        L.data.getParentDirectory().length,
        Object.keys(L.data.getFamilies()).length,
        'Link must not report more families than the family records Billing lists'
    );
});

test('a camper matching the SECOND parent still resolves to the same family', () => {
    const L = loadLink({
        campistryMe: {
            roster: {
                'Shira Weiss': { parent1Name: 'Rina Weiss', parent1Email: 'rina@example.com' }
            },
            families: {
                fam_weiss_1: {
                    name: 'Weiss Family',
                    camperIds: [],   // membership not recorded — the alias must carry it
                    households: [{ parents: [
                        { name: 'Yaakov Weiss', email: 'yaakov@example.com' },
                        { name: 'Rina Weiss', email: 'rina@example.com' }
                    ] }]
                }
            }
        }
    });
    assert.strictEqual(L.data.getParentDirectory().length, 1);
});

test('a camper genuinely outside every family still gets an implied entry', () => {
    const L = loadLink({
        campistryMe: {
            roster: {
                'Ari Klein': { parent1Name: 'Dov Klein', parent1Email: 'dov@example.com' },
                'Leah Stern': { parent1Name: 'Miri Stern', parent1Email: 'miri@example.com' }
            },
            families: {
                fam_klein_1: {
                    name: 'Klein Family',
                    camperIds: ['Ari Klein'],
                    households: [{ parents: [{ name: 'Dov Klein', email: 'dov@example.com' }] }]
                }
            }
        }
    });
    const dir = L.data.getParentDirectory();
    assert.strictEqual(dir.length, 2, 'the unattached camper is still reachable');
    const stern = dir.find(d => d.parentName === 'Miri Stern');
    assert.ok(stern, 'Stern family present');
    assert.strictEqual(stern.familyId, null, 'implied families carry no family record id');
});

test('two campers in one family are one directory entry with two children', () => {
    const L = loadLink({
        campistryMe: {
            roster: {
                'Ari Klein': { parent1Name: 'Dov Klein', parent1Email: 'dov@example.com' },
                'Yael Klein': { parent1Name: 'Dov Klein', parent1Email: 'dov@example.com' }
            },
            families: {
                fam_klein_1: {
                    name: 'Klein Family',
                    camperIds: ['Ari Klein', 'Yael Klein'],
                    households: [{ parents: [{ name: 'Dov Klein', email: 'dov@example.com' }] }]
                }
            }
        }
    });
    const dir = L.data.getParentDirectory();
    assert.strictEqual(dir.length, 1);
    assert.strictEqual(dir[0].children.length, 2);
});
