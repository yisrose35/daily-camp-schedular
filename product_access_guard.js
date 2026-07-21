// ============================================================================
// product_access_guard.js — per-product access gate for staff (migration 027)
//
// The owner grants each staff member access to specific PARTS of Campistry
// (camp_users.product_access, e.g. ["go","health"]). This guard, included on a
// product page, blocks the page for a staff member who wasn't granted it.
//
// Owners and admins always pass. Non-members (e.g. the owner viewing a debug
// copy, or anyone whose camp membership can't be resolved) are NOT blocked here
// — the page's own auth handles those, and the real security boundary is RLS +
// the SECURITY DEFINER RPCs. This is a UX/navigation gate, so it fails OPEN on
// any error rather than locking a legitimate user out.
//
// Usage: set the product key before loading this script, e.g.
//   <script>window.__CAMPISTRY_PRODUCT__ = 'health';</script>
//   <script src="product_access_guard.js"></script>
// ============================================================================
(function () {
    'use strict';
    var PRODUCT = window.__CAMPISTRY_PRODUCT__ ||
        (document.currentScript && document.currentScript.getAttribute('data-product'));
    if (!PRODUCT) return;

    var LABELS = {
        me: 'Campistry Me', flow: 'Flow', go: 'Go', health: 'Health',
        snacks: 'Snacks', live: 'Live', link: 'Campistry Link', billing: 'Billing'
    };

    function ready(cb) {
        // Wait until the shared Supabase client + camp id are available.
        var tries = 0;
        (function poll() {
            var db = window.CampistryDB;
            var client = db && db.getClient && db.getClient();
            var campId = db && db.getCampId && db.getCampId();
            if (client && typeof client.from === 'function' && campId) { cb(client, campId); return; }
            if (++tries > 60) return; // ~15s — give up quietly (fail open)
            setTimeout(poll, 250);
        })();
    }

    function block() {
        try {
            var name = LABELS[PRODUCT] || PRODUCT;
            var o = document.createElement('div');
            o.id = '__campistry_access_block';
            o.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#F8FAFC;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
            o.innerHTML =
                '<div style="max-width:420px;text-align:center;background:#fff;border:1px solid #E2E8F0;border-radius:16px;padding:36px 30px;box-shadow:0 12px 40px rgba(0,0,0,.08);">' +
                '<div style="width:52px;height:52px;border-radius:50%;background:#FEF2F2;color:#DC2626;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' +
                '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' +
                '<h1 style="font-size:1.2rem;font-weight:700;color:#0F172A;margin:0 0 8px;">No access to ' + name + '</h1>' +
                '<p style="font-size:.9rem;color:#64748B;line-height:1.5;margin:0 0 20px;">Your account isn’t set up to open ' + name + '. Ask the camp owner to grant you access in Staff &amp; Access.</p>' +
                '<a href="dashboard.html" style="display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;font-weight:600;font-size:.9rem;padding:10px 20px;border-radius:10px;">Back to dashboard</a>' +
                '</div>';
            // Clear the page so nothing behind the overlay runs interactively.
            document.documentElement.style.overflow = 'hidden';
            (document.body || document.documentElement).appendChild(o);
        } catch (e) { /* fail open */ }
    }

    ready(function (client, campId) {
        client.auth.getSession().then(function (s) {
            var uid = s && s.data && s.data.session && s.data.session.user && s.data.session.user.id;
            if (!uid) return; // not signed in — page's own auth handles it
            // Owner of this camp → full access.
            client.from('camps').select('id').eq('id', campId).eq('owner', uid).maybeSingle().then(function (o) {
                if (o && o.data) return; // owner
                client.from('camp_users').select('role,product_access').eq('camp_id', campId).eq('user_id', uid).maybeSingle().then(function (r) {
                    if (r.error || !r.data) return;        // not a resolvable member here — don't block (fail open)
                    if (r.data.role === 'admin') return;   // admins get everything
                    var pa = r.data.product_access || [];
                    if (Array.isArray(pa) && pa.indexOf(PRODUCT) >= 0) return; // granted
                    block();                                // member without this product → gate it
                }, function () { /* fail open */ });
            }, function () { /* fail open */ });
        }, function () { /* fail open */ });
    });
})();
