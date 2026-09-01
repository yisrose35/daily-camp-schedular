// =============================================================================
// parent_lockout_guard.js — keep Parent-Link accounts OUT of the rest of Campistry.
//
// A parent authenticates through the same Supabase project as camp staff. RLS
// already stops them reading any OTHER camp's data — but nothing stopped a parent
// from opening dashboard.html / campistry_me.html / flow.html etc. and landing on
// an empty own-account instance. This guard bounces those accounts back to the
// parent portal.
//
// "Staff wins": if the account has ANY real standing — a camp_users membership or
// ownership of a camp that actually has data — it is treated as staff and passes.
// Only a pure parent (a link_parent_invites row, no real camp) is locked out.
//
// Fail-OPEN on every error: a transient hiccup must never lock a legitimate camp
// director out of their own product. Real enforcement is the server trigger in
// migration 036 (parents cannot create/own camps) + RLS.
//
// Include on every NON-parent page, right before </body>:
//   <script src="parent_lockout_guard.js"></script>
// =============================================================================
(function () {
    'use strict';
    var PARENT_URL = 'campistry_link_parent.html';

    function _client() {
        try { return window.CampistryDB && CampistryDB.getClient ? CampistryDB.getClient() : null; }
        catch (e) { return null; }
    }

    // Wait (bounded) for the Supabase client to exist.
    function _waitClient() {
        return new Promise(function (resolve) {
            var tries = 0;
            (function poll() {
                var c = _client();
                if (c) return resolve(c);
                if (++tries > 60) return resolve(null); // ~15s; give up → fail open
                setTimeout(poll, 250);
            })();
        });
    }

    function _lockOut() {
        try {
            document.documentElement.innerHTML =
                '<body style="margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#F8FAFC;">' +
                '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">' +
                '<div style="max-width:380px;text-align:center;padding:32px;">' +
                '<div style="font-size:1.5rem;font-weight:800;color:#166534;margin-bottom:8px;">Campistry Link</div>' +
                '<p style="color:#475569;font-size:.9rem;line-height:1.6;margin-bottom:20px;">This is a parent account. Taking you to your parent portal…</p>' +
                '<a href="' + PARENT_URL + '" style="display:inline-block;background:#3B82F6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:.9rem;">Go to Parent Portal</a>' +
                '</div></div></body>';
        } catch (e) {}
        try { window.location.replace(PARENT_URL); } catch (e) { window.location.href = PARENT_URL; }
    }

    async function _check() {
        try {
            var client = await _waitClient();
            if (!client) return; // fail open

            var sess = await client.auth.getSession();
            var uid = sess && sess.data && sess.data.session && sess.data.session.user && sess.data.session.user.id;
            if (!uid) return; // not signed in — let the page's own auth flow handle it

            // Is this account a parent at all?
            var pi = await client.from('link_parent_invites').select('id').eq('user_id', uid).limit(1);
            if (pi.error) return;                       // can't tell → fail open
            if (!pi.data || !pi.data.length) return;    // not a parent → allow

            // Parent — but does it have real staff standing? (staff wins)
            var cu = await client.from('camp_users').select('id').eq('user_id', uid).limit(1);
            if (!cu.error && cu.data && cu.data.length) return; // explicit staff member → allow

            var owned = await client.from('camps').select('id').eq('owner', uid);
            if (!owned.error && owned.data && owned.data.length) {
                // Owns camp(s). Treat as staff only if any owned camp has real data
                // (guards against the legacy blank auto-created parent camp).
                for (var i = 0; i < owned.data.length; i++) {
                    var kv = await client.from('camp_state_kv').select('key').eq('camp_id', owned.data[i].id).limit(1);
                    if (!kv.error && kv.data && kv.data.length) return; // real camp → staff → allow
                }
            }

            // Pure parent account, no real camp standing → lock out of the product.
            _lockOut();
        } catch (e) { /* fail open */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _check);
    } else {
        _check();
    }
})();
