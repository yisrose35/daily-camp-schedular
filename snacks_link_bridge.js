// =============================================================================
// snacks_link_bridge.js — applies parent canteen actions from Campistry Link
// =============================================================================
//
// Parents at home submit Add Funds / spending-control changes through the
// Link portal (submit_canteen_op RPC → link_canteen_ops table). This bridge,
// loaded by the Snacks manager and the POS, pulls the pending ops, applies
// them to the canonical snacks store (campGlobalSettings_v1.campistrySnacks,
// mirrored to camp_state_kv), and marks them applied.
//
// Ops-ledger pattern: each parent action is its own row, so there is no
// blob-clobber race with the POS's own writes. Idempotency is double-locked:
// rows are fetched with status='pending' only, and applied op ids are also
// recorded in store.appliedLinkOps (capped) in case the status update fails.
//
// Requires: config.js, supabase-js@2.js, supabase_client.js,
//           campistry_cloud_bootstrap.js (must load first)
// =============================================================================
(function () {
    'use strict';

    var STORE_KEY = 'campGlobalSettings_v1';
    var POLL_MS = 45000;
    var _busy = false;

    function readGlobal() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (_) { return {}; }
    }

    function nowParts() {
        var d = new Date();
        return {
            time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        };
    }

    function saveStore(snacks) {
        // Prefer the page's own save (writes localStorage + camp_state_kv)
        if (window.CampistrySnacks && window.CampistrySnacks.saveSnacksData) {
            window.CampistrySnacks.saveSnacksData(snacks);
            return;
        }
        try {
            var g = readGlobal();
            g.campistrySnacks = snacks;
            g.updated_at = new Date().toISOString();
            localStorage.setItem(STORE_KEY, JSON.stringify(g));
            localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
        } catch (e) {}
        try {
            var db = window.CampistryDB;
            var campId = db && db.getCampId && db.getCampId();
            if (db && db.client && campId) {
                db.client.from('camp_state_kv')
                    .upsert({ camp_id: campId, key: 'campistrySnacks', value: snacks, updated_at: new Date().toISOString() }, { onConflict: 'camp_id,key' })
                    .then(function (res) { if (res.error) console.warn('[SnacksLink] Cloud save failed:', res.error.message); });
            }
        } catch (e) {}
    }

    function applyOps() {
        if (_busy) return;
        var db = window.CampistryDB;
        if (!db || !db.client) return;
        var campId = db.getCampId && db.getCampId();
        if (!campId) return;
        _busy = true;

        db.client.from('link_canteen_ops')
            .select('id, camper_name, parent_name, op, amount, controls, created_at')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(200)
            .then(function (res) {
                _busy = false;
                if (res.error || !res.data || !res.data.length) return;

                var g = readGlobal();
                var snacks = g.campistrySnacks || { accounts: {}, inventory: [], transactions: [], hourlyActivity: {}, weeklyRevenue: [] };
                if (!snacks.accounts) snacks.accounts = {};
                if (!snacks.transactions) snacks.transactions = [];
                if (!snacks.appliedLinkOps) snacks.appliedLinkOps = [];

                var appliedIds = [];
                res.data.forEach(function (op) {
                    if (snacks.appliedLinkOps.indexOf(op.id) !== -1) { appliedIds.push(op.id); return; }
                    var a = snacks.accounts[op.camper_name] || (snacks.accounts[op.camper_name] = { balance: 0, dailyLimit: 10, spentToday: 0 });
                    if (op.op === 'add_funds' && op.amount) {
                        var amt = Math.round(parseFloat(op.amount) * 100) / 100;
                        a.balance = Math.round(((a.balance || 0) + amt) * 100) / 100;
                        var p = nowParts();
                        snacks.transactions.unshift({
                            time: p.time, camper: op.camper_name,
                            items: 'Funds added by parent (via Link)',
                            amount: amt, type: 'credit', date: p.date
                        });
                    } else if (op.op === 'set_controls' && op.controls) {
                        if (op.controls.dailyLimit   != null) a.dailyLimit   = parseFloat(op.controls.dailyLimit)   || 0;
                        if (op.controls.creditLimit  != null) a.creditLimit  = parseFloat(op.controls.creditLimit)  || 0;
                        if (op.controls.balanceFloor != null) a.balanceFloor = parseFloat(op.controls.balanceFloor) || 0;
                    }
                    snacks.appliedLinkOps.push(op.id);
                    appliedIds.push(op.id);
                });
                snacks.appliedLinkOps = snacks.appliedLinkOps.slice(-500);

                saveStore(snacks);

                db.client.from('link_canteen_ops')
                    .update({ status: 'applied', applied_at: new Date().toISOString() })
                    .in('id', appliedIds)
                    .then(function (r2) { if (r2.error) console.warn('[SnacksLink] Mark-applied failed:', r2.error.message); });

                // Nudge whichever snacks UI is on this page
                try { if (window.CampistrySnacksPOS && window.CampistrySnacksPOS.reinit) window.CampistrySnacksPOS.reinit(); } catch (e) {}
                try { if (window.CampistrySnacks && window.CampistrySnacks.refresh) window.CampistrySnacks.refresh(); } catch (e) {}
                console.log('[SnacksLink] Applied ' + appliedIds.length + ' parent canteen op(s)');
            });
    }

    window.addEventListener('campistry-cloud-hydrated', applyOps);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) applyOps(); });
    setInterval(applyOps, POLL_MS);
    // First attempt shortly after load (client may already be ready)
    setTimeout(applyOps, 4000);

    window.SnacksLinkBridge = { applyOps: applyOps };
})();
