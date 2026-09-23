// =============================================================================
// campistry_snacks.js — Campistry Snacks Manager Dashboard Logic
// Handles: Accounts, Deposits, Inventory, Restock, Limits, Analytics
//
// DATA SOURCES:
//   Campers: campGlobalSettings_v1 → app1.camperRoster (from Campistry Me)
//   Structure: campGlobalSettings_v1 → campStructure (from Campistry Me)
//   Snacks data: campGlobalSettings_v1 → campistrySnacks (own data)
//     - accounts: { [camperName]: { balance, dailyLimit, spentToday } }
//     - inventory: [ { id, name, cat, emoji, price, stock, soldToday, totalSold } ]
//     - transactions: [ { time, camper, items, amount, date } ]
//     - hourlyActivity: { [hour]: count }
//     - weeklyRevenue: [ { day, amount } ]
// =============================================================================

(function() {
'use strict';

console.log('[Snacks Manager] Loading...');

const STORE_KEY = 'campGlobalSettings_v1';
const SNACKS_LOCAL_KEY = 'campistry_snacks_data'; // fallback

// ==========================================================================
// PAYMENT METHODS
//
// The catalogue and the debit stance are camp-wide policy, owned by
// campistry_payments.js — the canteen doesn't get its own opinion, or the
// office ends up with four screens disagreeing about what they take.
//
// The camp refuses debit on TUITION (chargeback/NSF exposure, no installment
// support), and the canteen inherits it. There's a second reason here on top:
// a canteen balance is prepaid money a camper can draw back out as cash (see
// cashOut below), which makes funding it from debit a cash-equivalent
// transaction.
//
// `on` is the out-of-the-box default; the office toggles these in Settings.
// ==========================================================================
function _payAPI() { return (typeof window !== 'undefined' && window.CampistryPayments) || null; }

function payMethodCatalogue() {
    const P = _payAPI();
    if (P) {
        // Everything valid in the canteen, with the camp's defaults applied.
        const enabled = P.forContext('canteen').map(m => m.id);
        return P.METHODS
            .filter(m => m.contexts.includes('canteen'))
            .map(m => ({ id: m.id, label: m.label, on: enabled.includes(m.id) }));
    }
    // Policy module missing — a minimal, safe fallback rather than no options.
    return [
        { id: 'cash', label: 'Cash', on: true },
        { id: 'credit', label: 'Credit card', on: true },
        { id: 'check', label: 'Check', on: true }
    ];
}
function blockedPayMethods() {
    const P = _payAPI();
    return P ? P.blockedFor('canteen') : [];
}
const PAY_METHODS = payMethodCatalogue();
const BLOCKED_PAY_METHODS = blockedPayMethods();

const DEFAULT_SNACKS_SETTINGS = {
    payMethods: PAY_METHODS.filter(m => m.on).map(m => m.id),
    defaultDailyLimit: 10,
    cashDailyMax: 20,           // per camper, per day; 0 = uncapped
    cashReasonRequired: true,
    cashAllowNegative: false    // off = a camper can't withdraw money they don't have
};

// ==========================================================================
// DATA LAYER — Read from Campistry Me, persist Snacks-specific data
// ==========================================================================

function readGlobal() {
    // STORE_KEY (campGlobalSettings_v1) is what campistry_cloud_bootstrap.js
    // actually hydrates from Supabase into — it must be checked FIRST.
    // CAMPISTRY_UNIFIED_STATE is only ever written by demo_mode.js (offline
    // expo mode) or the standalone registration page; if either of those was
    // ever visited in this browser, that key sits in localStorage
    // indefinitely and — when checked first — permanently shadows the real,
    // freshly-hydrated roster with stale/demo data. This was reported as
    // "campers not showing in Snacks" even after cloud hydration confirmed
    // finding real campers.
    const keys = [STORE_KEY, 'CAMPISTRY_LOCAL_CACHE', 'CAMPISTRY_UNIFIED_STATE'];
    let g = {};
    for (const key of keys) {
        try { const raw = localStorage.getItem(key); if (raw) { g = JSON.parse(raw) || {}; break; } } catch (_) {}
    }
    return _withFullRoster(g);
}

// ★ THE ROSTER IS NOT IN localStorage, AND HAS NOT BEEN SINCE THE IDB MOVE.
//
// integration_hooks' setLocalSettings writes campGlobalSettings_v1 as a LITE
// snapshot — it deliberately `delete`s app1.camperRoster (and the other keys that
// grow without bound) so a large camp cannot blow localStorage's ~5MB ceiling.
// The complete state lives in IndexedDB and is what window.loadGlobalSettings()
// returns.
//
// So a page that reads the roster straight out of localStorage sees it exactly
// once — in the window between campistry_cloud_bootstrap.js writing the raw cloud
// keys and the first hydration replacing them with the lite snapshot — and
// nothing after that. On this page the symptom is the whole canteen: no campers
// to deposit for, no accounts, no cash out, no shop order, on every load. The
// comment above blames CAMPISTRY_UNIFIED_STATE for "campers not showing in
// Snacks", which was a real cause once; this is the other one.
//
// campistry_live.js and campistry_live_locator.js already prefer the full state.
// Four more pages do now, and tests/full_state_readers.test.js is what keeps a
// fifth from arriving without it.
function _withFullRoster(lite) {
    try {
        if ((lite.app1 && lite.app1.camperRoster) ||
            typeof window.loadGlobalSettings !== 'function') return lite;
        const full = window.loadGlobalSettings();
        const r = full && full.app1 && full.app1.camperRoster;
        if (!r || !Object.keys(r).length) return lite;
        const out = Object.assign({}, lite);
        out.app1 = Object.assign({}, lite.app1, { camperRoster: r });
        return out;
    } catch (_) { return lite; }
}

function getRoster() {
    const g = readGlobal();
    return g?.app1?.camperRoster || {};
}

function getStructure() {
    const g = readGlobal();
    return g?.campStructure || {};
}

// Build flat camper list from roster: [ { name, division, bunk } ]
/** True when presence is knowable at this camp and therefore worth gating on. */
function _snacksPresenceGate() {
    var P = window.CampistryPresence;
    return !!(P && P.hasDates());
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
        // Resolve division name from structure if needed
        let div = data.division || '';
        let bunk = data.bunk || '';

        // If bunk is set but division isn't, find it from structure
        if (bunk && !div) {
            Object.entries(structure).forEach(([divName, divData]) => {
                Object.values(divData.grades || {}).forEach(grade => {
                    if ((grade.bunks || []).includes(bunk)) div = divName;
                });
            });
        }

        // camperId rides along so the canteen can join money to a PERSON rather
        // than to a name — see _reconcileBalances. It may be absent on an
        // older roster entry; ensureAccountsForRoster tolerates that.
        // `name` is the roster KEY, which is unique but is not always the
        // camper's name: a second camper sharing a name is keyed
        // "Malky Stein #102" and carries displayName. Accounts and the ledger
        // key off the KEY (so two same-named campers now get two accounts, which
        // is the point), while every screen shows `label`.
        // `here` is derived, not stored: is this camper at camp TODAY. A FLAG and
        // not a filter, deliberately — `rosterNames` below is built from this list
        // to decide which canteen accounts are still on the roster, and filtering
        // by presence would make a first-half camper's account look orphaned in
        // August with their money still in it. Membership and presence are
        // different questions, and this list answers the first one.
        var _P = window.CampistryPresence;
        var _here = !(_P && _P.hasDates()) || _P.isHere(name);
        campers.push({ name, division: div, bunk, camperId: data.camperId, here: _here,
                       label: (data && data.displayName) || String(name).replace(/\s#\d+$/, '') });
    });

    return campers.sort((a, b) => a.name.localeCompare(b.name));
}

// === SNACKS-SPECIFIC DATA ===

function loadSnacksData() {
    // Priority 1: from global settings (cloud-synced)
    const g = readGlobal();
    if (g.campistrySnacks && Object.keys(g.campistrySnacks).length > 0) {
        return g.campistrySnacks;
    }
    // Priority 2: local fallback
    try {
        const raw = localStorage.getItem(SNACKS_LOCAL_KEY);
        if (raw) return JSON.parse(raw);
    } catch (_) {}
    // Default empty
    return { accounts: {}, inventory: [], transactions: [], hourlyActivity: {}, weeklyRevenue: [] };
}

function saveSnacksData(data) {
    // Write to global settings (for cloud sync)
    try {
        const g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        g.campistrySnacks = data;
        g.updated_at = new Date().toISOString();
        localStorage.setItem(STORE_KEY, JSON.stringify(g));
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
    } catch (e) {
        console.warn('[Snacks] Global save failed, using local fallback:', e);
    }
    // Also write local fallback
    try { localStorage.setItem(SNACKS_LOCAL_KEY, JSON.stringify(data)); } catch (_) {}

    cloudSaveSnacks(data);
}

// Signature used to dedupe transactions across the stale-local vs fresh-cloud
// merge (transactions carry no id).
function _txSig(t) {
    return [t.date, t.time, t.camper, t.type, t.amount, t.items].join('|');
}

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

// The canteen is event-sourced: an account's balance is always Σ of its
// transactions, recomputed here rather than stored. That is why a balance edited
// without a matching transaction is erased by the next merge.
//
// IDENTITY. The ledger was keyed by camper NAME alone, so a new camper reusing a
// deleted camper's name inherited their balance — two children called the same
// thing across two summers is not exotic (TEST_FINDINGS.md D4).
//
// An account that HAS a camperId counts its own id's transactions, plus any
// UNIDENTIFIED transactions under its name. That second part is not laziness: every
// transaction written before this change has no id, and ignoring them would drop a
// real balance to zero — the same bug pointed the other way. What it must never do
// is count a transaction belonging to a DIFFERENT id, which is exactly how the
// money used to move between two children sharing a name.
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


// Cloud write. campistrySnacks is a shared blob that a parent's SECURITY DEFINER
// deposit (migration 019, FOR UPDATE + merge) and the admin manager both write.
// The manager loads from possibly-stale LOCAL storage, so a naive full-blob
// upsert here can clobber a parent deposit that landed on the cloud after this
// tab cached its copy. Fetch the CURRENT cloud value first, union the
// transaction ledgers, then recompute balances from the union — so no deposit
// or purchase is ever lost, regardless of write order.
// ★ 219: balances and the ledger live in rows now, not in this document.
//
// camp_canteen_accounts is the truth for every balance, daily limit and
// auto-reload setting, and canteen_transactions is the truth for the ledger.
// Reading them from the document would show whatever it held at the moment the
// writers stopped maintaining it — frozen numbers, with no error to notice.
//
// get_canteen_accounts (218) serves both from the rows, already scoped: staff
// get the whole camp, a parent gets only their own children.
function _loadCanteenRows(then) {
    try {
        const db = window.CampistryDB;
        const client = db && db.client;
        const campId = db && db.getCampId && db.getCampId();
        if (!client || !campId) { then(null); return; }
        client.rpc('get_canteen_accounts', { p_camp_id: campId })
            .then(function (res) {
                const d = res && res.data;
                // A failure must not be mistaken for an empty camp: showing
                // every balance as zero is worse than showing none, because it
                // looks like an answer.
                if (!d || d.success !== true) { then(null); return; }
                then({ accounts: d.accounts || {}, transactions: d.transactions || [] });
            }, function () { then(null); });
    } catch (_) { then(null); }
}

// Overlay the row-backed truth onto whatever the document gave us. The
// document still owns inventory, POS configuration and the rest.
function _overlayCanteenRows(target, done) {
    _loadCanteenRows(function (rows) {
        if (rows && target && typeof target === 'object') {
            target.accounts = rows.accounts;
            target.transactions = rows.transactions;
        }
        if (typeof done === 'function') done(!!rows);
    });
}

// ★ 219: never write accounts or transactions back into the document. They are
// not ours to write any more, and a whole-document save carrying a stale copy
// is exactly the compare-and-set that would have overwritten live balances
// while the projection trigger still existed.
function _withoutRowBackedBranches(data) {
    if (!data || typeof data !== 'object') return data;
    const copy = Object.assign({}, data);
    delete copy.accounts;
    delete copy.transactions;
    return copy;
}

function cloudSaveSnacks(data) {
    try {
        const db = window.CampistryDB;
        const client = db && db.client;
        const campId = db && db.getCampId && db.getCampId();
        if (!client || !campId) { _cloudUpsertSnacks(_withoutRowBackedBranches(data)); return; }
        client.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'campistrySnacks').maybeSingle()
            .then(function(res) {
                var cloud = (res && res.data && res.data.value) || null;
                var merged = _mergeSnacksInto(cloud, data);
                // ★ 219: the document keeps inventory and configuration; the
                // balances and the ledger it still holds are a frozen copy
                // from before the writers moved to rows, so they are stripped
                // rather than written back.
                _cloudUpsertSnacks(_withoutRowBackedBranches(merged));
                // Keep local mirror consistent with what we just wrote.
                try { var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); g.campistrySnacks = merged; localStorage.setItem(STORE_KEY, JSON.stringify(g)); } catch (_) {}
                snacks = merged;
            }, function() { _cloudUpsertSnacks(_withoutRowBackedBranches(data)); });
    } catch (e) { console.warn('[Snacks] Cloud save error:', e); _cloudUpsertSnacks(data); }
}

function _cloudUpsertSnacks(data) {
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
        window.saveGlobalSettings('campistrySnacks', data);
        return;
    }
    try {
        const db = window.CampistryDB;
        if (!db || !db.client) return;
        const campId = db.getCampId && db.getCampId();
        if (!campId) return;
        db.client.from('camp_state_kv')
            .upsert({ camp_id: campId, key: 'campistrySnacks', value: data, updated_at: new Date().toISOString() }, { onConflict: 'camp_id,key' })
            .then(res => { if (res.error) console.warn('[Snacks] Cloud save failed:', res.error.message); });
    } catch (e) { console.warn('[Snacks] Cloud save error:', e); }
}

// ==========================================================================
// STATE
// ==========================================================================

let snacks = loadSnacksData();
let camperList = [];
// init() runs once immediately on page load (for instant UI, before this
// page's own cloud hydration has landed) and again after 'campistry-cloud-
// hydrated' fires with the real data. On that FIRST call the roster/snacks
// data can be empty or stale — real bug found live: ensureAccountsForRoster()
// saw an empty pre-hydration roster, deleted every account as "orphaned",
// and auto-saved that stale snapshot. cloudSaveSnacks's fetch-merge unions
// transactions/accounts but replaces inventory wholesale, so that one
// pre-hydration save silently wiped out inventory counters (soldToday/
// totalSold) a POS register had *just* correctly written to the cloud
// moments earlier. Block any auto-save until real data has loaded once.
let _hydratedOnce = false;

function ensureAccountsForRoster() {
    // Create snacks accounts for any campers in the roster that don't have one
    camperList = getCamperList();
    if (!snacks.accounts) snacks.accounts = {};
    let changed = false;
    const _dflt = getSettings().defaultDailyLimit;

    // ── TWO CAMPERS, ONE NAME ────────────────────────────────────────────────
    // `accounts` is keyed by NAME, so a new camper arriving with the same name as
    // a CLOSED account would land on that account and take it over — the last way
    // the canteen could hand one child's money to another. Two unrelated children
    // called the same thing across two summers is ordinary.
    //
    // The closed account is moved aside to its own key first. That re-key would
    // break its ledger link, because a transaction written before camperId
    // existed matches only by name — so those UNIDENTIFIED rows are stamped with
    // the departing camper's id at the same moment. Stamping is safe precisely
    // here and nowhere else: until this instant that name has only ever belonged
    // to them, so an unidentified row under it can only be theirs.
    camperList.forEach(c => {
        const prior = snacks.accounts[c.name];
        if (!prior || !prior.closed) return;
        const sameCamper = (c.camperId != null && prior.camperId != null &&
                            String(prior.camperId) === String(c.camperId));
        if (sameCamper) return;                 // the SAME child is back — reopen it
        const archiveId = prior.camperId != null ? prior.camperId
                        : ('legacy_' + Date.now().toString(36));
        (snacks.transactions || []).forEach(t => {
            if (!t || t.camper !== c.name) return;
            if (t.camperId == null || t.camperId === '') t.camperId = archiveId;
        });
        prior.camperId = archiveId;
        const archiveKey = c.name + ' #' + archiveId;
        if (!snacks.accounts[archiveKey]) snacks.accounts[archiveKey] = prior;
        delete snacks.accounts[c.name];
        changed = true;
        console.warn('[Snacks] "' + c.name + '" is a new camper sharing a name with a ' +
            'closed account — the closed one is now "' + archiveKey + '" and keeps its money');
    });

    camperList.forEach(c => {
        if (!snacks.accounts[c.name]) {
            snacks.accounts[c.name] = { balance: 0, dailyLimit: _dflt, spentToday: 0 };
            changed = true;
        }
        // Stamp the stable id so this account's money is joined to a PERSON and
        // not to a string. A returning camper who is re-added keeps their id, so
        // their history follows them; an unrelated child who happens to share the
        // name does not inherit it.
        const a = snacks.accounts[c.name];
        if (c.camperId != null && a.camperId !== c.camperId) { a.camperId = c.camperId; changed = true; }
        if (a.closed) { delete a.closed; delete a.closedAt; changed = true; }
    });
    // Campers no longer on the roster. This used to `delete` the account
    // outright — WITH WHATEVER MONEY WAS ON IT. The transactions stayed, so
    // canteen revenue still counted a parent's deposit while the balance owed
    // back to them simply stopped existing, and nothing flagged it
    // (TEST_FINDINGS.md D3).
    //
    // An account holding money, or a saved auto-reload card, is now CLOSED and
    // kept: the balance is the parent's money and the camp either refunds it or
    // applies it, but it may not evaporate because a roster changed. Only a
    // genuinely empty account is dropped, which is what keeps the account list
    // from filling with noise.
    const rosterNames = new Set(camperList.map(c => c.name));
    let _closedWithMoney = 0;
    Object.keys(snacks.accounts).forEach(name => {
        if (rosterNames.has(name)) return;
        const a = snacks.accounts[name] || {};
        const bal = Math.round((Number(a.balance) || 0) * 100) / 100;
        const hasCard = !!(a.autoReload && (a.autoReload.cardOnFile ||
            a.autoReload.byopCustomerRef || a.autoReload.stripeCustomerId));
        if (Math.abs(bal) < 0.005 && !hasCard) { delete snacks.accounts[name]; changed = true; return; }
        if (!a.closed) {
            a.closed = true;
            a.closedAt = new Date().toISOString();
            changed = true;
        }
        if (Math.abs(bal) >= 0.005) _closedWithMoney++;
    });
    if (_closedWithMoney) {
        console.warn('[Snacks] ' + _closedWithMoney + ' closed canteen account' +
            (_closedWithMoney === 1 ? '' : 's') + ' still hold money — refund or apply it; ' +
            'they are kept rather than deleted so it cannot vanish');
    }
    // Guarded by _hydratedOnce — see its declaration for why: saving here
    // before real cloud data has loaded once can wholesale-overwrite fresh
    // inventory counters another device just wrote.
    if (changed && _hydratedOnce) saveSnacksData(snacks);
}

function getAccount(name) {
    const a = snacks.accounts[name] || { balance: 0, dailyLimit: getSettings().defaultDailyLimit, spentToday: 0 };
    // ★ A ROW-BACKED ACCOUNT CAN BE MISSING FIELDS, and the default above only
    //   applies when the whole account is missing.
    //
    //   218's _canteen_account_json omits dailyLimit, creditLimit and balanceFloor
    //   when the column is NULL — deliberately, because NULL means "not set". And
    //   the row writers create an account with payload '{}' and every numeric
    //   column NULL: canteen_account_lock inserts it that way, so the first parent
    //   deposit, POS sale or shop settlement for a camper produces exactly that
    //   shape. rAccounts then reached a.dailyLimit.toFixed(2), threw, and the whole
    //   Accounts table came out EMPTY — no error on screen, just no campers.
    //
    //   Filled here rather than at each of the dozen read sites, and with the same
    //   defaults the missing-account branch uses so the two agree.
    if (a.balance == null) a.balance = 0;
    if (a.dailyLimit == null) a.dailyLimit = getSettings().defaultDailyLimit;
    if (a.spentToday == null) a.spentToday = 0;
    // Daily spend resets at midnight
    const t = new Date();
    const today = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    if (a.lastSpendDate !== today) { a.spentToday = 0; a.lastSpendDate = today; }
    return a;
}

// ==========================================================================
// SETTINGS
// ==========================================================================

function getSettings() {
    const s = (snacks && snacks.settings) || {};
    const out = Object.assign({}, DEFAULT_SNACKS_SETTINGS, s);
    // A stored list could name a method we've since retired — or `debit`, if an
    // older build ever wrote one. Filter against the live catalogue.
    const valid = PAY_METHODS.map(m => m.id);
    out.payMethods = (Array.isArray(out.payMethods) ? out.payMethods : []).filter(id => valid.includes(id));
    if (!out.payMethods.length) out.payMethods = ['cash', 'credit'];
    return out;
}

function payMethodLabel(id) {
    const m = PAY_METHODS.find(x => x.id === id);
    return m ? m.label : (id || '—');
}

// The cash-out arithmetic lives in campistry_snacks_cash.js (pure + unit
// tested). These are thin adapters that feed it this page's state.

/** Cash paid out across the whole camp on a given date (defaults to today). */
function cashOutTotal(date) {
    return window.SnacksCash.paidOutOn(snacks.transactions, date || todayStr());
}

/** How much cash this camper may take out right now, and why not more. */
function cashOutLimit(name) {
    const cfg = getSettings();
    const lim = window.SnacksCash.limit({
        account: getAccount(name), transactions: snacks.transactions,
        camper: name, date: todayStr(), settings: cfg
    });
    lim.cfg = cfg;
    return lim;
}

// ==========================================================================
// INIT
// ==========================================================================

function init() {
    ensureAccountsForRoster();
    if (!snacks.inventory) snacks.inventory = [];
    if (!snacks.transactions) snacks.transactions = [];
    if (!snacks.hourlyActivity) snacks.hourlyActivity = {};
    if (!snacks.weeklyRevenue) snacks.weeklyRevenue = [];
    if (!snacks.settings) snacks.settings = Object.assign({}, DEFAULT_SNACKS_SETTINGS);

    renderStats();
    rAccounts();
    rInventory();
    rAnalytics();
    rSettings();
    initTabs();
    popSelects();
    console.log('[Snacks Manager] Ready —', camperList.length, 'campers,', snacks.inventory.length, 'items');
}

function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        document.getElementById('tab-' + b.dataset.tab).classList.add('active');
    }));
}

// ==========================================================================
// STATS
// ==========================================================================

function renderStats() {
    document.getElementById('sA').textContent = camperList.length;
    const totalBal = Object.values(snacks.accounts).reduce((s, a) => s + (a.balance || 0), 0);
    document.getElementById('sB').textContent = '$' + totalBal.toFixed(0);
    document.getElementById('sI').textContent = snacks.inventory.filter(i => i.stock > 0).length;
    // Sales = purchases only. A cash withdrawal moves money out of the account
    // without selling anything, and a deposit refund reverses money that was
    // never a sale in the first place — neither should count as revenue.
    const salesToday = (snacks.transactions || [])
        .filter(t => t.date === todayStr() && t.type !== 'credit' && t.kind !== 'cash_out' && t.kind !== 'refund')
        .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    document.getElementById('sS').textContent = '$' + salesToday.toFixed(0);
    const cashEl = document.getElementById('sC');
    if (cashEl) cashEl.textContent = '$' + cashOutTotal().toFixed(0);
}

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ==========================================================================
// ACCOUNTS TAB
// ==========================================================================

window.rAccounts = function(filter) {
    const q = filter || (document.getElementById('aSearch')?.value || '');
    const items = camperList.filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
    document.getElementById('aBody').innerHTML = items.map(c => {
        const a = getAccount(c.name);
        const rem = a.dailyLimit - a.spentToday;
        let st;
        if (a.balance <= 0) st = '<span class="badge badge-red">No Funds</span>';
        else if (a.dailyLimit > 0 && rem <= 0) st = '<span class="badge badge-amber">Limit Hit</span>';
        else st = '<span class="badge badge-green">Active</span>';
        const jsName = esc(c.name).replace(/'/g, '&#39;');
        // Camper name is clickable → opens that camper's full transaction history.
        return '<tr><td style="font-weight:600"><a href="#" class="acct-name-link" onclick="viewAccountHistory(\'' + jsName + '\');return false;">' + esc(c.label || _lbl(c.name)) + '</a></td><td>' + esc(c.division) + '</td><td>' + esc(c.bunk) +
            '</td><td style="font-weight:700;color:' + (a.balance <= 5 ? 'var(--red-600)' : 'var(--text-primary)') + '">$' + a.balance.toFixed(2) +
            '</td><td>$' + a.dailyLimit.toFixed(2) + '</td><td>$' + a.spentToday.toFixed(2) +
            '</td><td>' + st + '</td><td style="white-space:nowrap">' +
            '<button class="btn btn-sm btn-secondary" onclick="viewAccountHistory(\'' + jsName + '\')">History</button> ' +
            '<button class="btn btn-sm btn-primary" onclick="openMFor(\'dep\',\'depCamper\',\'' + jsName + '\')">+ Deposit</button> ' +
            '<button class="btn btn-sm btn-secondary" onclick="openMFor(\'cash\',\'cashCamper\',\'' + jsName + '\')">Cash Out</button> ' +
            '<button class="btn btn-sm btn-secondary" onclick="openMFor(\'refund\',\'refundCamper\',\'' + jsName + '\')">Refund</button>' +
            '</td></tr>';
    }).join('');
};

// Full transaction history for one camper — every deposit, auto-reload,
// purchase, cash-out and refund on their canteen account, newest first, with
// an In/Out filter. Opened by clicking a camper's name (or History) in Accounts.
var _histCamper = null;
var _histFilter = 'all'; // 'all' | 'in' | 'out'

// Reliable time order even for older rows that predate the `timestamp` field:
// fall back to parsing the stored date + time.
function _histSortKey(t) {
    if (t && t.timestamp) { const n = Number(t.timestamp); if (!isNaN(n)) return n; }
    const dt = new Date(((t && t.date) || '') + ' ' + ((t && t.time) || ''));
    const n = dt.getTime();
    return isNaN(n) ? 0 : n;
}

window.viewAccountHistory = function(name) {
    _histCamper = name;
    _histFilter = 'all';
    const a = getAccount(name);
    const titleEl = document.getElementById('histTitle');
    if (titleEl) titleEl.textContent = name + ' — History';
    const balEl = document.getElementById('histBalance');
    if (balEl) balEl.textContent = '$' + (a.balance || 0).toFixed(2);
    _renderHistoryFilter();
    _renderHistoryBody();
    openM('history');
};

window.setHistoryFilter = function(f) {
    _histFilter = f;
    _renderHistoryFilter();
    _renderHistoryBody();
};

function _renderHistoryFilter() {
    const el = document.getElementById('histFilter');
    if (!el) return;
    const tabs = [['all', 'All'], ['in', 'Money In'], ['out', 'Money Out']];
    el.innerHTML = tabs.map(([k, lbl]) =>
        '<button class="hist-filter-btn' + (_histFilter === k ? ' active' : '') + '" onclick="setHistoryFilter(\'' + k + '\')">' + lbl + '</button>'
    ).join('');
}

function _renderHistoryBody() {
    const body = document.getElementById('histBody');
    if (!body) return;
    let txs = (snacks.transactions || []).filter(t => t && t.camper === _histCamper);
    if (_histFilter === 'in') txs = txs.filter(t => t.type === 'credit');
    else if (_histFilter === 'out') txs = txs.filter(t => t.type !== 'credit');
    txs = txs.slice().sort((x, y) => _histSortKey(y) - _histSortKey(x)); // newest first
    if (!txs.length) {
        body.innerHTML = '<div style="text-align:center;padding:2.5rem 1rem;color:var(--text-muted);font-size:.85rem">No ' +
            (_histFilter === 'in' ? 'incoming funds' : _histFilter === 'out' ? 'spending' : 'transactions') +
            (snacks.ledgerCompactedThrough ? ' in the live list.' : ' yet.') + '</div>' + _archivedHistoryHtml();
        return;
    }
    // The live rows, then — once the ledger has been compacted — a way to pull
    // the older ones from the archive without ever writing them back.
    body.innerHTML = txs.map(_histRowHtml).join('') + _archivedHistoryHtml();
}

function _histRowHtml(t) {
    const credit = t.type === 'credit';
    const auto = credit && (t.kind === 'autoreload' || /auto[- ]?(reload|pay)/i.test(t.items || ''));
    const isRefund = t.kind === 'refund';
    const isCashOut = t.kind === 'cash_out';
    let label = t.items || (credit ? 'Deposit' : 'Purchase');
    if (auto) label = 'Auto-reload top-up';
    else if (isRefund) label = 'Refund';
    else if (isCashOut) label = 'Cash out';
    const tag = auto ? '<span class="hist-tag">Auto-Pay</span>' : '';
    const when = (t.date || '') + (t.time ? ' · ' + t.time : '');
    const amt = Number(t.amount) || 0;
    const amtHtml = credit
        ? '<span style="color:var(--green-600);font-weight:700">+$' + amt.toFixed(2) + '</span>'
        : '<span style="color:var(--red-600);font-weight:700">−$' + amt.toFixed(2) + '</span>';
    return '<div class="hist-row"><div class="hist-main"><div class="hist-label">' + esc(label) + tag +
        '</div><div class="hist-when">' + esc(when) + '</div></div><div class="hist-amt">' + amtHtml + '</div></div>';
}

/** Open a modal with its camper select pre-filled (and its dependent UI refreshed). */
window.openMFor = function(modal, selectId, name) {
    openM(modal);
    const el = document.getElementById(selectId);
    if (el) el.value = name;
    if (modal === 'cash') cashPickCamper();
    if (modal === 'refund') refundPickCamper();
};

// ==========================================================================
// INVENTORY TAB
// ==========================================================================

function rInventory() {
    const I = snacks.inventory;
    document.getElementById('iCount').textContent = I.length + ' items';
    document.getElementById('iBody').innerHTML = I.map(i => {
        // stock == null means "not tracked" — always sellable, no count to
        // read as low/out. Only a real number gets the Out/Low/OK badge.
        const tracked = i.stock != null;
        let st;
        if (!tracked) st = '<span class="badge badge-neutral">Untracked</span>';
        else if (i.stock === 0) st = '<span class="badge badge-red">Out</span>';
        else if (i.stock <= 10) st = '<span class="badge badge-amber">Low</span>';
        else st = '<span class="badge badge-green">OK</span>';
        const hasCost = i.cost != null && !isNaN(i.cost);
        const marginCell = hasCost
            ? '$' + (i.price - i.cost).toFixed(2) + ' <span style="color:var(--text-muted)">(' + Math.round((i.price - i.cost) / i.price * 100) + '%)</span>'
            : '<span style="color:var(--text-muted)" title="Set a cost to see margin">—</span>';
        return '<tr><td style="font-weight:600">' + esc(i.name) +
            '</td><td><span class="badge badge-neutral">' + esc(i.cat) + '</span></td><td style="font-weight:600">$' + i.price.toFixed(2) +
            '</td><td>' + marginCell +
            '</td><td style="font-weight:600;color:' + (!tracked ? 'var(--text-muted)' : i.stock === 0 ? 'var(--red-600)' : i.stock <= 10 ? 'var(--amber-600)' : 'var(--text-primary)') +
            '">' + (tracked ? i.stock : '—') + '</td><td>' + (i.soldToday || 0) + '</td><td>' + (i.totalSold || 0) + '</td><td>' + st +
            '</td><td><button class="btn btn-sm btn-secondary" onclick="openEditItem(' + i.id + ')">Edit</button></td></tr>';
    }).join('');
}

// ==========================================================================
// ANALYTICS TAB
// ==========================================================================

function rAnalytics() {
    const todayTx = (snacks.transactions || []).filter(t => t.date === todayStr());
    // Revenue and the "avg transaction" metric are about SALES. Deposits
    // (credits), cash withdrawals, and deposit refunds all move money but
    // sell nothing — a refund is a debit (money leaving the camp's ledger
    // back to the parent, same sign as a purchase) but it's the opposite of
    // a sale, so it has to be excluded here just like credits/cash-outs are.
    const saleTx = todayTx.filter(t => t.type !== 'credit' && t.kind !== 'cash_out' && t.kind !== 'refund');
    const sal = saleTx.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const tc = saleTx.length;
    const I = snacks.inventory;
    const units = I.reduce((s, i) => s + (i.soldToday || 0), 0);
    // Untracked items (stock == null) don't count toward either side of
    // sell-through — there's no capacity number to measure against.
    const openStock = I.reduce((s, i) => s + (i.stock != null ? i.stock + (i.soldToday || 0) : 0), 0);

    document.getElementById('mRev').textContent = '$' + sal.toFixed(2);
    document.getElementById('mTxn').textContent = tc + ' txns';
    document.getElementById('mAvg').textContent = tc ? '$' + (sal / tc).toFixed(2) : '$0';
    document.getElementById('mUnits').textContent = units;
    document.getElementById('mLow').textContent = I.filter(i => i.stock != null && i.stock <= 10).length;
    document.getElementById('mST').textContent = (openStock ? Math.round(units / openStock * 100) : 0) + '%';

    // Margin/profit — aggregate from item.cost × totalSold (all-time), not
    // per-sale history (transactions don't carry line items). Items with no
    // cost set are excluded entirely (not treated as $0 cost, which would
    // wildly overstate margin) rather than skewing the average.
    const priced = I.filter(i => i.cost != null && !isNaN(i.cost) && i.price > 0);
    const totalProfit = priced.reduce((s, i) => s + (i.totalSold || 0) * (i.price - i.cost), 0);
    const pricedRevenue = priced.reduce((s, i) => s + (i.totalSold || 0) * i.price, 0);
    const avgMargin = pricedRevenue > 0 ? (totalProfit / pricedRevenue * 100) : 0;
    document.getElementById('mProfit').textContent = '$' + totalProfit.toFixed(2);
    document.getElementById('mProfitN').textContent = priced.length + ' of ' + I.length + ' item' + (I.length === 1 ? '' : 's') + ' priced';
    document.getElementById('mMargin').textContent = priced.length ? Math.round(avgMargin) + '%' : '—';

    const top = [...I].sort((a, b) => (b.soldToday || 0) - (a.soldToday || 0))[0];
    document.getElementById('mTop').textContent = top ? top.name : '—';
    document.getElementById('mTopN').textContent = top ? (top.soldToday || 0) + ' today · ' + (top.totalSold || 0) + ' all-time' : '';

    // Popularity
    const ranked = [...I].sort((a, b) => (b.totalSold || 0) - (a.totalSold || 0));
    const maxT = ranked[0]?.totalSold || 1;
    document.getElementById('popList').innerHTML = ranked.length ? ranked.map((i, x) =>
        '<div class="rank-item"><div class="rank-pos">' + (x + 1) +
        '</div><div class="rank-info"><div class="rank-name">' + esc(i.name) +
        '</div><div class="rank-bar-track"><div class="rank-bar-fill" style="width:' + Math.round((i.totalSold || 0) / maxT * 100) +
        '%"></div></div></div><div style="text-align:right"><div class="rank-count">' + (i.totalSold || 0) +
        '</div><div class="rank-revenue">$' + ((i.totalSold || 0) * i.price).toFixed(0) + '</div></div></div>'
    ).join('') : '<div style="text-align:center;padding:2rem;color:var(--text-muted)">Add inventory items to see popularity data</div>';

    // Category breakdown
    const cats = {};
    I.forEach(i => { if (!cats[i.cat]) cats[i.cat] = { u: 0, r: 0 }; cats[i.cat].u += (i.soldToday || 0); cats[i.cat].r += (i.soldToday || 0) * i.price; });
    const cc = { drink: 'var(--blue-500)', snack: 'var(--amber-500)', treat: 'var(--purple-500)' };
    const tr = Object.values(cats).reduce((s, c) => s + c.r, 0) || 1;
    const catHTML = Object.entries(cats).sort((a, b) => b[1].r - a[1].r).map(([k, d]) =>
        '<div class="cat-row"><div class="cat-dot" style="background:' + (cc[k] || 'gray') + '"></div><div class="cat-name">' +
        k.charAt(0).toUpperCase() + k.slice(1) + 's</div><div class="cat-value">$' + d.r.toFixed(2) +
        '</div><div class="cat-pct">' + Math.round(d.r / tr * 100) + '%</div></div>'
    ).join('');
    const barHTML = '<div style="display:flex;gap:3px;margin-top:1rem;height:8px;border-radius:4px;overflow:hidden">' +
        Object.entries(cats).sort((a, b) => b[1].r - a[1].r).map(([k, d]) =>
            '<div style="flex:' + Math.max(Math.round(d.r / tr * 100), 1) + ';background:' + (cc[k] || 'gray') + '"></div>'
        ).join('') + '</div>';
    document.getElementById('catBrk').innerHTML = catHTML ? catHTML + barHTML : '<div style="text-align:center;padding:2rem;color:var(--text-muted)">No sales data yet</div>';

    // Best Margin (by margin %) / Most Profitable (by total profit $) — both
    // restricted to items with a cost set (see `priced` above).
    const noCostMsg = '<div style="text-align:center;padding:2rem;color:var(--text-muted)">Set a cost on your items (Edit Item or Restock) to see margin data</div>';
    const byMargin = [...priced].sort((a, b) => ((b.price - b.cost) / b.price) - ((a.price - a.cost) / a.price));
    document.getElementById('marginList').innerHTML = byMargin.length ? byMargin.map((i, x) => {
        const pct = Math.round((i.price - i.cost) / i.price * 100);
        return '<div class="rank-item"><div class="rank-pos">' + (x + 1) +
            '</div><div class="rank-info"><div class="rank-name">' + esc(i.name) +
            '</div><div class="rank-bar-track"><div class="rank-bar-fill" style="width:' + Math.max(pct, 0) +
            '%"></div></div></div><div style="text-align:right"><div class="rank-count">' + pct + '%' +
            '</div><div class="rank-revenue">$' + (i.price - i.cost).toFixed(2) + '/unit</div></div></div>';
    }).join('') : noCostMsg;

    const byProfit = [...priced].sort((a, b) => (b.totalSold || 0) * (b.price - b.cost) - (a.totalSold || 0) * (a.price - a.cost));
    const maxProfit = byProfit.length ? Math.max((byProfit[0].totalSold || 0) * (byProfit[0].price - byProfit[0].cost), 1) : 1;
    document.getElementById('profitList').innerHTML = byProfit.length ? byProfit.map((i, x) => {
        const p = (i.totalSold || 0) * (i.price - i.cost);
        return '<div class="rank-item"><div class="rank-pos">' + (x + 1) +
            '</div><div class="rank-info"><div class="rank-name">' + esc(i.name) +
            '</div><div class="rank-bar-track"><div class="rank-bar-fill" style="width:' + Math.max(Math.round(p / maxProfit * 100), 0) +
            '%"></div></div></div><div style="text-align:right"><div class="rank-count">$' + p.toFixed(0) +
            '</div><div class="rank-revenue">' + (i.totalSold || 0) + ' sold</div></div></div>';
    }).join('') : noCostMsg;

    // Top spenders
    const spenders = camperList.map(c => ({ ...c, spent: getAccount(c.name).spentToday })).filter(c => c.spent > 0).sort((a, b) => b.spent - a.spent);
    document.getElementById('spList').innerHTML = spenders.length ? spenders.map(c =>
        '<div class="spend-row"><div class="spend-avatar">' + c.name.split(' ').map(w => w[0]).join('') +
        '</div><div class="spend-name">' + esc(c.label || _lbl(c.name)) + '<div style="font-size:.7rem;color:var(--text-muted)">' + esc(c.division) +
        '</div></div><div class="spend-amount">$' + c.spent.toFixed(2) + '</div></div>'
    ).join('') : '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.8rem">No purchases yet today</div>';

    // Hourly heatmap
    const HR = snacks.hourlyActivity || {};
    const hrs = Object.keys(HR).map(Number).sort((a, b) => a - b);
    const maxH = Math.max(...Object.values(HR), 1);
    document.getElementById('heatmap').innerHTML = hrs.length ?
        '<div style="font-size:.75rem;color:var(--text-muted);margin-bottom:.5rem">Darker = busier</div><div style="display:flex;gap:3px;flex-wrap:wrap">' +
        hrs.map(h => {
            const v = HR[h] || 0, p = v / maxH;
            const bg = p > .7 ? 'var(--snacks)' : p > .4 ? 'var(--snacks-100)' : p > 0 ? 'var(--green-50)' : 'var(--bg-tertiary)';
            const clr = p > .7 ? 'white' : 'var(--text-muted)';
            return '<div style="text-align:center"><div class="heat-cell" style="background:' + bg + ';color:' + clr + '">' + v + '</div><div class="heat-label">' + (h > 12 ? h - 12 + 'p' : h + 'a') + '</div></div>';
        }).join('') + '</div>' :
        '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.8rem">Process sales to see hourly patterns</div>';

    // Weekly chart — computed live from the transaction ledger. snacks.weeklyRevenue
    // was never actually written by anything (POS/RPC only ever touch accounts/
    // transactions/inventory), so it stayed permanently empty; derive it the same
    // way saleTx/salesToday already derive today's numbers instead.
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const WK = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const amt = (snacks.transactions || [])
            .filter(t => t.date === key && t.type !== 'credit' && t.kind !== 'cash_out' && t.kind !== 'refund')
            .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
        WK.push({ day: DOW[d.getDay()], amount: Math.round(amt * 100) / 100 });
    }
    if (WK.some(d => d.amount > 0)) {
        const mx = Math.max(...WK.map(d => d.amount), 1);
        document.getElementById('wChart').innerHTML = WK.map(d =>
            '<div class="bar-col"><div class="bar-value">$' + d.amount + '</div><div class="bar" style="height:' +
            Math.max(d.amount / mx * 100, 2) + '%;background:var(--snacks)"></div><div class="bar-label">' + d.day + '</div></div>'
        ).join('');
    } else {
        document.getElementById('wChart').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)">Weekly data will appear after the first sales</div>';
    }

    // Transactions
    document.getElementById('txC').textContent = todayTx.length;
    document.getElementById('txBody').innerHTML = todayTx.length ? todayTx.slice(0, 25).map(t => {
        const amt = Math.abs(parseFloat(t.amount) || 0);
        const credit = t.type === 'credit';
        const cashOut = t.kind === 'cash_out';
        const refund = t.kind === 'refund';
        const kind = refund  ? '<span class="badge badge-amber">Refund</span>'
                   : cashOut ? '<span class="badge badge-amber">Cash out</span>'
                   : credit  ? '<span class="badge badge-green">Deposit</span>'
                             : '<span class="badge badge-neutral">Purchase</span>';
        const color = credit ? 'var(--green-600)' : (cashOut || refund) ? 'var(--amber-600)' : 'var(--text-primary)';
        return '<tr><td style="white-space:nowrap">' + esc(t.time || '') + '</td><td style="font-weight:600">' + esc(t.camper || '') +
            '</td><td>' + esc(t.items || '') + '</td><td>' + kind +
            '</td><td style="font-weight:700;color:' + color + '">' + (credit ? '+' : '−') + '$' + amt.toFixed(2) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">No transactions today</td></tr>';
}

// ==========================================================================
// SETTINGS TAB
// ==========================================================================

function rSettings() {
    const cfg = getSettings();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set('setDefaultLimit', cfg.defaultDailyLimit);
    set('setCashDailyMax', cfg.cashDailyMax);
    set('setCashReasonRequired', cfg.cashReasonRequired ? 'yes' : 'no');
    set('setCashAllowNegative', cfg.cashAllowNegative ? 'yes' : 'no');

    const box = document.getElementById('setPayMethods');
    if (box) {
        box.innerHTML = PAY_METHODS.map(m =>
            '<label class="pay-row"><input type="checkbox" data-pay="' + m.id + '"' +
            (cfg.payMethods.includes(m.id) ? ' checked' : '') + '><span>' + esc(m.label) + '</span></label>'
        ).join('') + BLOCKED_PAY_METHODS.map(m =>
            '<label class="pay-row blocked" title="' + esc(m.reason) + '"><input type="checkbox" disabled>' +
            '<span style="text-decoration:line-through">' + esc(m.label) + '</span>' +
            '<span class="pay-row-note">' + esc(m.reason) + '</span></label>'
        ).join('');
    }

    const drawer = document.getElementById('cashDrawerBox');
    if (drawer) {
        const today = todayStr();
        const outs = (snacks.transactions || []).filter(t => t.kind === 'cash_out' && t.date === today);
        const cashIn = (snacks.transactions || [])
            .filter(t => t.type === 'credit' && t.method === 'cash' && t.date === today)
            .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
        const cashOut = outs.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
        drawer.innerHTML =
            '<div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:.85rem">' +
                '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Cash deposits in</div>' +
                    '<div style="font-size:1.15rem;font-weight:700;color:var(--green-600)">+$' + cashIn.toFixed(2) + '</div></div>' +
                '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Cash paid out</div>' +
                    '<div style="font-size:1.15rem;font-weight:700;color:var(--amber-600)">−$' + cashOut.toFixed(2) + '</div></div>' +
                '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Net in drawer</div>' +
                    '<div style="font-size:1.15rem;font-weight:700">$' + (cashIn - cashOut).toFixed(2) + '</div></div>' +
            '</div>' +
            (outs.length
                ? '<div class="table-wrapper"><table class="data-table"><thead><tr><th>Time</th><th>Camper</th><th>Reason</th><th>By</th><th>Amount</th></tr></thead><tbody>' +
                  outs.map(t => '<tr><td style="white-space:nowrap">' + esc(t.time || '') + '</td><td style="font-weight:600">' + esc(t.camper || '') +
                      '</td><td>' + esc(t.note || '—') + '</td><td>' + esc(t.by || '—') +
                      '</td><td style="font-weight:700;color:var(--amber-600)">$' + Math.abs(parseFloat(t.amount) || 0).toFixed(2) + '</td></tr>').join('') +
                  '</tbody></table></div>'
                : '<div style="font-size:.82rem;color:var(--text-muted)">No cash paid out today.</div>');
    }

    loadPosPinStatus();
    _renderCompactionCard();
}

window.saveSettingsForm = function() {
    if (!_secEdit('settings', 'Saving settings')) return;
    const num = (id, dflt) => {
        const e = document.getElementById(id);
        const v = e ? parseFloat(e.value) : NaN;
        return isFinite(v) && v >= 0 ? v : dflt;
    };
    const picked = Array.from(document.querySelectorAll('#setPayMethods input[data-pay]'))
        .filter(cb => cb.checked).map(cb => cb.dataset.pay);
    if (!picked.length) { toast('Keep at least one payment method', 1); return; }
    snacks.settings = Object.assign({}, getSettings(), {
        payMethods: picked,
        defaultDailyLimit: num('setDefaultLimit', DEFAULT_SNACKS_SETTINGS.defaultDailyLimit),
        cashDailyMax: num('setCashDailyMax', DEFAULT_SNACKS_SETTINGS.cashDailyMax),
        cashReasonRequired: (document.getElementById('setCashReasonRequired') || {}).value !== 'no',
        cashAllowNegative: (document.getElementById('setCashAllowNegative') || {}).value === 'yes'
    });
    saveSnacksData(snacks);
    rSettings(); popSelects();
    toast('Settings saved');
};

// ── Register PIN login (snacks.campistry.org) ──────────────────────────────
// Gives the canteen runner a login that's genuinely separate from the
// owner's real Campistry account — a shared PIN, scoped only to the
// register — instead of handing out the office's own password. There's no
// link to share anymore: any device can go straight to
// snacks.campistry.org and type the PIN cold — the server figures out
// which camp it belongs to (see migration 102), which is also why the PIN
// has to be unique across every camp, not just this one. The PIN itself is
// verified server-side by the pos-pin-login edge function; this UI only
// ever sets it (set_camp_pos_pin RPC) and reads whether one's set
// (get_camp_pos_login_status RPC). Neither RPC ever returns the PIN itself.
function loadPosPinStatus() {
    const box = document.getElementById('posPinStatus');
    const unlockBtn = document.getElementById('posPinUnlockBtn');
    if (!box) return;
    const db = window.CampistryDB;
    const client = db && db.getClient && db.getClient();
    const campId = db && db.getCampId && db.getCampId();
    if (!client || !campId) { box.textContent = ''; return; }
    client.rpc('get_camp_pos_login_status', { p_camp_id: campId }).then(res => {
        const data = res && res.data;
        if (res.error || !data || !data.success) {
            console.error('[Snacks Settings] get_camp_pos_login_status failed:', res.error, data);
            box.innerHTML = '<span style="color:var(--red-600)">Could not check the register login status — see console.</span>';
            if (unlockBtn) unlockBtn.style.display = 'none';
            return;
        }
        if (data.locked) {
            box.innerHTML = '<span style="color:var(--red-600);font-weight:600">🔒 Register locked</span> — 5 wrong PIN attempts in a row. It stays locked until you unlock it below.';
            if (unlockBtn) unlockBtn.style.display = '';
        } else {
            box.innerHTML = data.pinSet
                ? '<span style="color:var(--green-600);font-weight:600">✓ A register PIN is set.</span> Saving a new one below replaces it.'
                : '<span style="color:var(--amber-600);font-weight:600">No PIN set yet</span> — the register login is inactive until you set one.';
            if (unlockBtn) unlockBtn.style.display = 'none';
        }
    }).catch(e => {
        console.error('[Snacks Settings] get_camp_pos_login_status threw:', e);
        box.innerHTML = '<span style="color:var(--red-600)">Could not check the register login status — see console.</span>';
        if (unlockBtn) unlockBtn.style.display = 'none';
    });
}

window.unlockPosPin = function() {
    if (!_secEdit('settings', 'Unlocking the register')) return;
    const db = window.CampistryDB;
    const client = db && db.getClient && db.getClient();
    const campId = db && db.getCampId && db.getCampId();
    if (!client || !campId) { toast('Not signed in', 1); return; }
    const btn = document.getElementById('posPinUnlockBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Unlocking…'; }
    client.rpc('unlock_camp_pos_pin', { p_camp_id: campId }).then(res => {
        if (btn) { btn.disabled = false; btn.textContent = 'Unlock Register'; }
        const data = res && res.data;
        if (res.error || !data || !data.success) {
            console.error('[Snacks Settings] unlock_camp_pos_pin failed:', res.error, data);
            toast('Could not unlock the register', 1);
            return;
        }
        toast('Register unlocked');
        loadPosPinStatus();
    }, (e) => {
        if (btn) { btn.disabled = false; btn.textContent = 'Unlock Register'; }
        console.error('[Snacks Settings] unlock_camp_pos_pin threw:', e);
        toast('Could not unlock the register', 1);
    });
};

window.savePosPin = function() {
    if (!_secEdit('settings', 'Setting the register PIN')) return;
    const db = window.CampistryDB;
    const client = db && db.getClient && db.getClient();
    const campId = db && db.getCampId && db.getCampId();
    if (!client || !campId) { toast('Not signed in', 1); return; }
    const input = document.getElementById('posPinInput');
    const pin = ((input && input.value) || '').trim();
    if (!/^[0-9]{4,8}$/.test(pin)) { toast('PIN must be 4–8 digits', 1); return; }
    const btn = document.getElementById('posPinSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    client.rpc('set_camp_pos_pin', { p_camp_id: campId, p_pin: pin }).then(res => {
        if (btn) { btn.disabled = false; btn.textContent = 'Save PIN'; }
        const data = res && res.data;
        if (res.error || !data || !data.success) {
            console.error('[Snacks Settings] set_camp_pos_pin failed:', res.error, data);
            const reason = (data && data.error) || (res.error && res.error.message) || 'unknown_error';
            const msgs = {
                invalid_pin: 'PIN must be 4–8 digits',
                not_authorized: 'Only the camp owner or an admin can set the register PIN',
                not_authenticated: 'Not signed in — try reloading the page'
            };
            toast(msgs[reason] || ('Could not save the PIN (' + reason + ')'), 1);
            return;
        }
        if (input) input.value = '';
        toast('Register PIN saved');
        loadPosPinStatus();
    }, (e) => {
        if (btn) { btn.disabled = false; btn.textContent = 'Save PIN'; }
        console.error('[Snacks Settings] set_camp_pos_pin threw:', e);
        toast('Could not save the PIN (' + ((e && e.message) || 'network error') + ')', 1);
    });
};

// ==========================================================================
// OFFLINE POS — download the self-contained register with data baked in,
// export data for an existing offline register, and import transactions
// that were recorded offline back into the main ledger.
// ==========================================================================

function buildOfflineExportData() {
    var data = loadSnacksData();
    var roster = getRoster();
    var exportAccounts = {};
    Object.keys(data.accounts || {}).forEach(function(name) {
        var a = data.accounts[name];
        var camper = roster[name] || {};
        exportAccounts[name] = {
            balance: a.balance || 0,
            dailyLimit: a.dailyLimit || 10,
            spentToday: a.spentToday || 0,
            lastSpendDate: a.lastSpendDate || '',
            balanceFloor: a.balanceFloor || 0,
            creditLimit: a.creditLimit || 0,
            division: camper.division || '',
            bunk: camper.bunk || ''
        };
    });
    Object.keys(roster).forEach(function(name) {
        // No wallet for a camper who has not arrived. Opening one in June for
        // a second-half camper puts an empty account with a spending limit on
        // the till weeks before there is anybody to spend it.
        if (_snacksPresenceGate() && !window.CampistryPresence.isHere(name)) return;
        if (!exportAccounts[name]) {
            var c = roster[name];
            exportAccounts[name] = {
                balance: 0, dailyLimit: 10, spentToday: 0, lastSpendDate: '',
                balanceFloor: 0, creditLimit: 0,
                division: c.division || '', bunk: c.bunk || ''
            };
        }
    });

    var campName = '';
    try {
        var gs = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
        campName = (gs.campistryMe && gs.campistryMe.campName) || '';
    } catch (_) {}

    return {
        exportedAt: new Date().toISOString(),
        accounts: exportAccounts,
        inventory: (data.inventory || []).map(function(item) {
            return {
                id: item.id, name: item.name, cat: item.cat || '',
                price: item.price || 0, cost: item.cost || null,
                stock: item.stock, soldToday: item.soldToday || 0,
                totalSold: item.totalSold || 0, barcode: item.barcode || ''
            };
        }),
        settings: {
            campName: campName,
            defaultDailyLimit: ((data.settings || {}).defaultDailyLimit) || 10
        }
    };
}

window.downloadOfflinePOS = async function() {
    var statusEl = document.getElementById('offlinePosStatus');
    if (statusEl) statusEl.textContent = 'Preparing download...';

    try {
        var resp = await fetch('campistry_snacks_pos_offline.html');
        if (!resp.ok) throw new Error('Could not load offline POS template');
        var html = resp.text ? await resp.text() : '';

        var exportData = buildOfflineExportData();
        var preloadScript = '<script>window.__OFFLINE_POS_PRELOAD__ = ' +
            JSON.stringify(exportData) + ';<\/script>';
        html = html.replace('<!-- __PRELOAD_SLOT__ -->', preloadScript);

        var blob = new Blob([html], { type: 'text/html' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'Campistry_Offline_POS.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        var acctCount = Object.keys(exportData.accounts).length;
        var itemCount = exportData.inventory.length;
        if (statusEl) statusEl.textContent = 'Downloaded with ' + acctCount + ' accounts, ' + itemCount + ' items baked in';
        toast('Offline POS downloaded');
    } catch (err) {
        if (statusEl) statusEl.textContent = 'Download failed: ' + (err.message || err);
        toast('Download failed', true);
    }
};

window.exportForOfflinePOS = function() {
    var data = loadSnacksData();
    var roster = getRoster();
    var exportAccounts = {};
    Object.keys(data.accounts || {}).forEach(function(name) {
        var a = data.accounts[name];
        var camper = roster[name] || {};
        exportAccounts[name] = {
            balance: a.balance || 0,
            dailyLimit: a.dailyLimit || 10,
            spentToday: a.spentToday || 0,
            lastSpendDate: a.lastSpendDate || '',
            balanceFloor: a.balanceFloor || 0,
            creditLimit: a.creditLimit || 0,
            division: camper.division || '',
            bunk: camper.bunk || ''
        };
    });
    // Also include roster campers who don't have an account yet
    Object.keys(roster).forEach(function(name) {
        // No wallet for a camper who has not arrived. Opening one in June for
        // a second-half camper puts an empty account with a spending limit on
        // the till weeks before there is anybody to spend it.
        if (_snacksPresenceGate() && !window.CampistryPresence.isHere(name)) return;
        if (!exportAccounts[name]) {
            var c = roster[name];
            exportAccounts[name] = {
                balance: 0, dailyLimit: 10, spentToday: 0, lastSpendDate: '',
                balanceFloor: 0, creditLimit: 0,
                division: c.division || '', bunk: c.bunk || ''
            };
        }
    });

    var exportData = {
        exportedAt: new Date().toISOString(),
        accounts: exportAccounts,
        inventory: (data.inventory || []).map(function(item) {
            return {
                id: item.id, name: item.name, cat: item.cat || '',
                price: item.price || 0, cost: item.cost || null,
                stock: item.stock, soldToday: item.soldToday || 0,
                totalSold: item.totalSold || 0, barcode: item.barcode || ''
            };
        }),
        settings: {
            defaultDailyLimit: ((data.settings || {}).defaultDailyLimit) || 10
        }
    };

    var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'campistry-offline-pos-data-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    var el = document.getElementById('offlinePosStatus');
    if (el) el.textContent = 'Exported ' + Object.keys(exportAccounts).length + ' accounts, ' + (data.inventory || []).length + ' items at ' + new Date().toLocaleTimeString();
    toast('Offline POS data exported');
};

window.importOfflinePOSTransactions = function() {
    var inp = document.getElementById('offlineTxImportInput');
    if (!inp) return;
    inp.value = '';
    inp.onclick = null;
    inp.onchange = function() {
        var file = inp.files && inp.files[0];
        if (!file) return;
        file.text().then(function(text) {
            try {
                var data = JSON.parse(text);
                if (!data.transactions || !Array.isArray(data.transactions)) {
                    toast('No transactions found in file', 1);
                    return;
                }
                var txs = data.transactions;
                var existing = snacks.transactions || [];
                var existingSigs = {};
                existing.forEach(function(t) {
                    existingSigs[[t.date, t.time, t.camper, t.type, t.amount, t.items].join('|')] = 1;
                });
                var added = 0;
                txs.forEach(function(t) {
                    var sig = [t.date, t.time, t.camper, t.type, t.amount, t.items].join('|');
                    if (existingSigs[sig]) return;
                    existing.unshift(t);
                    existingSigs[sig] = 1;
                    added++;
                    // ★ KNOWN GAP, stated rather than hidden: this import is still
                    //   LOCAL ONLY. 219 made the rows the truth and
                    //   _withoutRowBackedBranches strips accounts and transactions
                    //   from every document write, so what this loop computes goes
                    //   no further than this tab — the same defect migration 240
                    //   fixed for the deposit, cash-out and limit writers.
                    //
                    //   It is not fixed the same way because these sales ALREADY
                    //   HAPPENED on a register that was offline: replaying them
                    //   through submit_canteen_purchase would re-apply the daily
                    //   caps and refuse the very rows that need importing. It needs
                    //   a batch importer that posts them as history, with the
                    //   offline register's own signature for idempotency.
                    if (t.camper && t.type === 'debit') {
                        if (!snacks.accounts[t.camper]) snacks.accounts[t.camper] = { balance: 0, dailyLimit: 10, spentToday: 0 };
                        snacks.accounts[t.camper].balance = Math.round((snacks.accounts[t.camper].balance - (parseFloat(t.amount) || 0)) * 100) / 100;
                    }
                });
                snacks.transactions = existing;
                saveSnacksData(snacks);
                var el = document.getElementById('offlinePosStatus');
                if (el) el.textContent = 'Imported ' + added + ' new transactions (' + (txs.length - added) + ' duplicates skipped)';
                toast('Imported ' + added + ' offline transactions');
                init();
            } catch (e) {
                toast('Import failed: ' + (e.message || 'Invalid file'), 1);
            }
        });
    };
    inp.click();
};

// ==========================================================================
// MODALS & ACTIONS
// ==========================================================================

window.openM = function(n) {
    document.getElementById('m-' + n).classList.add('open');
    if (n === 'dep' || n === 'limit' || n === 'cash') popSelects();
    if (n === 'cash') cashPickCamper();
};
window.closeM = function(n) { document.getElementById('m-' + n).classList.remove('open'); };

function popSelects() {
    const opts = '<option value="">— Select —</option>' + camperList.map(c =>
        '<option value="' + esc(c.name) + '">' + esc(c.label || _lbl(c.name)) + ' (' + esc(c.division) + ')</option>'
    ).join('');
    ['depCamper', 'limCamper', 'cashCamper', 'refundCamper'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const keep = el.value;                 // don't lose a selection on re-populate
        el.innerHTML = opts;
        if (keep) el.value = keep;
    });

    const s3 = document.getElementById('rItem');
    if (s3) s3.innerHTML = '<option value="">— Select —</option>' + snacks.inventory.map(i =>
        '<option value="' + i.id + '">' + esc(i.name) + (i.stock == null ? '' : ' (' + i.stock + ' in stock)') + '</option>'
    ).join('');

    // Deposit methods come from Settings — debit is never in this list.
    const pm = document.getElementById('depMethod');
    if (pm) {
        const cfg = getSettings();
        const keep = pm.value;
        pm.innerHTML = cfg.payMethods.map(id =>
            '<option value="' + esc(id) + '">' + esc(payMethodLabel(id)) + '</option>'
        ).join('');
        if (keep && cfg.payMethods.includes(keep)) pm.value = keep;
    }
}

// ══════════════════════════════════════════════════════════════════════════
// THE DESK'S THREE WRITERS — server-side since migration 240.
//
// They used to move a balance in `snacks` and push the document. 219 made the
// ROWS the truth and _withoutRowBackedBranches (above) strips accounts and
// transactions out of every document write, so all three wrote to a copy the
// cloud throws away. The office took $40 in cash, the screen said "Added
// $40.00", and the database never heard about it — and because _reconcileBalances
// rebuilds every balance from the cloud ledger, the next hydration put that
// camper back where they were. The money was gone and the camper was short.
//
// So each one is an RPC now, the balance shown afterwards is the SERVER's answer,
// and a failure says so instead of pretending. There is deliberately no offline
// fallback: a local-only deposit is the exact defect this replaces.
// ══════════════════════════════════════════════════════════════════════════

/** The RPC surface, or null when this tab has no connected camp. */
function _deskRpc() {
    const db = window.CampistryDB;
    const client = db && (db.getClient ? db.getClient() : db.client);
    const campId = db && db.getCampId && db.getCampId();
    if (!client || typeof client.rpc !== 'function' || !campId) return null;
    return { client: client, campId: campId };
}

/** The camper id on an account, so the write lands on a PERSON, not a spelling. */
function _deskCamperId(name) {
    const a = snacks.accounts && snacks.accounts[name];
    return (a && a.camperId != null) ? a.camperId : null;
}

/**
 * What to tell the office when a desk write is refused.
 *
 * Every code here is one the server can return; a code with no phrase would
 * surface as "could not …" with no reason, which is how staff learn to click
 * twice.
 */
const DESK_ERRORS = {
    not_authorized:           'You do not have permission to change canteen accounts.',
    missing_camper:           'Pick a camper first.',
    unknown_camper:           'That camper is not on the roster any more.',
    invalid_amount:           'Enter an amount greater than zero.',
    invalid_limit:            'Enter a limit of zero or more (zero means no daily cap).',
    reason_required:          'A reason is required for cash out.',
    no_available_balance:     'No available balance to take out.',
    daily_cash_limit_reached: 'The daily cash-out limit has already been reached.',
    over_available:           'More than this camper has available to take out.',
};

function _deskMessage(res, d, fallback) {
    if (res && res.error) {
        // A missing function means 240 has not been pasted yet. Say that rather
        // than letting the camp believe money moved.
        return /PGRST202|could not find|schema cache|does not exist/i.test(res.error.message || '')
            ? 'Canteen writes are not set up yet on the server (migration 240).'
            : fallback + ': ' + res.error.message;
    }
    const code = d && d.error;
    if (code && DESK_ERRORS[code]) {
        let msg = DESK_ERRORS[code];
        if (code === 'over_available' && d.max != null) {
            msg = 'Only $' + Number(d.max).toFixed(2) + ' available to take out.';
        }
        return msg;
    }
    return fallback + (code ? ': ' + code : '');
}

/** Re-read the rows and repaint, so what is on screen is what the server has. */
function _deskRefresh(done) {
    _overlayCanteenRows(snacks, function () {
        try { renderStats(); rAccounts(); rAnalytics(); rSettings(); } catch (_) {}
        if (typeof done === 'function') done();
    });
}

window.addDep = function() {
    if (!_secEdit('accounts', 'Adding funds')) return;
    const name = document.getElementById('depCamper').value;
    const amt = parseFloat(document.getElementById('depAmt').value);
    const noteEl = document.getElementById('depNote');
    const methodEl = document.getElementById('depMethod');
    const note = noteEl ? (noteEl.value || '').trim() : '';
    const cfg = getSettings();
    let method = methodEl ? methodEl.value : 'cash';
    if (!name || !amt || amt <= 0) { toast('Enter valid camper and amount', 1); return; }
    // Belt and braces: a stale DOM (or a hand-edited option) can't smuggle in a
    // method the camp doesn't accept — debit included.
    if (!cfg.payMethods.includes(method)) { toast('That payment method isn\'t accepted', 1); return; }

    const rpc = _deskRpc();
    if (!rpc) { toast('Not connected — a deposit cannot be recorded offline', 1); return; }
    const rounded = Math.round(amt * 100) / 100;

    rpc.client.rpc('canteen_office_credit', {
        p_camp_id: rpc.campId, p_camper_name: name, p_amount: rounded,
        p_method: method, p_note: note, p_date: todayStr(),
        p_camper_id: _deskCamperId(name)
    }).then(function (res) {
        const d = res && res.data;
        if ((res && res.error) || !d || !d.success) {
            toast(_deskMessage(res, d, 'Could not add the funds'), 1);
            return;
        }
        closeM('dep');
        _deskRefresh();
        toast('Added $' + rounded.toFixed(2) + ' to ' + name + ' (' + payMethodLabel(method) + ')');
        document.getElementById('depAmt').value = '';
        if (noteEl) noteEl.value = '';
    }, function (e) {
        toast('Could not add the funds — connection error', 1);
    });
};

// ==========================================================================
// CASH OUT — camper draws part of their canteen balance back as physical cash
// ==========================================================================

/** Refresh the balance box, quick-amount chips, warning and button state. */
window.cashPickCamper = function() {
    const name = (document.getElementById('cashCamper') || {}).value || '';
    const box = document.getElementById('cashBalBox');
    const warn = document.getElementById('cashWarn');
    const btn = document.getElementById('cashBtn');
    const quick = document.getElementById('cashQuick');
    const reqMark = document.getElementById('cashReasonReq');
    const cfg = getSettings();
    if (reqMark) reqMark.textContent = cfg.cashReasonRequired ? '*' : '';

    if (!name) {
        if (box) box.style.display = 'none';
        if (warn) warn.style.display = 'none';
        if (quick) quick.innerHTML = '';
        if (btn) btn.disabled = true;
        return;
    }
    const lim = cashOutLimit(name);
    if (box) {
        box.style.display = '';
        box.innerHTML =
            '<div>Balance: <strong>$' + lim.balance.toFixed(2) + '</strong></div>' +
            '<div>Available to take out: <strong>' + (lim.max === Infinity ? 'no limit' : '$' + lim.max.toFixed(2)) + '</strong></div>' +
            (lim.takenToday > 0 ? '<div style="color:var(--text-muted)">Already taken today: $' + lim.takenToday.toFixed(2) + '</div>' : '');
    }
    if (quick) {
        const caps = [5, 10, 20, 50].filter(v => lim.max === Infinity || v <= lim.max);
        quick.innerHTML = caps.map(v =>
            '<button type="button" class="btn btn-secondary btn-sm" onclick="cashQuickAmt(' + v + ')">$' + v + '</button>'
        ).join('') + (lim.max !== Infinity && lim.max > 0
            ? '<button type="button" class="btn btn-secondary btn-sm" onclick="cashQuickAmt(' + lim.max + ')">All ($' + lim.max.toFixed(2) + ')</button>'
            : '');
    }

    const amt = parseFloat((document.getElementById('cashAmt') || {}).value) || 0;
    let problem = '';
    if (lim.reason) problem = lim.reason;
    else if (amt > 0 && lim.max !== Infinity && amt > lim.max + 1e-9) {
        problem = 'Over the available $' + lim.max.toFixed(2);
    }
    if (warn) { warn.style.display = problem ? '' : 'none'; warn.textContent = problem; }
    if (btn) btn.disabled = !!problem || amt <= 0;
};

window.cashQuickAmt = function(v) {
    const el = document.getElementById('cashAmt');
    if (el) { el.value = Number(v).toFixed(2); cashPickCamper(); }
};

window.cashOut = function() {
    if (!_secEdit('accounts', 'Paying out cash')) return;
    const name = (document.getElementById('cashCamper') || {}).value || '';
    const amt = parseFloat((document.getElementById('cashAmt') || {}).value);
    const note = ((document.getElementById('cashNote') || {}).value || '').trim();
    const by = ((document.getElementById('cashBy') || {}).value || '').trim();
    const cfg = getSettings();
    // Re-validate at write time. The modal can sit open while a POS charge
    // lands from another device, so the number the office saw may be stale.
    const check = window.SnacksCash.validate({
        account: getAccount(name), transactions: snacks.transactions,
        camper: name, date: todayStr(), settings: cfg,
        amount: amt, note: note
    });
    // The client check above is UX: it disables the button and explains before a
    // round trip. It is NOT the enforcement — canteen_office_cash_out applies the
    // same rule (same floor, same cashDailyMax, same cashAllowNegative) under a
    // row lock, which is the only place the balance can be held still.
    if (!check.ok) { toast(check.error, 1); cashPickCamper(); return; }
    const rounded = check.amount;

    const rpc = _deskRpc();
    if (!rpc) { toast('Not connected — cash out cannot be recorded offline', 1); return; }

    rpc.client.rpc('canteen_office_cash_out', {
        p_camp_id: rpc.campId, p_camper_name: name, p_amount: rounded,
        p_note: note, p_by: by, p_date: todayStr(),
        p_camper_id: _deskCamperId(name)
    }).then(function (res) {
        const d = res && res.data;
        if ((res && res.error) || !d || !d.success) {
            toast(_deskMessage(res, d, 'Could not pay out the cash'), 1);
            // The refusal usually means the balance moved under us, so put the
            // real numbers back on the modal rather than leaving a stale figure.
            _deskRefresh(function () { try { cashPickCamper(); } catch (_) {} });
            return;
        }
        closeM('cash');
        _deskRefresh();
        toast('Paid out $' + rounded.toFixed(2) + ' cash to ' + name);
        ['cashAmt', 'cashNote'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    }, function () {
        toast('Could not pay out the cash — connection error', 1);
    });
};

// ==========================================================================
// REFUNDS — Stripe-backed deposits only (migrations/079_canteen_stripe_deposits.sql).
// A manual/cash deposit (addDep above) has no PaymentIntent, so it never
// appears in this list — there's nothing for Stripe to refund. Real
// authorization (owner/admin only) is enforced server-side in
// stripe-canteen-refund, not here — _secEdit is the same UX-level gate the
// rest of this tab already uses, not the security boundary.
// ==========================================================================

// The camp's connected processor — 'stripe' or a BYOP key (cardknox/
// banquest). Cached per page load, same reasoning as campistry_me.js's own
// _getCampPaymentProcessorKey: a lookup hiccup falls back to 'stripe' so it
// never blocks the existing, working Stripe refund flow for a camp that
// never touched BYOP.
var _snacksProcessorKey = null;
async function _getSnacksProcessorKey() {
    if (_snacksProcessorKey) return _snacksProcessorKey;
    try {
        const db = window.CampistryDB;
        const campId = db && db.getCampId && db.getCampId();
        const client = db && db.client;
        if (!campId || !client) return 'stripe';
        const res = await client.rpc('get_camp_payment_processor_status', { p_camp_id: campId });
        _snacksProcessorKey = (res.data && res.data.success && res.data.processorKey) || 'none';
    } catch (e) {
        console.warn('[Snacks] Could not resolve payment processor, defaulting to stripe:', e);
        _snacksProcessorKey = 'stripe';
    }
    return _snacksProcessorKey;
}

// Every online (non-cash/manual) deposit for this camper ON THE CAMP'S
// CURRENT processor — a Stripe deposit has stripePaymentIntentId, a BYOP
// one has byopTransactionId instead. A manual/cash deposit (addDep above)
// has neither, so it never appears here — there's nothing for either
// gateway to refund.
function _onlineDeposits(name, processorKey) {
    return (snacks.transactions || []).filter(t => {
        if (!t || t.camper !== name || t.kind !== 'deposit' || t.method !== processorKey) return false;
        return processorKey === 'stripe' ? !!t.stripePaymentIntentId : !!t.byopTransactionId;
    });
}

// How much of this camper's balance can actually be refunded through the
// camp's CURRENT processor — mirrors the edge function's own math client-
// side, purely for display: each online deposit's original amount minus
// whatever's already been refunded from that same charge.
function _onlineRefundCapacity(name, processorKey) {
    const txs = snacks.transactions || [];
    const idField = processorKey === 'stripe' ? 'stripePaymentIntentId' : 'byopTransactionId';
    return Math.round(_onlineDeposits(name, processorKey).reduce((sum, dep) => {
        const refundedSoFar = txs.filter(t => t && t.kind === 'refund' && t[idField] === dep[idField])
            .reduce((s, t) => s + (Number(t.amount) || 0), 0);
        return sum + Math.max(0, Number(dep.amount) - refundedSoFar);
    }, 0) * 100) / 100;
}

window.refundPickCamper = async function() {
    const name = (document.getElementById('refundCamper') || {}).value || '';
    const box = document.getElementById('refundBox');
    const amtInput = document.getElementById('refundAmt');
    const btn = document.getElementById('refundBtn');
    if (!box || !amtInput) return;
    if (!name) {
        box.style.display = 'none';
        amtInput.value = ''; amtInput.max = '';
        if (btn) btn.disabled = true;
        return;
    }
    const processorKey = await _getSnacksProcessorKey();
    const gatewayLabel = processorKey === 'cardknox' ? 'Sola' : processorKey === 'stripe' ? 'Stripe' : processorKey;
    const a = getAccount(name);
    const walletAvailable = Math.max(0, Math.round((a.balance - (a.balanceFloor || 0)) * 100) / 100);
    const capacity = _onlineRefundCapacity(name, processorKey);
    const max = Math.min(walletAvailable, capacity);

    box.style.display = '';
    box.innerHTML =
        '<div>Available to refund via ' + esc(gatewayLabel) + ': <strong>$' + max.toFixed(2) + '</strong></div>' +
        (capacity < walletAvailable
            ? '<div style="color:var(--text-muted);margin-top:2px;">$' + (walletAvailable - capacity).toFixed(2) + ' of this balance came from a cash/manual deposit (or a different processor) — refund that portion separately, it can\'t go through ' + esc(gatewayLabel) + '.</div>'
            : '');
    amtInput.max = String(max);
    amtInput.value = max > 0 ? max.toFixed(2) : '';
    if (btn) btn.disabled = max <= 0;
};

// Fills the amount field with everything currently refundable — the
// "send back all leftover money" shortcut. Just a convenience preset on
// top of the same free-text amount field, not a separate code path.
window.refundSetMax = function() {
    const amtInput = document.getElementById('refundAmt');
    if (amtInput && amtInput.max) amtInput.value = Number(amtInput.max).toFixed(2);
    refundAmtChanged();
};

window.refundAmtChanged = function() {
    const amtInput = document.getElementById('refundAmt');
    const btn = document.getElementById('refundBtn');
    if (!amtInput || !btn) return;
    const max = Number(amtInput.max) || 0;
    const val = Number(amtInput.value) || 0;
    btn.disabled = !(val > 0 && val <= max + 0.001); // small epsilon for float rounding
};

// supabase-js's functions.invoke() collapses EVERY non-2xx response into the
// same generic "Edge Function returned a non-2xx status code" on res.error.message
// — the real { error: "..." } body this and every other edge function in this
// app actually returns lands on res.error.context instead (a raw Response
// object nothing here was unwrapping). Without this, every deliberate,
// specific error message written server-side (missing field, nothing left
// to refund, cash-only balance, etc.) was invisible — the office only ever
// saw the useless generic string.
async function _edgeFnErrorMessage(res) {
    var data = res && res.data;
    if (data && data.error) return data.error;
    var err = res && res.error;
    if (!err) return null;
    try {
        if (err.context && typeof err.context.json === 'function') {
            var body = await err.context.json();
            if (body && body.error) return body.error;
        }
    } catch (_) { /* context wasn't JSON — fall through to the generic message */ }
    return err.message || String(err);
}

window.refundCanteenDeposit = async function() {
    if (!_secEdit('accounts', 'Refunding a deposit')) return;
    const name = (document.getElementById('refundCamper') || {}).value || '';
    const amount = Number((document.getElementById('refundAmt') || {}).value) || 0;
    const warn = document.getElementById('refundWarn');
    const btn = document.getElementById('refundBtn');
    if (!name || !(amount > 0)) { toast('Pick a camper and an amount', 1); return; }
    const db = window.CampistryDB;
    const client = db && db.client;
    if (!client) { toast('Not signed in', 1); return; }
    const processorKey = await _getSnacksProcessorKey();
    const fnName = processorKey === 'stripe' ? 'stripe-canteen-refund' : 'payments-canteen-refund';
    if (warn) warn.style.display = 'none';
    if (btn) { btn.disabled = true; btn.textContent = 'Refunding…'; }
    client.functions.invoke(fnName, { body: { camperName: name, amount: amount } })
        .then(async function(res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Refund'; }
            var data = res && res.data;
            var hasError = !!(res && res.error) || !!(data && data.error);
            var err = hasError ? await _edgeFnErrorMessage(res) : null;
            if (err) {
                if (warn) { warn.style.display = ''; warn.textContent = err; }
                else toast(err, 1);
                return;
            }
            closeM('refund');
            var acrossN = (data.refunds || []).length;
            toast('Refunded $' + Number(data.totalRefunded).toFixed(2) + ' to ' + name +
                (acrossN > 1 ? ' (across ' + acrossN + ' deposits)' : '') +
                (data.capped && data.cappedReason ? ' — ' + data.cappedReason : ''));
            _refreshSnacksFromCloud();
        }, function(e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Refund'; }
            var msg = (e && e.message) || 'Could not process the refund.';
            if (warn) { warn.style.display = ''; warn.textContent = msg; }
            else toast(msg, 1);
        });
};

// ── Refund All — every camper's leftover Stripe-paid balance in one go ─────
// Client-side preview mirrors the edge function's own math exactly (walletAvailable
// vs stripeCapacity) so the confirm screen shows a real number, not a guess —
// the server is still the one that actually decides/executes it.
function _refundAllPreview() {
    var total = 0, count = 0;
    (camperList || []).forEach(function(c) {
        var a = getAccount(c.name);
        var walletAvailable = Math.max(0, Math.round((a.balance - (a.balanceFloor || 0)) * 100) / 100);
        var capacity = _stripeRefundCapacity(c.name);
        var amt = Math.round(Math.min(walletAvailable, capacity) * 100) / 100;
        if (amt > 0) { total = Math.round((total + amt) * 100) / 100; count++; }
    });
    return { total: total, count: count };
}

window.openRefundAllModal = function() {
    if (!_secEdit('accounts', 'Refunding all canteen balances')) return;
    var body = document.getElementById('refundAllBody');
    var btn = document.getElementById('refundAllBtn');
    var resultEl = document.getElementById('refundAllResult');
    if (resultEl) resultEl.style.display = 'none';
    var preview = _refundAllPreview();
    if (!body) return;
    if (!preview.count) {
        body.innerHTML = '<p>No campers currently have a Stripe-paid balance to refund.</p>';
        if (btn) btn.style.display = 'none';
    } else {
        body.innerHTML =
            '<p>This will refund <strong>' + preview.count + ' camper' + (preview.count === 1 ? '' : 's') +
            '</strong>, totaling approximately <strong>$' + preview.total.toFixed(2) + '</strong> — sent back to whatever each parent originally paid with.</p>' +
            '<p style="color:var(--text-muted);">Only Stripe-paid deposits are included. A balance that came entirely from a cash/manual deposit is skipped — refund that by hand.</p>' +
            '<p style="color:var(--red-600);font-weight:600;">This cannot be undone.</p>';
        if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Refund All ($' + preview.total.toFixed(2) + ')'; }
    }
    openM('refundall');
};

window.refundAllCanteenDeposits = function() {
    if (!_secEdit('accounts', 'Refunding all canteen balances')) return;
    var btn = document.getElementById('refundAllBtn');
    var resultEl = document.getElementById('refundAllResult');
    var db = window.CampistryDB;
    var client = db && db.client;
    if (!client) { toast('Not signed in', 1); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Refunding everyone…'; }
    if (resultEl) resultEl.style.display = 'none';
    // Route by the camp's processor, the way the per-camper refund already
    // does. This used to call the Stripe function unconditionally, so a
    // Cardknox or Banquest camp clicking "refund everyone" hit a function
    // looking for Stripe charges they never had: it found nothing refundable
    // and reported success, having returned nobody's money.
    _getSnacksProcessorKey().then(function(processorKey) {
    var _fn = processorKey === 'stripe' ? 'stripe-canteen-refund-all' : 'payments-canteen-refund-all';
    client.functions.invoke(_fn, { body: {} })
        .then(async function(res) {
            var data = res && res.data;
            var hasError = !!(res && res.error) || !!(data && data.error);
            var err = hasError ? await _edgeFnErrorMessage(res) : null;
            if (err) {
                if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
                if (resultEl) { resultEl.style.display = ''; resultEl.style.color = 'var(--red-600)'; resultEl.textContent = err; }
                return;
            }
            if (btn) btn.style.display = 'none';
            var msg = 'Refunded $' + Number(data.totalRefunded).toFixed(2) + ' across ' + data.refundedCount + ' camper' + (data.refundedCount === 1 ? '' : 's') + '.';
            if (data.skippedCount) msg += ' ' + data.skippedCount + ' skipped (no online balance to refund).';
            if (data.failedCount) msg += ' ' + data.failedCount + ' hit an error — check with the parent or try that camper individually.';
            if (resultEl) { resultEl.style.display = ''; resultEl.style.color = data.failedCount ? 'var(--red-600)' : '#16A34A'; resultEl.textContent = msg; }
            _refreshSnacksFromCloud();
        }, function(e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
            var msg = (e && e.message) || 'Could not process refunds.';
            if (resultEl) { resultEl.style.display = ''; resultEl.style.color = 'var(--red-600)'; resultEl.textContent = msg; }
        });
    }, function(e) {
        // Could not even work out which processor the camp is on — refunding
        // through the wrong one is worse than not starting, so stop here.
        if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
        var msg = 'Could not read this camp\'s payment processor: ' + ((e && e.message) || 'unknown');
        if (resultEl) { resultEl.style.display = ''; resultEl.style.color = 'var(--red-600)'; resultEl.textContent = msg; }
    });
};

// The refund's balance/transaction change happens server-side (the RPC), not
// via saveSnacksData's push-and-merge path — pull the fresh row directly so
// the UI reflects it immediately instead of waiting on whatever polling/
// realtime sync interval the rest of the app relies on.
function _refreshSnacksFromCloud() {
    try {
        const db = window.CampistryDB;
        const client = db && db.client;
        const campId = db && db.getCampId && db.getCampId();
        if (!client || !campId) return;
        client.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'campistrySnacks').maybeSingle()
            .then(function(res) {
                var cloud = res && res.data && res.data.value;
                if (!cloud || typeof cloud !== 'object') return;
                snacks = cloud;
                // ★ 219: the document's own accounts/transactions are stale by
                // design. Overlay the rows BEFORE rendering, or the POS shows
                // balances frozen at the moment the writers moved.
                _overlayCanteenRows(snacks, function () {
                    try { var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); g.campistrySnacks = snacks; localStorage.setItem(STORE_KEY, JSON.stringify(g)); } catch (_) {}
                    renderStats(); rAccounts(); rAnalytics(); rSettings();
                });
            });
    } catch (e) { console.warn('[Snacks] refresh after refund failed:', e); }
}

// ==========================================================================
// LEDGER COMPACTION — the office action
// ==========================================================================
// See the block above _reconcileBalances for the model. This is the ONLY
// writer of ledgerCarry / ledgerCompactedThrough; every other path merely
// carries them through. Three things make it safe to drop rows:
//
//   1. Nothing is folded that is not archived. Step A saves the merged ledger
//      first, so migration 203's trigger has archived every row this tab can
//      see; verify_canteen_archive then has to say inSync for exactly that
//      many rows before a single one is dropped.
//   2. The fold cannot move a balance. The plan reconciles before and after
//      and refuses to save if any account differs by a cent.
//   3. The save is compare-and-set on camp_state_kv.updated_at, so a register
//      sale landing between the read and the write makes the write fail and
//      the whole thing retry from a fresh read — instead of the sale being
//      overwritten by a value that never saw it.

/** The merge cloudSaveSnacks does, as a function, so compaction runs the same one. */
function _mergeSnacksInto(cloud, data) {
    if (!cloud || typeof cloud !== 'object') return data;
    // Union transactions (cloud + local), deduped by signature.
    var seen = {}, tx = [];
    (data.transactions || []).concat(cloud.transactions || []).forEach(function(t) {
        var s = _txSig(t); if (seen[s]) return; seen[s] = 1; tx.push(t);
    });
    var merged = Object.assign({}, cloud, data);          // local wins for inventory/config
    merged.accounts = Object.assign({}, cloud.accounts || {}, data.accounts || {});
    merged.transactions = _mergeCompaction(merged, tx, cloud, data);
    _reconcileBalances(merged);                            // balance := ledger truth
    return merged;
}

/** YYYY-MM-DD, `days` before `today` (also YYYY-MM-DD). Calendar days, UTC-safe. */
function _dateDaysBefore(today, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today || '');
    if (!m) return '';
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]) - (Math.max(0, days | 0) * 86400000);
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function _cents(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * The fold, as a pure plan over one ledger. Returns everything the action and
 * the tests need to judge it, and never touches its input.
 */
function _snacksCompactPlan(data, days, today) {
    var w = _dateDaysBefore(today, days);
    var oldW = (data && data.ledgerCompactedThrough) || '';
    if (!w) return { error: 'bad_date' };
    if (w <= oldW) return { nothing: true, watermark: oldW };

    var txs = (data && data.transactions) || [];
    var dropped = [], folded = [], live = [];
    txs.forEach(function(t) {
        if (_txFolded(t, oldW)) dropped.push(t);          // already carried — must not fold twice
        else if (_txFolded(t, w)) folded.push(t);
        else live.push(t);
    });

    var carry = _ledgerBuckets(folded, data.ledgerCarry);
    ['byId', 'byNameNoId', 'byName'].forEach(function(k) {
        Object.keys(carry[k]).forEach(function(key) { carry[k][key] = _cents(carry[k][key]); });
    });

    // The baseline is the ledger as the merge contract defines it: rows at or
    // below the OLD watermark are already in the carry, so a stale-code tab
    // that resurrected one must not make the baseline count it twice — that
    // would refuse a correct fold for the wrong reason.
    var base = JSON.parse(JSON.stringify(data));
    base.transactions = txs.filter(function(t) { return !_txFolded(t, oldW); });
    var before = _reconcileBalances(base);
    var result = Object.assign({}, data, {
        accounts: JSON.parse(JSON.stringify(data.accounts || {})),
        transactions: live,
        ledgerCarry: carry,
        ledgerCompactedThrough: w
    });
    _reconcileBalances(result);

    var drift = [];
    Object.keys(before.accounts || {}).forEach(function(name) {
        var a = before.accounts[name], b = result.accounts[name];
        if (!a || !b) return;
        if (_cents(a.balance) !== _cents(b.balance)) drift.push(name);
    });

    return { watermark: w, oldWatermark: oldW, folded: folded, live: live, dropped: dropped,
             result: result, invariantOk: drift.length === 0, drift: drift };
}

/**
 * Compare-and-set write of the whole campistrySnacks value. Resolves to the
 * new updated_at, or null if the row's updated_at no longer matched — someone
 * wrote in between, and the caller must re-read rather than overwrite them.
 */
async function _casWriteSnacks(client, campId, value, expectStamp) {
    var q = client.from('camp_state_kv')
        .update({ value: value, updated_at: new Date().toISOString() })
        .eq('camp_id', campId).eq('key', 'campistrySnacks');
    if (expectStamp) q = q.eq('updated_at', expectStamp);
    var res = await q.select('updated_at');
    if (res.error) throw new Error(res.error.message || 'save failed');
    if (!res.data || !res.data.length) return null;
    return res.data[0].updated_at;
}

function _renderCompactionCard() {
    var box = document.getElementById('ledgerCompactBox');
    if (!box) return;
    var txs = snacks.transactions || [];
    var dates = txs.map(function(t) { return t && typeof t.date === 'string' ? t.date : ''; })
                   .filter(function(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();
    var w = snacks.ledgerCompactedThrough || '';
    box.innerHTML =
        '<div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:.85rem">' +
            '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Live transactions</div>' +
                '<div style="font-size:1.15rem;font-weight:700">' + txs.length + '</div></div>' +
            '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Oldest live</div>' +
                '<div style="font-size:1.15rem;font-weight:700">' + esc(dates[0] || '—') + '</div></div>' +
            '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Archived through</div>' +
                '<div style="font-size:1.15rem;font-weight:700">' + esc(w || 'never') + '</div></div>' +
        '</div>' +
        '<p style="font-size:.82rem;color:var(--text-muted);margin:0 0 .75rem">Every transaction is kept permanently in the archive the moment it reaches the cloud. ' +
        'Archiving moves older rows out of the live list so every register sale and sync stays fast all season. ' +
        'Balances do not change — each camper\'s archived history is carried forward to the cent — and the full history stays viewable from a camper\'s History.</p>' +
        '<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">' +
            '<label style="font-size:.85rem">Keep the last <input type="number" id="compactDays" class="input" value="30" min="7" max="365" style="width:5rem;display:inline-block;margin:0 .35rem"> days live</label>' +
            '<button class="btn btn-secondary" id="compactBtn" onclick="compactSnacksLedger()">Archive older transactions</button>' +
        '</div>' +
        '<div id="compactResult" style="margin-top:.6rem;font-size:.82rem;display:none"></div>';
}

window.compactSnacksLedger = async function() {
    if (!_secEdit('settings', 'Archiving old transactions')) return;
    var db = window.CampistryDB;
    var client = db && db.client;
    var campId = db && db.getCampId && db.getCampId();
    if (!client || !campId) { toast('Not signed in', 1); return; }
    var daysEl = document.getElementById('compactDays');
    var days = daysEl ? parseInt(daysEl.value, 10) : 30;
    if (!isFinite(days) || days < 7) { toast('Keep at least 7 days live', 1); return; }
    var btn = document.getElementById('compactBtn');
    var out = document.getElementById('compactResult');
    var say = function(msg, bad) {
        if (out) { out.style.display = ''; out.style.color = bad ? 'var(--red-600)' : '#16A34A'; out.textContent = msg; }
    };
    if (btn) { btn.disabled = true; btn.textContent = 'Archiving…'; }
    try {
        for (var attempt = 0; attempt < 3; attempt++) {
            // read
            var res = await client.from('camp_state_kv').select('value, updated_at')
                .eq('camp_id', campId).eq('key', 'campistrySnacks').maybeSingle();
            if (res.error) throw new Error(res.error.message);
            var cloud = res.data && res.data.value;
            var stamp = res.data && res.data.updated_at;
            if (!cloud || typeof cloud !== 'object') { say('Nothing to archive yet.'); return; }

            // A: land everything this tab knows, so the archive sees it
            var merged = _mergeSnacksInto(cloud, snacks);
            var stamp1 = await _casWriteSnacks(client, campId, merged, stamp);
            if (stamp1 === null) continue;                 // a sale landed — re-read

            // the floor has to be under every row before any row is dropped
            var v = await client.rpc('verify_canteen_archive', { p_camp_id: campId });
            var vd = v && v.data;
            if (v.error || !vd || !vd.success) {
                say('Could not confirm the archive (' + ((v.error && v.error.message) || (vd && vd.error) || 'unknown') + '). Nothing was changed.', true);
                return;
            }
            if (!vd.inSync) {
                say('The archive is behind the live list (' + vd.missingFromArchive + ' missing). Nothing was changed — try again in a moment.', true);
                return;
            }
            // In sync, but counting a different ledger than the one this tab
            // just landed: a sale arrived between A and the check. That is a
            // race, not a gap — re-read and go again rather than fold a value
            // the verifier never looked at.
            if (Number(vd.blobTransactions) !== merged.transactions.length) continue;

            // the fold, checked
            var plan = _snacksCompactPlan(merged, days, todayStr());
            if (plan.error) { say('Could not work out the date.', true); return; }
            if (plan.nothing) { say('Already archived through ' + plan.watermark + ' — nothing older than ' + days + ' days to move.'); return; }
            if (!plan.invariantOk) {
                console.error('[Snacks] compaction refused — balances would move:', plan.drift);
                say('Refused: archiving would change ' + plan.drift.length + ' balance' + (plan.drift.length === 1 ? '' : 's') + '. Nothing was changed.', true);
                return;
            }
            if (!plan.folded.length) { say('Nothing older than ' + days + ' days to move.'); return; }

            // B: the compacted value, only if nobody wrote since A
            var stamp2 = await _casWriteSnacks(client, campId, plan.result, stamp1);
            if (stamp2 === null) continue;

            snacks = plan.result;
            try {
                var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
                g.campistrySnacks = snacks; g.updated_at = new Date().toISOString();
                localStorage.setItem(STORE_KEY, JSON.stringify(g));
                localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
                localStorage.setItem(SNACKS_LOCAL_KEY, JSON.stringify(snacks));
            } catch (_) {}
            renderStats(); rAccounts(); rAnalytics(); rSettings();
            say('Archived ' + plan.folded.length + ' transaction' + (plan.folded.length === 1 ? '' : 's') +
                ' through ' + plan.watermark + '. ' + plan.live.length + ' stay live. No balance changed.');
            toast('Archived ' + plan.folded.length + ' older transactions');
            return;
        }
        say('The register was busy — nothing was changed. Try again in a moment.', true);
    } catch (e) {
        console.error('[Snacks] compaction failed:', e);
        say('Archiving failed: ' + (e && e.message || 'unknown error') + '. Nothing was changed.', true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Archive older transactions'; }
    }
};

// ── Archived history, on demand, from the archive rather than the blob ──────
// Fetched rows are rendered only; they are never written back into
// snacks.transactions, which would undo the compaction on the next save.
function _archivedHistoryHtml() {
    var w = snacks.ledgerCompactedThrough;
    if (!w) return '';
    return '<div id="histArchived" style="margin-top:.75rem;border-top:1px dashed var(--border);padding-top:.6rem">' +
        '<button class="btn btn-secondary btn-sm" onclick="loadArchivedHistory()">Show archived history (before ' + esc(w) + ')</button></div>';
}

window.loadArchivedHistory = async function() {
    var host = document.getElementById('histArchived');
    if (!host) return;
    var db = window.CampistryDB, client = db && db.client, campId = db && db.getCampId && db.getCampId();
    if (!client || !campId) { toast('Not signed in', 1); return; }
    host.innerHTML = '<div style="font-size:.82rem;color:var(--text-muted)">Loading…</div>';
    try {
        var res = await client.rpc('get_canteen_history', { p_camp_id: campId, p_camper: _histCamper, p_before: null, p_limit: 1000 });
        var d = res && res.data;
        if (res.error || !d || !d.success) throw new Error((res.error && res.error.message) || (d && d.error) || 'unknown');
        var w = snacks.ledgerCompactedThrough;
        var rows = (d.transactions || []).filter(function(t) { return _txFolded(t, w); });
        if (_histFilter === 'in') rows = rows.filter(function(t) { return t.type === 'credit'; });
        else if (_histFilter === 'out') rows = rows.filter(function(t) { return t.type !== 'credit'; });
        rows.sort(function(x, y) { return _histSortKey(y) - _histSortKey(x); });
        host.innerHTML = '<div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem">Archived · through ' + esc(w) + '</div>' +
            (rows.length ? rows.map(_histRowHtml).join('') : '<div style="font-size:.82rem;color:var(--text-muted)">No archived transactions.</div>');
    } catch (e) {
        host.innerHTML = '<div style="font-size:.82rem;color:var(--red-600)">Could not load the archive: ' + esc(e && e.message || 'unknown error') + '</div>';
    }
};

window.setLimit = function() {
    if (!_secEdit('accounts', 'Changing a spending limit')) return;
    const name = document.getElementById('limCamper').value;
    const amt = parseFloat(document.getElementById('limAmt').value);
    // 0 is a valid, meaningful value here (submit_canteen_purchase's existing
    // convention: dailyLimit <= 0 means no daily cap at all) — !amt used to
    // reject it as if it were blank/invalid, silently blocking the office
    // from ever setting "no limit" for a camper.
    if (!name || amt == null || isNaN(amt) || amt < 0) { toast('Enter valid info', 1); return; }

    const rpc = _deskRpc();
    if (!rpc) { toast('Not connected — a limit cannot be changed offline', 1); return; }

    rpc.client.rpc('canteen_office_set_limit', {
        p_camp_id: rpc.campId, p_camper_name: name, p_daily_limit: amt,
        p_camper_id: _deskCamperId(name)
    }).then(function (res) {
        const d = res && res.data;
        if ((res && res.error) || !d || !d.success) {
            toast(_deskMessage(res, d, 'Could not change the limit'), 1);
            return;
        }
        closeM('limit');
        _deskRefresh();
        toast(amt === 0 ? 'No daily limit set for ' + name
                        : 'Limit set to $' + amt.toFixed(2) + ' for ' + name);
    }, function () {
        toast('Could not change the limit — connection error', 1);
    });
};

// _editingItemId is null while the modal is in "Add Item" mode, or the id
// of the item being edited when opened via openEditItem(). Both open the
// same modal/form — saveItem() branches on this instead of duplicating it.
let _editingItemId = null;

// Category is free text, not a fixed enum — offices can create their own
// categories (e.g. "Merch", "Candy") on top of the Snack/Drink/Treat
// starting suggestions. The datalist is just autocomplete; any string typed
// is accepted, both here and in the bulk upload template.
function _refreshCatSuggestions() {
    const dl = document.getElementById('niCatList');
    if (!dl) return;
    const seen = new Set();
    const cats = [];
    ['Snack', 'Drink', 'Treat'].concat(snacks.inventory.map(i => i.cat).filter(Boolean)).forEach(c => {
        const key = c.toLowerCase();
        if (!seen.has(key)) { seen.add(key); cats.push(c); }
    });
    dl.innerHTML = cats.map(c => '<option value="' + esc(c) + '">').join('');
}

// Stock is optional — blank means "not tracked" (always sellable, no count
// shown), not zero (which would read as out-of-stock). Stored as `null`
// rather than omitted so every read site has one consistent check
// (`item.stock == null`) instead of guessing at a missing key.
function _readStockField(id) {
    const raw = document.getElementById(id).value.trim();
    if (raw === '') return null;
    const n = parseInt(raw);
    return isNaN(n) ? null : n;
}

window.openAddItem = function() {
    _editingItemId = null;
    ['niName', 'niBarcode', 'niCat', 'niPrice', 'niCost', 'niStock'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    _refreshCatSuggestions();
    document.getElementById('itemModalTitle').textContent = 'Add Item';
    document.getElementById('itemSaveBtn').textContent = 'Add Item';
    openM('item');
};

window.openEditItem = function(id) {
    if (!_secEdit('menu', 'Editing an item')) return;
    const item = snacks.inventory.find(i => i.id === id);
    if (!item) return;
    _editingItemId = id;
    _refreshCatSuggestions();
    document.getElementById('niName').value = item.name;
    document.getElementById('niBarcode').value = item.barcode || '';
    document.getElementById('niCat').value = item.cat;
    document.getElementById('niPrice').value = item.price;
    document.getElementById('niCost').value = item.cost == null ? '' : item.cost;
    document.getElementById('niStock').value = item.stock == null ? '' : item.stock;
    document.getElementById('itemModalTitle').textContent = 'Edit Item';
    document.getElementById('itemSaveBtn').textContent = 'Save Changes';
    openM('item');
};

window.saveItem = function() {
    if (!_secEdit('menu', _editingItemId ? 'Editing an item' : 'Adding an item')) return;
    const name = document.getElementById('niName').value.trim();
    const barcode = document.getElementById('niBarcode').value.trim();
    const cat = document.getElementById('niCat').value.trim();
    const price = parseFloat(document.getElementById('niPrice').value);
    const costRaw = document.getElementById('niCost').value.trim();
    const cost = costRaw === '' ? null : parseFloat(costRaw);
    const stock = _readStockField('niStock');
    if (!name || !price || !cat) { toast('Fill required fields', 1); return; }
    if (barcode && snacks.inventory.some(i => i.barcode === barcode && i.id !== _editingItemId)) {
        toast('That barcode is already assigned to another item', 1);
        return;
    }

    if (_editingItemId) {
        const item = snacks.inventory.find(i => i.id === _editingItemId);
        if (!item) return;
        item.name = name; item.cat = cat; item.price = price;
        if (cost == null || isNaN(cost)) delete item.cost; else item.cost = cost;
        if (stock == null) delete item.stock; else item.stock = stock;
        if (barcode) item.barcode = barcode; else delete item.barcode;
        saveSnacksData(snacks);
        closeM('item');
        rInventory(); renderStats(); rAnalytics();
        toast('Updated ' + name);
    } else {
        const maxId = snacks.inventory.reduce((m, i) => Math.max(m, i.id || 0), 0);
        const newItem = { id: maxId + 1, name, cat, price, soldToday: 0, totalSold: 0 };
        if (cost != null && !isNaN(cost)) newItem.cost = cost;
        if (stock != null) newItem.stock = stock;
        if (barcode) newItem.barcode = barcode;
        snacks.inventory.push(newItem);
        saveSnacksData(snacks);
        closeM('item');
        rInventory(); renderStats(); rAnalytics();
        toast('Added ' + name);
    }
    _editingItemId = null;
    ['niName', 'niBarcode', 'niCat', 'niPrice', 'niCost', 'niStock'].forEach(id => document.getElementById(id).value = '');
};

window.restock = function() {
    if (!_secEdit('menu', 'Restocking')) return;
    const iid = +document.getElementById('rItem').value;
    const qty = parseInt(document.getElementById('rQty').value);
    if (!iid || !qty) { toast('Select item and quantity', 1); return; }
    const item = snacks.inventory.find(i => i.id === iid);
    if (!item) return;
    // Restocking an untracked (stock: null) item starts tracking it from 0.
    item.stock = (item.stock || 0) + qty;
    // Optional: total cost paid for this batch → cost-per-unit (e.g. 500
    // bags for $500 = $1.00/bag). Overwrites the item's cost with the
    // latest purchase price — this system tracks current state, not a
    // FIFO/weighted-average cost history. Blank = keep the existing cost.
    const totalCostRaw = document.getElementById('rTotalCost').value.trim();
    if (totalCostRaw !== '') {
        const totalCost = parseFloat(totalCostRaw);
        if (!isNaN(totalCost) && totalCost >= 0) item.cost = Math.round((totalCost / qty) * 100) / 100;
    }
    document.getElementById('rTotalCost').value = '';
    saveSnacksData(snacks);
    closeM('restock');
    rInventory(); renderStats(); rAnalytics();
    toast('Restocked ' + item.name + ' +' + qty);
};

// ==========================================================================
// BULK UPLOAD — Excel/CSV import for menu items (Name, Category, Price,
// Stock). Matches by name (case-insensitive) to decide add vs. update, so
// re-uploading the same sheet after editing prices is safe and idempotent.
// ==========================================================================

let _uploadParsedRows = null;

window.openUploadModal = function() {
    if (!_secEdit('menu', 'Uploading items')) return;
    document.getElementById('uploadFile').value = '';
    document.getElementById('uploadPreview').innerHTML = '';
    document.getElementById('uploadConfirmBtn').disabled = true;
    _uploadParsedRows = null;
    openM('upload');
};

window.downloadItemTemplate = function() {
    const ws = XLSX.utils.aoa_to_sheet([
        ['Name', 'Category', 'Price', 'Stock', 'Cost'],
        ['Gatorade', 'Drink', 2, 100, 1],
        ['Chips', 'Snack', 1.5, '', 1],
        ['Candy Bar', 'Custom', 1, '', ''],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    XLSX.writeFile(wb, 'campistry-menu-items-template.xlsx');
};

window.handleUploadFile = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const wb = XLSX.read(e.target.result, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
            _processUploadRows(rows);
        } catch (err) {
            toast('Could not read that file — make sure it\'s a valid Excel or CSV file', 1);
        }
    };
    reader.readAsArrayBuffer(file);
};

function _processUploadRows(rows) {
    // Skip a header row if the first cell reads like "Name".
    let startIdx = 0;
    if (rows.length && String(rows[0][0] || '').trim().toLowerCase() === 'name') startIdx = 1;

    const parsed = [];
    for (let r = startIdx; r < rows.length; r++) {
        const row = rows[r];
        if (!row || !row.length || row.every(c => c === '' || c == null)) continue;
        const name = String(row[0] || '').trim();
        const cat = String(row[1] || '').trim();
        const priceRaw = row[2];
        const stockRaw = row[3];
        const costRaw = row[4];

        let error = null;
        if (!name) error = 'Missing name';
        if (!error && !cat) error = 'Missing category';
        const price = parseFloat(priceRaw);
        if (!error && (isNaN(price) || price <= 0)) error = 'Invalid price';
        let stock = null;
        if (stockRaw !== '' && stockRaw != null) {
            const n = parseInt(stockRaw);
            stock = isNaN(n) ? null : n;
        }
        let cost = null;
        if (costRaw !== '' && costRaw != null) {
            const c = parseFloat(costRaw);
            cost = isNaN(c) ? null : c;
        }

        const existing = snacks.inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
        parsed.push({
            row: r + 1, name, cat, price, stock, cost, error,
            action: error ? 'error' : (existing ? 'update' : 'add'),
            existingId: existing ? existing.id : null,
        });
    }
    _uploadParsedRows = parsed;
    _renderUploadPreview(parsed);
}

function _renderUploadPreview(parsed) {
    if (!parsed.length) {
        document.getElementById('uploadPreview').innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text-muted)">No rows found in that file.</div>';
        document.getElementById('uploadConfirmBtn').disabled = true;
        return;
    }
    const errs = parsed.filter(r => r.error).length;
    const adds = parsed.filter(r => r.action === 'add').length;
    const upds = parsed.filter(r => r.action === 'update').length;
    const rowsHtml = parsed.map(r => {
        const statusHtml = r.error
            ? '<span class="badge badge-red">' + esc(r.error) + '</span>'
            : (r.action === 'update' ? '<span class="badge badge-amber">Update</span>' : '<span class="badge badge-green">New</span>');
        return '<tr><td>' + r.row + '</td><td>' + esc(r.name || '—') + '</td><td>' + esc(r.cat || '—') + '</td><td>' +
            (isNaN(r.price) ? '—' : '$' + r.price.toFixed(2)) + '</td><td>' + (r.cost == null ? '—' : '$' + r.cost.toFixed(2)) + '</td><td>' + (r.stock == null ? '—' : r.stock) +
            '</td><td>' + statusHtml + '</td></tr>';
    }).join('');
    document.getElementById('uploadPreview').innerHTML =
        '<div style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.5rem">' + adds + ' new, ' + upds + ' to update' +
        (errs ? ', ' + errs + ' with errors (skipped)' : '') + '</div>' +
        '<div class="table-wrapper" style="max-height:280px;overflow-y:auto"><table class="data-table"><thead><tr><th>Row</th><th>Name</th><th>Category</th><th>Price</th><th>Cost</th><th>Stock</th><th>Status</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    document.getElementById('uploadConfirmBtn').disabled = (adds + upds) === 0;
}

window.confirmUploadImport = function() {
    if (!_secEdit('menu', 'Uploading items')) return;
    if (!_uploadParsedRows) return;
    let maxId = snacks.inventory.reduce((m, i) => Math.max(m, i.id || 0), 0);
    let added = 0, updated = 0;
    _uploadParsedRows.forEach(r => {
        if (r.error) return;
        if (r.action === 'update') {
            const item = snacks.inventory.find(i => i.id === r.existingId);
            if (!item) return;
            item.name = r.name; item.cat = r.cat; item.price = r.price;
            if (r.stock == null) delete item.stock; else item.stock = r.stock;
            if (r.cost == null) delete item.cost; else item.cost = r.cost;
            updated++;
        } else {
            maxId++;
            const newItem = { id: maxId, name: r.name, cat: r.cat, price: r.price, soldToday: 0, totalSold: 0 };
            if (r.stock != null) newItem.stock = r.stock;
            if (r.cost != null) newItem.cost = r.cost;
            snacks.inventory.push(newItem);
            added++;
        }
    });
    saveSnacksData(snacks);
    closeM('upload');
    rInventory(); renderStats(); rAnalytics();
    toast('Imported ' + added + ' new, updated ' + updated + ' item' + ((added + updated) === 1 ? '' : 's'));
};

// ==========================================================================
// UTILS
// ==========================================================================

// ── Section access gates ─────────────────────────────────────────
// campistry_access_sections.js disables controls inside a view-only section,
// but a stale DOM or an inline handler on a non-control element can still
// reach these. Each write path checks explicitly.
function _secEdit(section, whatFor) {
    var S = window.CampistrySections;
    return S ? S.requireEdit(section, whatFor) : true;
}
function _secCan(section) {
    var S = window.CampistrySections;
    return S ? S.can(section) : true;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function toast(m, e) {
    const el = document.getElementById('toast');
    el.textContent = m;
    el.className = 'toast show' + (e ? ' err' : '');
    setTimeout(() => el.className = 'toast', 2500);
}

// Expose for POS cross-reference
window.CampistrySnacks = {
    getSnacksData: () => snacks,
    saveSnacksData,
    getRoster,
    getCamperList,
    getAccount,
    loadSnacksData,
    // Settings + cash-drawer helpers, shared with the POS terminal.
    getSettings,
    payMethodLabel,
    PAY_METHODS,
    BLOCKED_PAY_METHODS,
    cashOutLimit,
    cashOutTotal,
    refresh: () => { snacks = loadSnacksData(); ensureAccountsForRoster(); }
};

document.addEventListener('DOMContentLoaded', init);

// The roster (app1.camperRoster) and this page's own campistrySnacks data
// both hydrate from the cloud asynchronously, shortly AFTER DOMContentLoaded
// fires. init() above runs before that hydration lands, so on a fresh page
// load it was reading an empty/stale roster — 0 campers shown, permanently
// (nothing ever re-ran init() afterward). Re-run once hydration completes.
window.addEventListener('campistry-cloud-hydrated', function () {
    console.log('[Snacks Manager] Cloud hydrated — reloading roster + snacks data');
    try {
        var db = window.CampistryDB;
        var campId = db && db.getCampId && db.getCampId();
        var stored = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
        var invSummary = ((stored.campistrySnacks && stored.campistrySnacks.inventory) || [])
            .filter(function (i) { return (i.soldToday || 0) > 0 || (i.totalSold || 0) > 0; })
            .map(function (i) { return i.name + ':' + i.soldToday + '/' + i.totalSold; });
        console.log('[Snacks Manager DEBUG] campId=', campId, 'campGlobalSettings_v1.campistrySnacks.inventory deltas:', invSummary);
    } catch (e) { console.log('[Snacks Manager DEBUG] inspection failed:', e); }
    snacks = loadSnacksData();
    try {
        var afterSummary = (snacks.inventory || [])
            .filter(function (i) { return (i.soldToday || 0) > 0 || (i.totalSold || 0) > 0; })
            .map(function (i) { return i.name + ':' + i.soldToday + '/' + i.totalSold; });
        console.log('[Snacks Manager DEBUG] loadSnacksData() returned inventory deltas:', afterSummary);
    } catch (e) {}
    _hydratedOnce = true;
    // ★ 219: balances and the ledger come from rows, not from the hydrated
    // document. Overlay before init() renders, or the first thing a register
    // shows is every balance as it stood when the writers moved off the
    // document — plausible numbers, quietly wrong. If the rows cannot be
    // reached, init() still runs: a POS that renders stale balances is bad,
    // and a POS that renders nothing at all is worse.
    _overlayCanteenRows(snacks, function (ok) {
        if (!ok) console.warn('[Snacks] could not load balances from rows — showing the '
                              + 'document copy, which is no longer maintained');
        init();
    });
});
})();
