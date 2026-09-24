// =============================================================================
// campistry_snacks_pos.js — Campistry Snacks Selling Console Logic
// Handles: Camper selection, Quick Push POS, Cart, Charge
//
// DATA SOURCES:
//   Campers: campGlobalSettings_v1 → app1.camperRoster (from Campistry Me)
//   Snacks data: campGlobalSettings_v1 → campistrySnacks (shared with manager)
// =============================================================================

(function() {
'use strict';

console.log('[Snacks POS] Loading...');

const STORE_KEY = 'campGlobalSettings_v1';
const SNACKS_LOCAL_KEY = 'campistry_snacks_data';

// ==========================================================================
// DATA LAYER — same as manager, reads from Me + Snacks store
// ==========================================================================

function readGlobal() {
    // STORE_KEY (campGlobalSettings_v1) is what campistry_cloud_bootstrap.js
    // actually hydrates from Supabase into — it must be checked FIRST.
    // CAMPISTRY_UNIFIED_STATE is only ever written by demo_mode.js (offline
    // expo mode) or the standalone registration page; checking it first meant
    // a stale/demo value left in this browser's localStorage would
    // permanently shadow the real, freshly-hydrated roster.
    const keys = [STORE_KEY, 'CAMPISTRY_LOCAL_CACHE', 'CAMPISTRY_UNIFIED_STATE'];
    for (const key of keys) {
        try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw) || {}; } catch (_) {}
    }
    return {};
}

function getRoster() {
    const g = readGlobal();
    return g?.app1?.camperRoster || {};
}

function getStructure() {
    const g = readGlobal();
    return g?.campStructure || {};
}

function getCamperList() {

// ── Camper display name ────────────────────────────────────────────────────
// Roster keys are unique but are not always the camper's name: a second camper
// sharing a name is keyed "Malky Stein #102" (their camperId) — see
// campistry_camper_identity.js. The suffix is always exactly " #<id>" appended to
// the plain name, so stripping it needs no roster lookup. Identity — lookups,
// accounts, ledgers, selection — keeps using the KEY; only humans see this.
function _lbl(key) { return String(key == null ? '' : key).replace(/\s#\d+$/, ''); }
    const roster = getRoster();
    const structure = getStructure();
    const campers = [];
    Object.entries(roster).forEach(([name, data]) => {
        let div = data.division || '';
        let bunk = data.bunk || '';
        if (bunk && !div) {
            Object.entries(structure).forEach(([divName, divData]) => {
                Object.values(divData.grades || {}).forEach(grade => {
                    if ((grade.bunks || []).includes(bunk)) div = divName;
                });
            });
        }
        // See campistry_snacks.js's copy: `name` is the roster key, `label` is
        // what a human should see.
        // `here` is derived, not stored: is this camper at camp TODAY. It is a
        // FLAG and not a filter on purpose. This list is also what decides which
        // canteen accounts are still on the roster, and filtering it by presence
        // would make a first-half camper's account look orphaned in August — with
        // their money in it. Membership and presence are different questions.
        var _P = window.CampistryPresence;
        var _here = !(_P && _P.hasDates()) || _P.isHere(name);
        campers.push({ name, division: div, bunk, camperId: data.camperId, here: _here,
                       label: (data && data.displayName) || String(name).replace(/\s#\d+$/, '') });
    });
    return campers.sort((a, b) => a.name.localeCompare(b.name));
}

function loadSnacksData() {
    const g = readGlobal();
    if (g.campistrySnacks && Object.keys(g.campistrySnacks).length > 0) return g.campistrySnacks;
    try { const raw = localStorage.getItem(SNACKS_LOCAL_KEY); if (raw) return JSON.parse(raw); } catch (_) {}
    return { accounts: {}, inventory: [], transactions: [], hourlyActivity: {}, weeklyRevenue: [] };
}

function saveSnacksData(data) {
    try {
        const g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        g.campistrySnacks = data;
        g.updated_at = new Date().toISOString();
        localStorage.setItem(STORE_KEY, JSON.stringify(g));
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
    } catch (e) { console.warn('[Snacks POS] Global save failed:', e); }
    try { localStorage.setItem(SNACKS_LOCAL_KEY, JSON.stringify(data)); } catch (_) {}
    cloudSaveSnacks(data);
}

function _txSig(t) { return [t.date, t.time, t.camper, t.type, t.amount, t.items].join('|'); }
// KEEP IN SYNC with campistry_snacks.js's copy — see its header for the identity
// rules. Two copies exist because the POS register loads without the manager, and
// they decide what every canteen balance is, so tests/canteen_identity.test.js
// asserts they are character-identical once comments are stripped.
// ── Ledger compaction ───────────────────────────────────────────────────────
// The transactions array is prepend-only and, until this, unbounded: every
// register sale, office save and parent deposit rewrote the whole season, and
// every reader, sync and realtime event paid for it. It could not simply be
// trimmed, because balances are Σ of that very array — trim it and the next
// save rewrites every balance in the camp. So compaction FOLDS instead: rows
// older than a watermark are summed into `ledgerCarry` (the exact three
// buckets _reconcileBalances attributes by, so a recreated account finds its
// history by the same rules as before) and removed, and `ledgerCompactedThrough`
// records the watermark. Balance = carry + Σ(live rows) — identical by
// construction, and compactSnacksLedger refuses to save if it is not.
//
// Nothing is folded that is not already archived: migration 203's trigger
// copies every transaction the cloud ever sees into canteen_transactions, and
// compaction verifies that before dropping a row. The archive is the floor.
//
// The merge has to know about the watermark, or a stale tab whose local copy
// still holds folded rows would union them straight back in — and, keeping the
// cloud's carry as well, count them twice. _mergeCompaction keeps the carry
// that belongs to the higher watermark and drops anything at or below it.
// This block is IDENTICAL in campistry_snacks_pos.js, and a test holds the two
// copies together the way one already holds the two _reconcileBalances.
function _txFolded(t, w) {
    if (!w || !t) return false;
    var d = t.date;
    // Only a well-formed date can be compared; a legacy row with none is never
    // folded and never dropped, so it can never be lost by either.
    return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= w;
}
function _ledgerBuckets(transactions, carry) {
    var c = carry || {};
    var byId = Object.assign({}, c.byId || {});
    var byNameNoId = Object.assign({}, c.byNameNoId || {});
    var byName = Object.assign({}, c.byName || {});
    (transactions || []).forEach(function(t) {
        if (!t) return;
        var amt = parseFloat(t.amount) || 0;
        var signed = (t.type === 'credit' ? amt : -amt);
        var hasId = (t.camperId != null && t.camperId !== '');
        if (hasId) byId[t.camperId] = (byId[t.camperId] || 0) + signed;
        if (t.camper) {
            byName[t.camper] = (byName[t.camper] || 0) + signed;
            if (!hasId) byNameNoId[t.camper] = (byNameNoId[t.camper] || 0) + signed;
        }
    });
    return { byId: byId, byNameNoId: byNameNoId, byName: byName };
}
function _mergeCompaction(merged, tx, cloud, local) {
    var cw = (cloud && cloud.ledgerCompactedThrough) || '';
    var lw = (local && local.ledgerCompactedThrough) || '';
    var w = cw >= lw ? cw : lw;
    if (!w) return tx;
    merged.ledgerCompactedThrough = w;
    merged.ledgerCarry = ((cw >= lw ? cloud : local).ledgerCarry) || {};
    return tx.filter(function(t) { return !_txFolded(t, w); });
}

function _reconcileBalances(data) {
    if (!data || !data.accounts) return data;
    // Seeded from the compaction carry, so a folded row still counts.
    var b = _ledgerBuckets(data.transactions, data.ledgerCarry);
    var byId = b.byId, byNameNoId = b.byNameNoId, byName = b.byName;
    Object.keys(data.accounts).forEach(function(name) {
        var a = data.accounts[name];
        if (!a) return;
        var idSum, nameSum;
        if (a.camperId != null) {
            idSum = byId[a.camperId];
            nameSum = byNameNoId[name];
        } else {
            nameSum = byName[name];
        }
        if (idSum == null && nameSum == null) return;
        a.balance = Math.round(((idSum || 0) + (nameSum || 0)) * 100) / 100;
    });
    return data;
}

// Cloud write. Fetch-merge so a POS write never clobbers a parent deposit or a
// server-side purchase (submit_canteen_purchase) that hit the cloud after this
// tab cached its copy — union the transaction ledgers and recompute balances
// from the union (the ledger is the source of truth).
function _dbg() { try { console.log.apply(console, ['[Snacks POS DEBUG]'].concat(Array.prototype.slice.call(arguments))); } catch (_) {} }
function _invSummary(data) { try { return (data.inventory || []).filter(function(i){ return (i.soldToday||0) > 0 || (i.totalSold||0) > 0; }).map(function(i){ return i.name + ':' + i.soldToday + '/' + i.totalSold; }); } catch (_) { return 'n/a'; } }

function cloudSaveSnacks(data) {
    _dbg('cloudSaveSnacks called, outgoing inventory deltas:', _invSummary(data));
    try {
        const db = window.CampistryDB;
        const client = db && db.getClient ? db.getClient() : (db && db.client);
        const campId = db && db.getCampId && db.getCampId();
        _dbg('resolved db=', !!db, 'client=', !!client, 'campId=', campId);
        if (!client || !campId || !client.from) { _dbg('no client/campId — going straight to _cloudUpsertSnacks fallback'); _cloudUpsertSnacks(data); return; }
        client.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'campistrySnacks').maybeSingle()
            .then(function(res) {
                _dbg('cloud SELECT result: error=', res && res.error, 'hasValue=', !!(res && res.data && res.data.value));
                var cloud = (res && res.data && res.data.value) || null;
                var merged = data;
                if (cloud && typeof cloud === 'object') {
                    var seen = {}, tx = [];
                    (data.transactions || []).concat(cloud.transactions || []).forEach(function(t) { var s = _txSig(t); if (seen[s]) return; seen[s] = 1; tx.push(t); });
                    merged = Object.assign({}, cloud, data);
                    merged.accounts = Object.assign({}, cloud.accounts || {}, data.accounts || {});
                    // autoReload is never something the POS itself sets — it's
                    // owned exclusively by set_canteen_auto_reload (parent) and
                    // canteen-auto-reload/credit_canteen_balance_from_processor
                    // (server). The POS keeps ONE long-lived in-memory `snacks`
                    // object for the whole register session, so the whole-object
                    // merge above lets that stale in-memory autoReload snapshot
                    // (from whenever this page last hydrated) win over the
                    // fresher cloud copy on every single sale. Confirmed live:
                    // that silently reverted autoReload.lastChargedDate back to
                    // a stale value right after a successful instant-triggered
                    // reload, making the account look "not charged today" again
                    // and letting it fire — and get charged — repeatedly. Always
                    // keep the just-fetched cloud's autoReload, never the POS's.
                    Object.keys(merged.accounts).forEach(function(name) {
                        var cloudAr = cloud.accounts && cloud.accounts[name] && cloud.accounts[name].autoReload;
                        if (cloudAr !== undefined) merged.accounts[name].autoReload = cloudAr;
                    });
                    merged.transactions = _mergeCompaction(merged, tx, cloud, data);
                    _reconcileBalances(merged);
                }
                _dbg('about to upsert merged inventory deltas:', _invSummary(merged));
                _cloudUpsertSnacks(merged);
                try { var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); g.campistrySnacks = merged; localStorage.setItem(STORE_KEY, JSON.stringify(g)); } catch (_) {}
                snacks = merged;
            }, function(err) { _dbg('cloud SELECT rejected:', err); _cloudUpsertSnacks(data); });
    } catch (e) { console.warn('[Snacks POS] Cloud save error:', e); _dbg('cloudSaveSnacks threw synchronously:', e); _cloudUpsertSnacks(data); }
}
function _cloudUpsertSnacks(data) {
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) { _dbg('routed through window.saveGlobalSettings authoritative handler instead of direct upsert'); window.saveGlobalSettings('campistrySnacks', data); return; }
    try {
        const db = window.CampistryDB;
        if (!db || !db.client) { _dbg('_cloudUpsertSnacks bailed: db=', !!db, 'db.client=', !!(db && db.client)); return; }
        const campId = db.getCampId && db.getCampId();
        if (!campId) { _dbg('_cloudUpsertSnacks bailed: no campId'); return; }
        _dbg('sending upsert for camp', campId, 'inventory deltas:', _invSummary(data));
        // .select() forces Postgrest to report which rows the write actually
        // touched — without it, a row-level-security policy that silently
        // excludes this write (no matching role/key) comes back as a plain
        // success with 0 rows changed, and a sale never reaches the cloud
        // with nothing in the console or on screen to say so.
        db.client.from('camp_state_kv')
            .upsert({ camp_id: campId, key: 'campistrySnacks', value: data, updated_at: new Date().toISOString() }, { onConflict: 'camp_id,key' })
            .select('camp_id')
            .then(res => {
                _dbg('upsert response: error=', res.error, 'rowsReturned=', res.data && res.data.length);
                if (res.error) { console.warn('[Snacks POS] Cloud save failed:', res.error.message); toast('Sale saved locally, but didn’t reach the cloud — tell the office', true); return; }
                if (!res.data || !res.data.length) { console.warn('[Snacks POS] Cloud save silently blocked (0 rows) — check camp_state_kv RLS for this account’s role.'); toast('Sale saved locally, but didn’t reach the cloud — tell the office', true); }
            }, err => { _dbg('upsert PROMISE REJECTED (not the normal .then error path):', err); console.warn('[Snacks POS] Cloud save threw:', err); toast('Sale saved locally, but didn’t reach the cloud — tell the office', true); });
    } catch (e) { console.warn('[Snacks POS] Cloud save error:', e); }
}

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ==========================================================================
// STATE
// ==========================================================================

let snacks = loadSnacksData();
let campers = [];
let sel = null; // selected camper name
let cart = [];
let cat = 'all';
// Which bunks are "at the canteen right now". Empty set = show everyone.
// Persisted per register device so it survives reloads during a session.
let selectedBunks = loadSelectedBunks();

const BUNKS_LOCAL_KEY = 'campistry_pos_bunks';
function loadSelectedBunks() {
    try { const raw = localStorage.getItem(BUNKS_LOCAL_KEY); if (raw) return new Set(JSON.parse(raw) || []); } catch (_) {}
    return new Set();
}
function saveSelectedBunks() {
    try { localStorage.setItem(BUNKS_LOCAL_KEY, JSON.stringify(Array.from(selectedBunks))); } catch (_) {}
}

function getAccount(name) {
    if (!snacks.accounts) snacks.accounts = {};
    if (!snacks.accounts[name]) snacks.accounts[name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
    const a = snacks.accounts[name];
    // ★ Same reason as campistry_snacks.js's getAccount: 218 omits dailyLimit,
    //   creditLimit and balanceFloor when the column is NULL, and the row writers
    //   create accounts with every one of them NULL. renderCampers reads
    //   a.balance.toFixed(2) and a.dailyLimit - a.spentToday, so a row-backed
    //   account with no limit set would take the camper list down with it.
    if (a.balance == null) a.balance = 0;
    if (a.dailyLimit == null) a.dailyLimit = 10;
    if (a.spentToday == null) a.spentToday = 0;
    // Daily spend resets at midnight
    if (a.lastSpendDate !== todayStr()) { a.spentToday = 0; a.lastSpendDate = todayStr(); }
    return a;
}

// ==========================================================================
// INIT
// ==========================================================================

function init() {
    campers = getCamperList();
    if (!snacks.accounts) snacks.accounts = {};
    if (!snacks.inventory) snacks.inventory = [];
    if (!snacks.transactions) snacks.transactions = [];

    // Ensure all roster campers have accounts
    campers.forEach(c => {
        if (!snacks.accounts[c.name]) snacks.accounts[c.name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
    });

    renderCatButtons();
    renderBunkFilter();
    renderCampers();
    renderItems();
    renderCart();
    _autoOpenCamperDrawerIfNeeded();
    console.log('[Snacks POS] Ready —', campers.length, 'campers,', snacks.inventory.length, 'items');

    // Show empty state if no campers
    // Plain text, not links — this is the standalone counselor console
    // (snacks.campistry.org) and deliberately has no path back into the
    // rest of Campistry for setup.
    if (campers.length === 0) {
        document.getElementById('camperList').innerHTML = '<div style="text-align:center;padding:2rem 1rem;color:var(--text-muted);font-size:.8rem">No campers found.<br>Ask your camp office to add campers.</div>';
    }
    if (snacks.inventory.length === 0) {
        document.getElementById('quickGrid').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);font-size:.8rem;grid-column:1/-1">No inventory items.<br>Ask your camp office to add items.</div>';
        document.getElementById('allGrid').innerHTML = '';
    }
}

// Clock
function tick() { document.getElementById('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
setInterval(tick, 1000); tick();
// Keep balances/limits fresh on a long-running register without a reload
// (a parent raising a limit or adding funds mid-day shows up within ~45s).
setInterval(function() { if (typeof refreshAccountsFromCloud === 'function') refreshAccountsFromCloud(); }, 45000);

// ==========================================================================
// CAMPER PANEL
// ==========================================================================

window.renderCampers = function() {
    const q = (document.getElementById('camperSearch').value || '').toLowerCase();
    const list = campers.filter(c =>
        ((c.label || c.name).toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) &&
        (selectedBunks.size === 0 || (c.bunk && selectedBunks.has(c.bunk)))
    );
    document.getElementById('camperList').innerHTML = list.map(c => {
        const a = getAccount(c.name);
        const rem = a.dailyLimit - a.spentToday;
        // Only a REAL daily limit (>0) can be "hit". dailyLimit 0 = no limit,
        // so rem going negative there must never read as Limit Hit.
        const limitHit = a.dailyLimit > 0 && rem <= 0 && a.balance > 0;
        const cls = a.balance <= 0 ? 'empty' : a.balance <= 5 ? 'low' : '';
        // Display uses the label; identity (selection, accounts, ledger) stays
        // on c.name, the unique roster key.
        const shown = c.label || c.name;
        const initials = shown.split(' ').map(w => w[0]).join('');
        return '<div class="camper-item' + (sel === c.name ? ' selected' : '') + (limitHit ? ' limit-hit' : '') +
            '" onclick="pickCamper(\'' + esc(c.name).replace(/'/g, "\\'") + '\')">' +
            '<div class="camper-avatar">' + initials + '</div>' +
            '<div class="camper-info"><div class="camper-name">' + esc(shown) + '</div>' +
            '<div class="camper-meta">' + esc(c.division) + ' · ' + esc(c.bunk) + (limitHit ? ' · Limit hit' : '') + '</div></div>' +
            '<div class="camper-balance ' + cls + '">$' + a.balance.toFixed(2) + '</div></div>';
    }).join('');
};

window.pickCamper = function(name) {
    if (sel !== name) _pendingSale = null;   // another child: a new sale (TED-168)
    sel = name;
    // Pull this camper's current limit/balance from the cloud so a limit the
    // parent just raised (or a fresh deposit) is reflected immediately — fixes
    // a stale "Limit hit" sticking around after the parent changed it.
    refreshAccountsFromCloud();
    renderCampers();
    updateCamperBar();
    updateChargeBtn();
    // On tablet/phone widths the camper panel is a slide-in drawer (see
    // campistry_snacks_pos.css) — picking a camper is the natural "done"
    // moment, so close it back to the items+cart view automatically.
    document.body.classList.remove('camper-open');
};

// ==========================================================================
// CAMPER PANEL DRAWER (tablet portrait / phone widths only — a no-op CSS
// class toggle at desktop/laptop widths where the panel is a fixed column)
// ==========================================================================

window.toggleCamperPanel = function() {
    document.body.classList.toggle('camper-open');
};

// On true phone widths the camper panel is a slide-in drawer that starts
// closed — which meant a counselor opening the register saw items + cart
// but no camper list, and had to discover the toggle before they could
// pick anyone (they'd reach for the search box, hence "I have to search
// before I can click a camper"). At the start of a sale (no camper picked
// yet, empty cart) auto-open the drawer so the list is right there and
// tappable. `pickCamper` already closes it once a camper is chosen, so
// this never fights the user mid-sale. No-op above the drawer breakpoint,
// where the panel is a permanent column and this class does nothing.
function _autoOpenCamperDrawerIfNeeded() {
    try {
        var isDrawer = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
        if (isDrawer && !sel && campers.length) {
            document.body.classList.add('camper-open');
        }
    } catch (_) {}
}

// ==========================================================================
// BUNK FILTER — "which bunks are at the canteen right now"
// A register serving one bunk at a time only wants to see that bunk's
// campers. This narrows the camper list to the selected bunk(s); empty
// selection = everyone (default). The choice persists on the device.
// ==========================================================================

function getBunkList() {
    var seen = {};
    var out = [];
    campers.forEach(function(c) {
        if (c.bunk && !seen[c.bunk]) { seen[c.bunk] = 1; out.push({ bunk: c.bunk, division: c.division || '' }); }
    });
    // Drop any persisted bunk that no longer exists in the roster so a stale
    // selection can't hide the whole list.
    var valid = {}; out.forEach(function(b){ valid[b.bunk] = 1; });
    Array.from(selectedBunks).forEach(function(b){ if (!valid[b]) selectedBunks.delete(b); });
    return out.sort(function(a, b) { return (a.division + a.bunk).localeCompare(b.division + b.bunk); });
}

function _bunkFilterLabel() {
    if (selectedBunks.size === 0) return 'All bunks';
    if (selectedBunks.size === 1) return Array.from(selectedBunks)[0];
    return selectedBunks.size + ' bunks';
}

window.renderBunkFilter = function() {
    var btn = document.getElementById('bunkFilterBtn');
    var menu = document.getElementById('bunkFilterMenu');
    if (!btn || !menu) return;
    var bunks = getBunkList();
    if (!bunks.length) { document.getElementById('bunkFilterWrap').style.display = 'none'; return; }
    document.getElementById('bunkFilterWrap').style.display = '';
    btn.innerHTML = esc(_bunkFilterLabel()) + ' <span class="bunk-filter-caret">▾</span>';
    var rows = bunks.map(function(b) {
        var checked = selectedBunks.has(b.bunk) ? ' checked' : '';
        var meta = b.division ? '<span class="bunk-filter-div">' + esc(b.division) + '</span>' : '';
        return '<label class="bunk-filter-row"><input type="checkbox" value="' + esc(b.bunk).replace(/"/g, '&quot;') + '"' + checked + ' onchange="onBunkToggle(this)">' +
               '<span>' + esc(b.bunk) + '</span>' + meta + '</label>';
    }).join('');
    menu.innerHTML =
        '<label class="bunk-filter-row bunk-filter-all"><input type="checkbox"' + (selectedBunks.size === 0 ? ' checked' : '') + ' onchange="onBunkAll(this)"><span>All bunks</span></label>' +
        '<div class="bunk-filter-divider"></div>' + rows;
};

window.toggleBunkFilter = function() {
    var menu = document.getElementById('bunkFilterMenu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
};

window.onBunkAll = function(cb) {
    if (cb.checked) { selectedBunks.clear(); saveSelectedBunks(); renderBunkFilter(); renderCampers(); }
    else { cb.checked = true; } // "All" can't be unchecked directly — pick a specific bunk instead
};

window.onBunkToggle = function(cb) {
    if (cb.checked) selectedBunks.add(cb.value); else selectedBunks.delete(cb.value);
    saveSelectedBunks();
    renderBunkFilter();
    renderCampers();
};

// Close the bunk menu on any outside click.
document.addEventListener('click', function(e) {
    var wrap = document.getElementById('bunkFilterWrap');
    var menu = document.getElementById('bunkFilterMenu');
    if (!wrap || !menu || menu.style.display === 'none') return;
    if (!wrap.contains(e.target)) menu.style.display = 'none';
});

// ==========================================================================
// LIMIT / BALANCE FRESHNESS — a register can run all day without a reload.
// When a parent raises a daily limit (or a deposit lands) mid-session, the
// POS's cached account was stale and kept showing "Limit hit" / an old
// balance. get_canteen_accounts is the authoritative cloud read; merge its
// limits + balances back in (never clobbering autoReload) so the camper list
// badge and the client pre-check use current numbers. The server RPC is
// still the real authority on any charge — this just keeps the UI honest.
// ==========================================================================
function refreshAccountsFromCloud(cb) {
    var db = window.CampistryDB;
    var client = db && db.getClient && db.getClient();
    var campId = db && db.getCampId && db.getCampId();
    if (!client || !campId || !client.rpc) { if (cb) cb(); return; }
    client.rpc('get_canteen_accounts', { p_camp_id: campId }).then(function(res) {
        var d = res && res.data;
        if (res.error || !d || !d.success || !d.accounts) { if (cb) cb(); return; }
        if (!snacks.accounts) snacks.accounts = {};
        Object.keys(d.accounts).forEach(function(name) {
            var cloud = d.accounts[name] || {};
            var local = snacks.accounts[name] || {};
            // Overwrite the money/limit fields from the authoritative cloud copy;
            // keep the locally-held autoReload snapshot untouched (owned by the
            // parent/edge, same reasoning as cloudSaveSnacks).
            ['balance', 'dailyLimit', 'spentToday', 'lastSpendDate', 'creditLimit', 'balanceFloor'].forEach(function(k) {
                if (cloud[k] !== undefined) local[k] = cloud[k];
            });
            snacks.accounts[name] = local;
        });
        renderCampers();
        if (sel) { updateCamperBar(); renderCart(); }
        if (cb) cb();
    }, function() { if (cb) cb(); });
}

function updateCamperBar() {
    const bar = document.getElementById('cartCamperBar');
    if (!sel) { bar.innerHTML = '<span class="cart-camper-empty">← Select a camper</span>'; return; }
    const a = getAccount(sel);
    const initials = sel.split(' ').map(w => w[0]).join('');
    bar.innerHTML = '<div class="camper-avatar" style="width:28px;height:28px;font-size:.6rem;background:var(--snacks);color:white">' +
        initials + '</div><div class="cart-camper-name">' + esc(sel) + '</div><div class="cart-camper-bal">$' + a.balance.toFixed(2) + '</div>';
}

// ==========================================================================
// ITEM GRID — sorted by popularity, scaled tiles
// ==========================================================================

window.setCat = function(btn, c) { cat = c; document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderItems(); };

// Categories are free text (set per item in the Manager Dashboard, or via
// bulk upload) rather than a fixed enum, so the filter pills are built from
// whatever's actually in the inventory instead of being hardcoded.
function renderCatButtons() {
    const cats = Array.from(new Set((snacks.inventory || []).map(i => i.cat).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    let html = '<button class="cat-btn' + (cat === 'all' ? ' active' : '') + '" onclick="setCat(this,\'all\')">All</button>';
    cats.forEach(c => {
        html += '<button class="cat-btn' + (cat === c ? ' active' : '') + '" onclick="setCat(this,\'' + c.replace(/'/g, "\\'") + '\')">' + esc(c) + '</button>';
    });
    document.getElementById('catBtns').innerHTML = html;
}

window.renderItems = function() {
    const I = snacks.inventory;
    if (!I.length) return;

    const q = (document.getElementById('itemSearch').value || '').toLowerCase();
    const fil = I.filter(i => (cat === 'all' || i.cat === cat) && i.name.toLowerCase().includes(q));
    const sorted = [...fil].sort((a, b) => (b.totalSold || 0) - (a.totalSold || 0));
    const maxT = Math.max(...I.map(i => i.totalSold || 0), 1);

    // Quick push: top 5 in stock (untracked items — stock == null — always count as "in stock")
    const quick = sorted.filter(i => i.stock == null || i.stock > 0).slice(0, 5);
    document.getElementById('quickGrid').innerHTML = quick.map((i, idx) => {
        let tier = '';
        if (idx === 0) tier = 'hot';
        else if ((i.totalSold || 0) / maxT > .4) tier = 'warm';
        const rank = idx < 3 ? '<div class="tile-rank">#' + (idx + 1) + '</div>' : '';
        const stockHtml = i.stock == null ? '' : '<div class="tile-stock">' + (i.stock === 0 ? 'OUT' : i.stock + ' left') + '</div>';
        return '<div class="item-tile ' + tier + (i.stock === 0 ? ' out' : '') + '" onclick="addItem(' + i.id + ')">' +
            rank + '<div class="tile-name">' + esc(i.name) +
            '</div><div class="tile-price">$' + i.price.toFixed(2) + '</div>' + stockHtml + '</div>';
    }).join('') || '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.75rem;grid-column:1/-1">No items in stock</div>';

    // All
    document.getElementById('allGrid').innerHTML = sorted.map(i =>
        '<div class="item-tile ' + (i.stock === 0 ? 'out' : '') + '" onclick="addItem(' + i.id + ')">' +
        '<div class="tile-name">' + esc(i.name) +
        '</div><div class="tile-price">$' + i.price.toFixed(2) + '</div></div>'
    ).join('');
};

window.addItem = function(id) {
    const item = snacks.inventory.find(i => i.id === id);
    if (!item || item.stock === 0) return;
    const ex = cart.find(c => c.id === id);
    // item.stock == null means untracked — never caps the cart quantity.
    if (ex) { if (item.stock != null && ex.qty >= item.stock) return; ex.qty++; } else cart.push({ id, qty: 1 });
    renderCart();
};

// ==========================================================================
// CART
// ==========================================================================

// Clearing the cart ends that sale: a later sale of the same items to the same
// child is a new sale with a new key (TED-168) — kept, it would replay the first
// sale's answer and charge nothing.
window.clearCart = function() { cart = []; _pendingSale = null; renderCart(); };
window.changeQty = function(id, d) {
    const ci = cart.find(c => c.id === id);
    if (!ci) return;
    ci.qty += d;
    if (ci.qty <= 0) cart = cart.filter(c => c.id !== id);
    renderCart();
};

function renderCart() {
    const body = document.getElementById('cartBody');
    const totalEl = document.getElementById('cartTotal');
    const remEl = document.getElementById('cartRemaining');
    if (!cart.length) {
        body.innerHTML = '<div class="cart-empty">Tap items to start</div>';
        totalEl.textContent = '$0.00';
        remEl.textContent = '';
        updateChargeBtn();
        return;
    }
    let total = 0;
    body.innerHTML = cart.map(ci => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        if (!item) return '';
        const lt = item.price * ci.qty; total += lt;
        return '<div class="cart-line"><div class="cart-line-info"><div class="cart-line-name">' + esc(item.name) +
            '</div><div class="cart-line-sub">$' + item.price.toFixed(2) + ' ea</div></div>' +
            '<div class="cart-line-qty"><button onclick="changeQty(' + ci.id + ',-1)">−</button><span>' + ci.qty +
            '</span><button onclick="changeQty(' + ci.id + ',1)">+</button></div>' +
            '<div class="cart-line-total">$' + lt.toFixed(2) + '</div></div>';
    }).join('');
    totalEl.textContent = '$' + total.toFixed(2);
    if (sel) {
        const a = getAccount(sel);
        const rem = a.dailyLimit - a.spentToday;
        remEl.textContent = 'Daily remaining: $' + Math.max(rem, 0).toFixed(2) + ' · Balance: $' + a.balance.toFixed(2);
    }
    updateChargeBtn();
}

function updateChargeBtn() {
    const btn = document.getElementById('chargeBtn');
    if (_chargeInFlight) { btn.disabled = true; btn.textContent = 'Charging…'; return; }
    const total = cart.reduce((s, ci) => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        return s + (item ? item.price * ci.qty : 0);
    }, 0);
    // Always a visible, clearly-labeled button — never a bare disabled
    // "Charge" that reads as "no button here". The label states exactly what
    // the register operator still needs to do.
    if (!sel) { btn.disabled = true; btn.textContent = 'Select a camper'; return; }
    if (!cart.length || total === 0) { btn.disabled = true; btn.textContent = 'Add items to charge'; return; }
    btn.disabled = false;
    btn.textContent = 'Charge $' + total.toFixed(2) + ' → ' + sel.split(' ')[0];
}

// ==========================================================================
// CHARGE — deducts balance, decrements stock, logs transaction
// ==========================================================================

// One sale at a time, and one key per sale (TED-159). Tapping Charge again
// while a charge is on its way does nothing; a retry of the SAME sale (same
// child, same items) after an answer never came sends the same key, which the
// server (migration 283) answers with the first result instead of charging the
// child again. A different sale gets a new key.
var _chargeInFlight = false;
var _pendingSale = null;          // { key, fp } — a sale with no answer yet
function _saleKeyFor(fp) {
    if (_pendingSale && _pendingSale.fp === fp) return _pendingSale.key;
    _pendingSale = { fp: fp, key: 'sale_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10) };
    return _pendingSale.key;
}

window.charge = function() {
    if (!sel || !cart.length) return;
    if (_chargeInFlight) return;
    const camperName = sel;           // the toast must not read `sel` after it is cleared
    // THIS sale's items, as they are now (TED-169): the answer may come back
    // after the counselor has started the next child's sale, and that cart is
    // not what was sold.
    const saleCart = cart.map(ci => ({ id: ci.id, qty: ci.qty }));
    const a = getAccount(sel);
    const total = Math.round(cart.reduce((s, ci) => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        return s + (item ? item.price * ci.qty : 0);
    }, 0) * 100) / 100;
    const itemNames = cart.map(ci => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        if (!item) return '';
        return ci.qty > 1 ? item.name + ' ×' + ci.qty : item.name;
    }).filter(Boolean).join(', ');

    // Fast client-side PRE-check (UX only — the server RPC is the authority).
    const rem = a.dailyLimit - a.spentToday;
    if (a.dailyLimit > 0 && total > rem) { toast('Exceeds daily limit ($' + Math.max(rem,0).toFixed(2) + ' left)', true); return; }
    const spendable = a.balance - (a.balanceFloor || 0) + (a.creditLimit || 0);
    if (total > spendable) { toast('Insufficient balance ($' + spendable.toFixed(2) + ' spendable)', true); return; }

    // ── AUTHORITATIVE PATH: submit_canteen_purchase enforces the parent's daily
    // limit + overdraft atomically under a row lock (migration 026). This is the
    // ONE place caps are guaranteed — a client bypass or a race can't overspend.
    const _cdb = window.CampistryDB;
    const client = _cdb && _cdb.getClient && _cdb.getClient();
    const campId = _cdb && _cdb.getCampId && _cdb.getCampId();
    const finish = (viaRpc, replayed) => {
        const hr = new Date().getHours();
        const itemDeltas = saleCart.map(ci => ({ id: ci.id, qty: ci.qty }));
        saleCart.forEach(ci => { const item = snacks.inventory.find(i => i.id === ci.id); if (item) { if (item.stock != null) item.stock -= ci.qty; item.soldToday = (item.soldToday || 0) + ci.qty; item.totalSold = (item.totalSold || 0) + ci.qty; } });
        if (!snacks.hourlyActivity) snacks.hourlyActivity = {};
        snacks.hourlyActivity[hr] = (snacks.hourlyActivity[hr] || 0) + 1;
        if (viaRpc && client && campId && client.rpc) {
            // submit_canteen_purchase already wrote the debit transaction and the
            // new balance atomically under its own row lock — this path must
            // NEVER touch accounts/transactions again. cloudSaveSnacks's
            // select-then-blind-upsert cycle has no lock/version check, so if it
            // ran here it could silently overwrite a concurrent server-side
            // credit (e.g. an instant canteen-auto-reload charge landing in the
            // gap between its own SELECT and UPSERT) — confirmed live via the
            // camp's real Cardknox log: real charges vanished from the ledger
            // entirely this way. record_canteen_sale_inventory (migration 142)
            // only ever touches inventory/hourlyActivity, so it can't race with
            // anything money-related no matter the timing.
            client.rpc('record_canteen_sale_inventory', { p_camp_id: campId, p_items: itemDeltas, p_hour: hr })
                .then(function() {}, function(e) { _dbg('record_canteen_sale_inventory failed:', e); });
            try {
                var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
                g.campistrySnacks = snacks;
                localStorage.setItem(STORE_KEY, JSON.stringify(g));
                localStorage.setItem(SNACKS_LOCAL_KEY, JSON.stringify(snacks));
            } catch (_) {}
        } else {
            // Local/offline fallback path — the client itself is the only
            // record of this debit, so it still needs the full fetch-merge
            // save to get the transaction and balance into the cloud.
            saveSnacksData(snacks);
        }
        const cp = document.querySelector('.cart-panel'); if (cp) { cp.classList.add('flash'); setTimeout(() => cp.classList.remove('flash'), 600); }
        // A repeat of a sale that had already gone through (the answer was lost
        // the first time) says so, rather than "✓ charged" for a charge not made.
        toast(replayed ? 'Already charged — the earlier $' + total.toFixed(2) + ' charge to ' + camperName + ' went through; not charged again'
                       : '✓ $' + total.toFixed(2) + ' charged to ' + camperName);
        // Clear the screen only if it still shows THIS sale (TED-169).
        // The same child by number where the account has one (a key otherwise).
        const saleCamperId = a && a.camperId != null ? String(a.camperId) : null;
        const selCamperId = sel != null && getAccount(sel) && getAccount(sel).camperId != null ? String(getAccount(sel).camperId) : null;
        const sameChild = sel != null && (saleCamperId != null && selCamperId != null ? selCamperId === saleCamperId : sel === camperName);
        const stillThisSale = sameChild && cart.length === saleCart.length
            && cart.every((ci, i) => ci.id === saleCart[i].id && ci.qty === saleCart[i].qty);
        if (stillThisSale) { cart = []; sel = null; }
        renderCampers(); renderItems(); renderCart(); updateCamperBar();
        if (stillThisSale) { var cs = document.getElementById('camperSearch'); if (cs) { cs.value = ''; cs.focus(); } }
    };

    // Best-effort local charge (offline, or before the purchase RPC exists).
    // Enforcement is the client pre-check above ONLY — the parent's daily
    // limit / overdraft is NOT being verified server-side for this charge.
    // Staff must know that in the moment (not just silently succeed exactly
    // like an enforced charge) so a legitimate connectivity gap doesn't turn
    // into an invisible cap bypass; `warnMsg` surfaces that, non-blocking —
    // the sale still goes through (blocking sales on a wifi blip would be a
    // worse regression than a rare unenforced charge) and the ledger
    // reconciles once back online.
    const localCharge = (warnMsg) => {
        if (warnMsg) toast(warnMsg, true);
        a.balance = Math.round((a.balance - total) * 100) / 100;
        a.spentToday = Math.round((a.spentToday + total) * 100) / 100;
        a.lastSpendDate = todayStr();
        if (!snacks.transactions) snacks.transactions = [];
        // THIS sale's child (camperName), not whoever is selected now (TED-169).
        snacks.transactions.unshift({ time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), camper: camperName,
            // See _reconcileBalances: the ledger joins on camperId when it has
            // one, so a reused name cannot inherit another camper's balance.
            camperId: (snacks.accounts && snacks.accounts[camperName] && snacks.accounts[camperName].camperId) != null
                ? snacks.accounts[camperName].camperId : undefined,
            items: itemNames, amount: total, type: 'debit', date: todayStr() });
        finish(false);
    };

    if (client && campId && client.rpc) {
        // The PERSON, when the roster has an id for them (migration 247): the
        // server charges the account of whoever carries this id, not whoever
        // the name resolves to — two campers can share a name.
        const _c = (campers || []).find(c => c.name === camperName);
        const _cid = _c && _c.camperId != null && _c.camperId !== '' ? Number(_c.camperId) : null;
        const _args = { p_camp_id: campId, p_camper_name: camperName, p_amount: total, p_items: itemNames, p_date: todayStr() };
        if (_cid != null && !isNaN(_cid)) _args.p_camper_id = _cid;
        const _fp = (_cid != null && !isNaN(_cid) ? _cid : 'n:' + camperName) + '|' + total.toFixed(2) + '|' + itemNames;
        const _saleKey = _saleKeyFor(_fp);
        const _btn = document.getElementById('chargeBtn');
        _chargeInFlight = true;
        if (_btn) { _btn.disabled = true; _btn.textContent = 'Charging…'; }
        const _done = () => { _chargeInFlight = false; updateChargeBtn(); };
        const _noAnswer = () => {
            // Nothing definite came back: it may have gone through. The key is
            // kept, so pressing Charge again for this sale cannot charge twice.
            toast('Could not confirm the charge to ' + camperName + ' — it may have gone through. Check their transactions; pressing Charge again for the same items will not charge twice.', true);
        };
        const _send = (fn, args) => client.rpc(fn, args);
        const _missing = (res) => !!(res && res.error && /PGRST202|could not find|schema cache|does not exist|no function/i.test(res.error.message || ''));
        // What this sale sold, by item id (TED-192, migration 289), kept with
        // the sale so a void can put exactly those items back in stock.
        const _sold = saleCart.map(ci => ({ id: ci.id, qty: ci.qty }));
        _send('submit_canteen_purchase_once', Object.assign({ p_sale_key: _saleKey, p_sold: _sold }, _args))
            // 289 not applied yet: the same keyed sale without the item list
            .then(res => _missing(res) ? _send('submit_canteen_purchase_once', Object.assign({ p_sale_key: _saleKey }, _args)) : res)
            .then(res => {
                // 283 not applied yet: the charge as it was, one request.
                if (_missing(res)) return _send('submit_canteen_purchase', _args);
                return res;
            })
            .then(res => {
                _done();
                const d = res && res.data;
                const emsg = (res && res.error && res.error.message) || '';
                // Migration 026 not applied yet → RPC doesn't exist → don't break
                // the register; fall back to the local path.
                if (res && res.error && /PGRST202|could not find|schema cache|does not exist|no function/i.test(emsg)) { _pendingSale = null; localCharge('⚠ Spending limits not synced yet — charge not verified against caps'); return; }
                // No answer from the server (a dropped connection comes back as an
                // error with no database code): never "Charge failed".
                if (!res || (res.error && !res.error.code && !d)) { _noAnswer(); return; }
                if (res.error || !d || !d.success) {
                    _pendingSale = null;             // refused: nothing was charged
                    const err = (d && d.error) || emsg || 'charge_failed';
                    const msg = err === 'daily_limit_exceeded' ? 'Blocked — over daily limit ($' + (Number((d && d.remaining) || 0)).toFixed(2) + ' left today)'
                              : err === 'insufficient_balance' ? 'Blocked — insufficient balance ($' + (Number((d && d.spendable) || 0)).toFixed(2) + ' spendable)'
                              : err === 'not_authorized' ? 'Not authorized to charge this camp'
                              : 'Charge failed (' + err + ')';
                    toast(msg, true);
                    return;
                }
                _pendingSale = null;                 // answered: the next sale is a new one
                a.balance = Number(d.balance); a.spentToday = Number(d.spentToday); a.lastSpendDate = todayStr();
                finish(true, !!d.replayed);
                // Instant auto-reload check — fire-and-forget, never blocks the
                // register. submit_canteen_purchase (migration 140) only sets
                // needsReloadCheck when this sale just pushed the camper under
                // their configured threshold; canteen-auto-reload is still the
                // sole authority on whether anything actually gets charged, so
                // a spurious call here just no-ops. Without this, a low balance
                // would otherwise sit unresolved until the next 30-min cron
                // tick (CANTEEN_AUTORELOAD_SETUP.md).
                if (d.needsReloadCheck && client.functions && client.functions.invoke) {
                    client.functions.invoke('canteen-auto-reload', { body: { campId: campId, camperName: camperName, camperId: _cid != null && !isNaN(_cid) ? _cid : undefined } }).catch(() => {});
                }
            }, e => { _done(); _noAnswer(); });
        return;
    }

    localCharge('⚠ Offline — spending limits not checked, will reconcile when back online');
};

// ==========================================================================
// BARCODE SCANNER SUPPORT
// A USB/Bluetooth barcode scanner acts as a keyboard — no driver or pairing
// UI needed beyond what the OS already does for any keyboard. It "types"
// the scanned code character-by-character, far faster than a human can,
// then sends Enter. This listens globally (not tied to any one input) so
// scanning works no matter what's focused, matching how items get their
// barcode assigned in the Manager Dashboard's Menu Items editor.
// ==========================================================================

(function() {
    var buf = '';
    var lastAt = 0;
    var MAX_GAP_MS = 50; // scanner keystrokes land well under this; sustained human typing rarely does
    var MIN_LEN = 3;      // ignore stray 1-2 char "scans"

    document.addEventListener('keydown', function(e) {
        var now = Date.now();
        if (e.key === 'Enter') {
            var code = buf;
            var looksScanned = code.length >= MIN_LEN && (now - lastAt) <= MAX_GAP_MS;
            buf = '';
            if (looksScanned) {
                var t = e.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.value.slice(-code.length) === code) {
                    // The scan just typed the code (+ Enter) into whatever field
                    // had focus, usually one of the search boxes — strip it back
                    // out so it doesn't sit there as a bogus filter.
                    t.value = t.value.slice(0, -code.length);
                    if (t.id === 'itemSearch') renderItems();
                    if (t.id === 'camperSearch') renderCampers();
                }
                e.preventDefault();
                scanBarcode(code);
            }
            lastAt = now;
            return;
        }
        // Only plausible barcode characters extend the buffer (covers
        // Code128/EAN/UPC and QR-as-text). Anything else — Tab, arrows,
        // modifier keys — resets it without disturbing the gap timing.
        if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
            if (now - lastAt > MAX_GAP_MS) buf = '';
            buf += e.key;
            lastAt = now;
        } else if (e.key !== 'Shift') {
            buf = '';
        }
    });
})();

function scanBarcode(code) {
    const item = (snacks.inventory || []).find(i => i.barcode && i.barcode === code);
    if (!item) { toast('Unrecognized barcode: ' + code, true); return; }
    if (item.stock === 0) { toast(item.name + ' is out of stock', true); return; }
    addItem(item.id);
    toast('✓ Scanned ' + item.name);
}

// ==========================================================================
// UTILS
// ==========================================================================

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function toast(msg, err) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (err ? ' err' : '');
    setTimeout(() => el.className = 'toast', 2200);
}

// Signs the register out of the shadow PIN-login session and returns to the
// PIN screen — lets a runner lock the register when stepping away without
// anyone else touching their session. The PIN screen lives on this same
// page (see campistry_snacks_pos.html's pinOverlay), so locking is just a
// reload: with no session left, the page comes back up already locked.
window.posLockRegister = function() {
    const db = window.CampistryDB;
    const client = db && db.getClient && db.getClient();
    if (client && client.auth && client.auth.signOut) {
        client.auth.signOut().finally(() => { window.location.reload(); });
    } else {
        window.location.reload();
    }
};

document.addEventListener('DOMContentLoaded', init);

// Re-init after cloud hydration or when another tab (admin / parent portal) writes
window.CampistrySnacksPOS = {
    reinit: function() { snacks = loadSnacksData(); init(); }
};
// The roster and campistrySnacks data both hydrate from the cloud
// asynchronously, shortly AFTER DOMContentLoaded fires — init() above runs
// before that lands, so on a fresh page load the camper list was empty and
// nothing ever re-ran init() afterward. Re-run once hydration completes.
window.addEventListener('campistry-cloud-hydrated', function() {
    console.log('[Snacks POS] Cloud hydrated — reloading roster + snacks data');
    snacks = loadSnacksData();
    _hydratePosRoster().then(init, init);
});

// The generic cloud_bootstrap fetch reads camp_state_kv's app1 key like
// every other page — but a PIN-login register runs as the hidden shadow
// counselor account (see pos-pin-login), and camp_state_kv's RLS
// deliberately blocks 'counselor' from reading app1 (a real, intentional
// privacy carve-out for actual bunk counselors on Campistry Lite, who
// shouldn't see the whole camp's roster/finance/health data). That's why
// snacks inventory hydrates fine but the camper list stays empty. Fetch
// just the roster through get_pos_roster (migration 104) instead — a
// narrowly-scoped RPC that returns only {camperName: {division,bunk,team}},
// nothing else app1 holds — and merge it into the same local cache
// getRoster()/getCamperList() already read from, so nothing else here
// needs to change.
function _hydratePosRoster() {
    const db = window.CampistryDB;
    const client = db && db.getClient && db.getClient();
    const campId = db && db.getCampId && db.getCampId();
    if (!client || !campId) return Promise.resolve();
    return client.rpc('get_pos_roster', { p_camp_id: campId }).then(res => {
        const data = res && res.data;
        if (res.error || !data || !data.success) {
            console.warn('[Snacks POS] get_pos_roster failed:', res.error, data);
            return;
        }
        try {
            const raw = localStorage.getItem(STORE_KEY);
            const g = raw ? JSON.parse(raw) : {};
            g.app1 = g.app1 || {};
            g.app1.camperRoster = data.camperRoster || {};
            localStorage.setItem(STORE_KEY, JSON.stringify(g));
        } catch (e) {
            console.warn('[Snacks POS] Could not merge roster into local cache:', e);
        }
    }, e => {
        console.warn('[Snacks POS] get_pos_roster threw:', e);
    });
}
window.addEventListener('storage', function(e) {
    if (e.key === STORE_KEY || e.key === 'CAMPISTRY_LOCAL_CACHE') {
        snacks = loadSnacksData();
        renderCampers(); renderItems(); renderCart();
    }
});
})();
