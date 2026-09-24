// =============================================================================
// campistry_access_settings.js — the owner/admin screen for per-section access
//
// Two levels of depth in one screen, because the brief was "simple to use but
// at the same time fully customizable":
//
//   SIMPLE   — pick a preset (Division Head, Nurse, Bookkeeper, ...). One
//              click, sensible defaults, done. This is what most camps will
//              ever touch.
//   ADVANCED — expand "Fine-tune" and get every section of every app with
//              None / View / Edit. Changing anything flips the preset chip to
//              "Custom" and keeps the toggles — the preset was only ever a
//              starting point, not a cage.
//
// The registry and the resolution rules live in campistry_capabilities.js. This
// file is UI plus the one RPC call that saves.
//
// Opens from Staff & Access on the dashboard: CampistryAccessSettings.open(member).
// =============================================================================
(function () {
    'use strict';

    var A = {};
    var _member = null;
    var _preset = null;
    var _overrides = {};
    var _advanced = false;
    var _onSaved = null;

    // ── group ("Role") mode ──────────────────────────────────────────────────
    // Same preset-picker + fine-tune-matrix UI, retargeted to edit a
    // camp_access_groups row (migration 097) instead of one member's own
    // access_preset/section_access columns — a named, reusable permission
    // template instead of a one-shot per-person combination. _mode picks
    // which save path doSave() takes; everything else below (levelOf,
    // bodyHtml, wire) is shared between the two modes. User-facing text calls
    // this a "Role"; the underlying table/RPCs (camp_access_groups,
    // *_access_group) keep their original names.
    var _mode = 'member';       // 'member' | 'group'
    var _group = null;          // the camp_access_groups row being edited (group mode)

    // product_access used to be a THIRD, separately-edited checkbox list here
    // ("apps this group can open"), independent of the preset/fine-tune
    // matrix below it. That was the bug: an owner could grant a section (say
    // Billing) in the matrix while the Billing app checkbox stayed unchecked,
    // and resolve() checks products BEFORE sections, so the grant silently
    // did nothing. Switching presets made it worse — the checkbox list only
    // ever grew, never shrank, so an old preset's apps stayed checked after
    // switching to a new one. Fixed by removing the manual list entirely:
    // which apps a role opens is now ALWAYS computed from whatever the
    // preset + fine-tune matrix actually grant, so the two can never
    // disagree, and there is nothing to go stale on a preset switch.
    function computeProducts() {
        var out = [];
        C().APPS.forEach(function (app) {
            var grantsSomething = C().forApp(app.key).some(function (c) { return levelOf(c.key) !== 'none'; });
            if (grantsSomething) out.push(app.key);
        });
        return out;
    }

    function C() { return window.CampistryCapabilities; }
    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : s;
        return d.innerHTML.replace(/"/g, '&quot;');
    }

    // ── what the CAMP bought ────────────────────────────────────────────────
    //
    // The entitlement is a ceiling above everything on this screen. resolve()
    // checks it BEFORE the owner/admin bypass and before any per-staff rule, so
    // a capability the camp has no entitlement for resolves to 'none' no matter
    // what is set here.
    //
    // Without this the screen lies: an owner could set Health to Edit for their
    // nurse, save it, see it saved — and the nurse would still get nothing,
    // with no indication anywhere of why. So unentitled sections are shown
    // LOCKED rather than hidden (the same choice made everywhere else in the
    // product) and cannot be set.
    //
    // Cached for the life of the page. Null until known, which reads as '{}' —
    // nothing locked. Failing open matches the rest of the access system: the
    // resolver is the real boundary and this screen only reports it.
    var _ent = null;
    var _entPending = null;

    function entOf() { return _ent || {}; }

    /**
     * Where the entitlement comes from.
     *
     * NOT from window.CampistrySections: that module is loaded on neither of
     * the two pages that host this editor (dashboard.html and
     * team_access_setup.html — the latter says so explicitly in a comment). It
     * is still preferred when present, because on such a page it has already
     * been fetched; otherwise this fetches get_my_access itself.
     *
     * Everything here degrades to "nothing locked" — an unapplied migration, an
     * old get_my_access with no entitlements field, a network blip. The editor
     * then behaves exactly as it did before, which is the right failure: the
     * resolver is still the boundary, and this screen is only reporting it.
     */
    function loadEntitlements() {
        if (_ent) return Promise.resolve(_ent);
        if (_entPending) return _entPending;
        try {
            var S = window.CampistrySections;
            if (S && S.entitlements) { _ent = S.entitlements() || {}; return Promise.resolve(_ent); }
        } catch (_) {}
        var d = window.CampistryDB;
        var client = d && d.getClient && d.getClient();
        var campId = d && d.getCampId && d.getCampId();
        if (!client || !campId) { _ent = {}; return Promise.resolve(_ent); }
        _entPending = client.rpc('get_my_access', { p_camp_id: campId }).then(function (r) {
            var v = r && r.data && r.data.entitlements;
            _ent = (v && typeof v === 'object') ? v : {};
            _entPending = null;
            return _ent;
        }, function () { _ent = {}; _entPending = null; return _ent; });
        return _entPending;
    }

    /** Is this capability covered by what the camp bought? */
    function capEntitled(key) {
        var cap = C().get ? C().get(key) : null;
        if (!cap) cap = C().all().filter(function (c) { return c.key === key; })[0];
        if (!cap) return true;                       // not catalogued -> not gated
        return C().entitled(cap, entOf());
    }

    /**
     * The level currently STORED for a capability: an explicit override, else
     * the preset's value, else off. This is what the controls edit.
     */
    function levelOf(key) {
        if (Object.prototype.hasOwnProperty.call(_overrides, key)) return _overrides[key];
        if (_preset) return C().expandPreset(_preset)[key] || 'none';
        return 'none';
    }

    /**
     * The level this person will ACTUALLY get. Same as levelOf except that an
     * unentitled capability is always 'none'. Used for anything the owner reads
     * as a promise — the on-count, and the control that shows as selected.
     */
    function effectiveLevel(key) {
        return capEntitled(key) ? levelOf(key) : 'none';
    }

    /**
     * Apps whose sections show in the fine-tune matrix. Member mode still
     * filters to the apps that member's own product_access already allows
     * (set elsewhere, e.g. at invite) — no point showing controls for an app
     * they can't open at all. Role (group) mode shows every app, unfiltered:
     * which apps a role opens is now DERIVED from the matrix (computeProducts),
     * so filtering the matrix by that same derived value would make an app
     * disappear the moment nothing in it was on yet — there'd be no way to
     * grant its first section.
     */
    function visibleApps() {
        if (_mode === 'group') return C().APPS;
        var products = (_member && _member.product_access) || [];
        return C().APPS.filter(function (app) {
            return !products.length || products.indexOf(app.key) >= 0;
        });
    }

    // ── rendering ────────────────────────────────────────────────────────────

    A.open = function (member, onSaved) {
        if (!C()) { alert('Access registry not loaded'); return; }
        _mode = 'member';
        _member = member || {};
        _preset = _member.access_preset || null;
        _overrides = Object.assign({}, _member.section_access || {});
        _advanced = false;
        _onSaved = onSaved || null;

        // An owner or admin is ungated by design; offering them toggles would
        // imply the toggles do something.
        if (_member.role === 'owner' || _member.role === 'admin') {
            showAdminNotice();
            return;
        }
        drawWhenEntitlementsKnown();
    };

    /**
     * Create or edit a named, reusable Access Group (camp_access_groups).
     * group = {id?, name, product_access, access_preset, section_access} —
     * id absent means creating a new one. onSaved(group) fires after a
     * successful save with the group's fresh id/name folded in.
     */
    A.openForGroup = function (group, campId, onSaved) {
        if (!C()) { alert('Access registry not loaded'); return; }
        _mode = 'group';
        _group = group || {};
        _member = { campId: campId };  // carried through to doSave's RPC call
        _preset = _group.access_preset || null;
        _overrides = Object.assign({}, _group.section_access || {});
        _advanced = false;
        _onSaved = onSaved || null;
        drawWhenEntitlementsKnown();
    };

    // Draw straight away so the modal never waits on a network call, then
    // redraw once the entitlement is known so the locks appear. Nothing is
    // locked in between, and doSave() scrubs unentitled sections regardless —
    // so a fast click before the fetch lands cannot save a false claim.
    function drawWhenEntitlementsKnown() {
        var known = !!_ent;
        draw();
        if (known) return;
        loadEntitlements().then(function () {
            if (document.getElementById('accessSettingsModal')) redraw();
        });
    }

    function shell(bodyHtml, footHtml) {
        var old = document.getElementById('accessSettingsModal');
        if (old) old.remove();
        var m = document.createElement('div');
        m.id = 'accessSettingsModal';
        m.className = 'modal-overlay';
        m.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);' +
            'display:flex;align-items:center;justify-content:center;padding:18px;';
        // As large as the viewport reasonably allows — this is a dense
        // multi-app/multi-section matrix, and a small modal made it hard to
        // scan. Capped at 1300px so it doesn't stretch absurdly wide on huge
        // monitors, but otherwise fills nearly the whole screen.
        m.innerHTML =
            '<div style="background:#fff;border-radius:16px;width:min(1300px,96vw);height:92vh;' +
            'display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.28);">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;' +
                'padding:16px 22px;border-bottom:1px solid #E2E8F0;">' +
                    (_mode === 'group'
                        ? '<div><h2 style="margin:0;font-size:1.05rem;font-weight:700;color:#0F172A;">' +
                          esc(_group.id ? 'Edit role' : 'New role') + '</h2>' +
                          '<p style="margin:2px 0 0;font-size:.78rem;color:#64748B;">A named, reusable permission set — assign it to any number of staff.</p></div>'
                        : '<div><h2 style="margin:0;font-size:1.05rem;font-weight:700;color:#0F172A;">What ' +
                          esc(_member.display_name || _member.name || 'this person') + ' can open</h2>' +
                          '<p style="margin:2px 0 0;font-size:.78rem;color:#64748B;">' +
                          esc(_member.email || '') + '</p></div>') +
                    '<button id="asClose" style="border:none;background:none;font-size:1.5rem;line-height:1;' +
                        'color:#94A3B8;cursor:pointer;">&times;</button>' +
                '</div>' +
                '<div id="asBody" style="padding:20px 22px;overflow-y:auto;flex:1;">' + bodyHtml + '</div>' +
                '<div style="display:flex;justify-content:flex-end;gap:9px;padding:14px 22px;' +
                'border-top:1px solid #E2E8F0;">' + footHtml + '</div>' +
            '</div>';
        document.body.appendChild(m);
        document.getElementById('asClose').addEventListener('click', function () { m.remove(); });
        var down = false;
        m.addEventListener('mousedown', function (e) { down = (e.target === m); });
        m.addEventListener('click', function (e) { if (e.target === m && down) m.remove(); });
        return m;
    }

    function showAdminNotice() {
        shell(
            '<div style="padding:10px 0;font-size:.88rem;color:#334155;line-height:1.6;">' +
            '<strong>' + esc(_member.role === 'owner' ? 'Owners' : 'Admins') + ' always have full access.</strong><br>' +
            'Section limits deliberately don\'t apply to them — otherwise an owner could lock ' +
            'themselves out of their own camp with no way back in. To restrict this person, ' +
            'change their role first.</div>',
            '<button class="btn-secondary" onclick="document.getElementById(\'accessSettingsModal\').remove()">Close</button>'
        );
    }

    function draw() {
        var m = shell(bodyHtml(), footHtml());
        wire(m);
    }

    function redraw() {
        var body = document.getElementById('asBody');
        if (!body) { draw(); return; }
        body.innerHTML = bodyHtml();
        wire(document.getElementById('accessSettingsModal'));
    }

    function bodyHtml() {
        var Cc = C();
        var unconfigured = !_preset && !Object.keys(_overrides).length;
        var matched = unconfigured ? null : Cc.matchPreset({
            role: _member.role, products: null, preset: _preset, overrides: _overrides
        });

        var h = '';

        if (_mode === 'group') {
            h += '<div style="margin-bottom:16px;"><label style="display:block;font-size:.68rem;font-weight:700;' +
                 'color:#94A3B8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Role name</label>' +
                 '<input id="agName" type="text" value="' + esc(_group.name || '') + '" placeholder="e.g. Office Admin" ' +
                 'style="width:100%;padding:9px 12px;border-radius:9px;border:1.5px solid #E2E8F0;font:inherit;font-size:.88rem;box-sizing:border-box;"></div>';

            // Which apps this role opens is no longer a separate choice — it's
            // whatever the preset/fine-tune matrix below actually grants
            // something in, shown here read-only so it's still visible at a
            // glance without being a second, independently-editable field
            // that could disagree with the matrix.
            var liveProducts = computeProducts();
            h += '<div style="margin-bottom:16px;"><div style="font-size:.68rem;font-weight:700;color:#94A3B8;' +
                 'text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Apps this role opens</div>';
            h += '<div style="font-size:.82rem;color:#334155;">' +
                 (liveProducts.length
                     ? liveProducts.map(function (k) {
                           var app = Cc.APPS.filter(function (a) { return a.key === k; })[0];
                           return esc(app ? app.label : k);
                       }).join(', ')
                     : '<span style="color:#94A3B8;">Nothing yet — pick a role below or turn on a section.</span>') +
                 '</div></div>';
        }

        // ── simple: the preset picker ──
        h += '<div style="font-size:.68rem;font-weight:700;color:#94A3B8;text-transform:uppercase;' +
             'letter-spacing:.05em;margin-bottom:9px;">Start from a role</div>';
        h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(214px,1fr));gap:8px;">';

        h += presetCard('__none__', 'Full access to their apps',
            'No section limits. This is how every account worked before section access existed.',
            unconfigured);
        Cc.PRESETS.filter(function (p) { return p.key !== 'full'; }).forEach(function (p) {
            // A role is only as good as the plan behind it. 'Nurse' grants
            // health.* — pick it at a camp without Health and the person gets
            // nothing, which is baffling unless the card says so.
            var exp = Cc.expandPreset(p.key);
            var granted = 0, reachable = 0;
            Cc.all().forEach(function (c) {
                if ((exp[c.key] || 'none') === 'none') return;
                granted++;
                if (capEntitled(c.key)) reachable++;
            });
            var note = '';
            if (granted && !reachable) note = ' — nothing in this role is in the camp’s plan';
            else if (granted && reachable < granted) {
                note = ' — ' + (granted - reachable) + ' of its ' + granted + ' sections are not in the plan';
            }
            h += presetCard(p.key, p.label, p.desc + note, !unconfigured && matched === p.key);
        });
        if (!unconfigured && !matched) {
            h += presetCard('__custom__', 'Custom', 'Your own combination, set below.', true);
        }
        h += '</div>';

        // ── advanced: the full matrix ──
        // Count what this person will ACTUALLY get, not what is stored — an
        // owner reads this number as a promise.
        var onCount = 0, lockedCount = 0;
        Cc.all().forEach(function (c) {
            if (effectiveLevel(c.key) !== 'none') onCount++;
            if (!capEntitled(c.key)) lockedCount++;
        });

        h += '<div style="margin-top:20px;border-top:1px solid #E2E8F0;padding-top:14px;">';
        // A plain text link here is easy to miss — this is the ONE place an
        // owner can see and change exactly which sections someone gets, so it
        // needs to read as a real, clickable control rather than a footnote.
        h += '<button id="asToggleAdv" style="width:100%;text-align:left;border:1.5px solid ' +
             (_advanced ? '#4F46E5' : '#E2E8F0') + ';background:' + (_advanced ? '#EEF2FF' : '#F8FAFC') +
             ';border-radius:10px;padding:11px 14px;cursor:pointer;' +
             'font:inherit;font-size:.85rem;font-weight:700;color:#4F46E5;display:flex;align-items:center;gap:8px;">' +
             '<span style="display:inline-block;transform:rotate(' + (_advanced ? '90' : '0') + 'deg);transition:transform .15s;">▸</span>' +
             'Fine-tune section by section' +
             (unconfigured ? '' : ' <span style="font-weight:500;color:#64748B;">— ' + onCount + ' of ' + Cc.all().length + ' on</span>') +
             '<span style="margin-left:auto;font-weight:400;color:#94A3B8;font-size:.75rem;">' + (_advanced ? 'Hide' : 'Advanced — apps &amp; sections') + '</span>' +
             '</button>';

        if (_advanced) {
            if (unconfigured) {
                h += '<p style="font-size:.78rem;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;' +
                     'border-radius:9px;padding:9px 12px;margin:12px 0 0;line-height:1.55;">' +
                     'This person currently has <strong>full access</strong>. Setting any section below ' +
                     'switches them to explicit access — anything you leave off becomes off.</p>';
            }
            if (lockedCount) {
                h += '<p style="font-size:.78rem;color:#334155;background:#F8FAFC;border:1px solid #E2E8F0;' +
                     'border-radius:9px;padding:9px 12px;margin:12px 0 0;line-height:1.55;">' +
                     '<strong>' + lockedCount + ' section' + (lockedCount === 1 ? '' : 's') +
                     ' marked “not in plan”.</strong> Those are not part of this camp’s plan, so they ' +
                     'cannot be given to anyone — not even an owner. They are shown rather than hidden so ' +
                     'it is clear what exists; to change what the camp has, the plan itself has to change.</p>';
            }
            h += '<div style="margin-top:14px;">';
            visibleApps().forEach(function (app) {
                h += '<div style="margin-bottom:16px;">';
                h += '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:7px;">' +
                     '<strong style="font-size:.85rem;color:#0F172A;">' + esc(app.label) + '</strong>' +
                     '<span style="font-size:.72rem;color:#94A3B8;">' + esc(app.hint || '') + '</span>' +
                     '<button data-appall="' + esc(app.key) + '" data-lvl="edit" style="margin-left:auto;border:none;' +
                     'background:none;font:inherit;font-size:.72rem;color:#4F46E5;cursor:pointer;">All on</button>' +
                     '<button data-appall="' + esc(app.key) + '" data-lvl="none" style="border:none;background:none;' +
                     'font:inherit;font-size:.72rem;color:#94A3B8;cursor:pointer;">All off</button>' +
                     '</div>';
                app.sections.forEach(function (s) {
                    var key = app.key + '.' + s.key;
                    var entitled = capEntitled(key);
                    var lvl = effectiveLevel(key);
                    var levels = Cc.levelsFor(key);
                    h += '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;' +
                         'border-bottom:1px solid #F1F5F9;' + (entitled ? '' : 'opacity:.55;') + '">';
                    h += '<div style="flex:1;min-width:0;"><div style="font-size:.82rem;color:#334155;font-weight:500;">' +
                         esc(s.label) +
                         (s.sensitive ? ' <span style="font-size:.62rem;font-weight:700;color:#B45309;' +
                            'background:#FFFBEB;border-radius:999px;padding:1px 6px;vertical-align:middle;">SENSITIVE</span>' : '') +
                         (entitled ? '' : ' <span style="font-size:.62rem;font-weight:700;color:#475569;' +
                            'background:#F1F5F9;border:1px solid #E2E8F0;border-radius:999px;padding:1px 6px;' +
                            'vertical-align:middle;">NOT IN PLAN</span>') +
                         '</div>' +
                         '<div style="font-size:.71rem;color:#94A3B8;">' +
                         (entitled ? esc(s.desc || '')
                                   : 'This camp’s plan does not include it — nobody can be given it.') +
                         '</div></div>';
                    h += '<div style="display:flex;gap:3px;flex-shrink:0;">';
                    levels.forEach(function (L) {
                        var on = (lvl === L);
                        var col = L === 'none' ? '#DC2626' : L === 'view' ? '#B45309' : '#059669';
                        // Unentitled: render the row read-only rather than
                        // clickable. A disabled control that shows 'None' is
                        // honest; an enabled one that silently resolves to none
                        // is the lie this whole block exists to stop.
                        h += '<button data-cap="' + esc(key) + '" data-lvl="' + L + '"' +
                             (entitled ? '' : ' disabled') +
                             ' style="font:inherit;font-size:.7rem;font-weight:600;padding:3px 10px;border-radius:7px;' +
                             'cursor:' + (entitled ? 'pointer' : 'not-allowed') + ';' +
                             'border:1px solid ' + (on ? col : '#E2E8F0') + ';' +
                             'background:' + (on ? col : '#fff') + ';color:' + (on ? '#fff' : '#64748B') + ';">' +
                             (L === 'none' ? 'None' : L === 'view' ? 'View' : 'Edit') + '</button>';
                    });
                    h += '</div></div>';
                });
                h += '</div>';
            });
            if (!visibleApps().length) {
                h += '<p style="font-size:.8rem;color:#64748B;">This person has no apps assigned yet. ' +
                     'Give them at least one under “Access to” first.</p>';
            }
            h += '</div>';
        }
        h += '</div>';
        return h;
    }

    function presetCard(key, label, desc, selected) {
        return '<button data-preset="' + esc(key) + '" style="text-align:left;cursor:pointer;font:inherit;' +
            'padding:11px 13px;border-radius:11px;background:' + (selected ? '#EEF2FF' : '#fff') + ';' +
            'border:1.5px solid ' + (selected ? '#4F46E5' : '#E2E8F0') + ';">' +
            '<div style="font-size:.83rem;font-weight:700;color:#0F172A;display:flex;align-items:center;gap:6px;">' +
            esc(label) + (selected ? '<span style="color:#4F46E5;">✓</span>' : '') + '</div>' +
            '<div style="font-size:.72rem;color:#64748B;line-height:1.45;margin-top:2px;">' + esc(desc) + '</div>' +
            '</button>';
    }

    function footHtml() {
        return '<button class="btn-secondary" id="asCancel" style="padding:9px 18px;border-radius:8px;' +
               'border:1px solid #CBD5E1;background:#fff;font:inherit;font-size:.86rem;cursor:pointer;">Cancel</button>' +
               '<button class="btn-primary" id="asSave" style="padding:9px 20px;border-radius:8px;border:none;' +
               'background:#4F46E5;color:#fff;font:inherit;font-size:.86rem;font-weight:600;cursor:pointer;">Save access</button>';
    }

    // ── interaction ──────────────────────────────────────────────────────────

    function wire(m) {
        if (!m) return;

        // The group name field is uncontrolled DOM, but bodyHtml() re-renders
        // it from _group.name on every redraw() (toggling a preset, a cap, an
        // app product...). Without syncing keystrokes back into _group.name
        // as they happen, any redraw wipes out whatever the owner had just
        // typed before they got to Save.
        var agName = document.getElementById('agName');
        if (agName) agName.oninput = function () { _group.name = agName.value; };

        var adv = document.getElementById('asToggleAdv');
        if (adv) adv.onclick = function () { _advanced = !_advanced; redraw(); };

        m.querySelectorAll('[data-preset]').forEach(function (b) {
            b.onclick = function () {
                var k = b.getAttribute('data-preset');
                if (k === '__none__') { _preset = null; _overrides = {}; }
                else if (k === '__custom__') { /* already custom — no-op */ }
                else {
                    // Picking a preset clears overrides: it's a fresh starting
                    // point, and silently keeping stale overrides on top is how
                    // someone ends up with access they didn't intend to grant.
                    // Which apps this opens is computed fresh from the new
                    // preset on the next render (computeProducts) — nothing to
                    // separately update here, and nothing left over from
                    // whatever the previous preset was.
                    _preset = k;
                    _overrides = {};
                }
                redraw();
            };
        });

        m.querySelectorAll('[data-cap]').forEach(function (b) {
            b.onclick = function () {
                var key = b.getAttribute('data-cap');
                var lvl = b.getAttribute('data-lvl');
                // The button is rendered disabled, so this is belt and braces —
                // but it is the one place a bad value would be written, so it
                // checks rather than trusting the markup.
                if (!capEntitled(key)) return;
                // First explicit toggle on an unconfigured person: freeze the
                // full access they had into overrides, so flipping ONE section
                // off doesn't silently switch every other section off too.
                //
                // "The full access they had" means what they EFFECTIVELY had:
                // recording edit on an unentitled section would write a claim
                // resolve() refuses, and would make the person look configured
                // for something the camp cannot give them.
                if (!_preset && !Object.keys(_overrides).length) {
                    C().all().forEach(function (c) {
                        if (!capEntitled(c.key)) { _overrides[c.key] = 'none'; return; }
                        _overrides[c.key] = c.viewOnly ? 'view' : 'edit';
                    });
                }
                _overrides[key] = lvl;
                redraw();
            };
        });

        m.querySelectorAll('[data-appall]').forEach(function (b) {
            b.onclick = function () {
                var app = b.getAttribute('data-appall');
                var lvl = b.getAttribute('data-lvl');
                if (!_preset && !Object.keys(_overrides).length) {
                    C().all().forEach(function (c) {
                        // Seeding from "full access" must not record a level for
                        // something the camp did not buy, or the saved overrides
                        // claim access that resolve() will refuse.
                        if (!capEntitled(c.key)) { _overrides[c.key] = 'none'; return; }
                        _overrides[c.key] = c.viewOnly ? 'view' : 'edit';
                    });
                }
                C().forApp(app).forEach(function (c) {
                    if (!capEntitled(c.key)) { _overrides[c.key] = 'none'; return; }
                    _overrides[c.key] = (c.viewOnly && lvl === 'edit') ? 'view' : lvl;
                });
                redraw();
            };
        });

        var cancel = document.getElementById('asCancel');
        if (cancel) cancel.onclick = function () { m.remove(); };
        var save = document.getElementById('asSave');
        if (save) save.onclick = function () { doSave(m, save); };
    }

    function doSave(m, btn) {
        var d = window.CampistryDB;
        var client = d && d.getClient && d.getClient();
        if (!client) { alert('Connection not ready — try again in a moment.'); return; }
        btn.disabled = true;
        btn.textContent = 'Saving…';

        // Drop overrides that merely restate the preset, so the stored record
        // stays readable and matchPreset can still recognise the preset.
        var payload = {};
        if (_preset) {
            var exp = C().expandPreset(_preset);
            Object.keys(_overrides).forEach(function (k) {
                if (_overrides[k] !== exp[k]) payload[k] = _overrides[k];
            });
        } else {
            payload = Object.assign({}, _overrides);
        }

        // Never persist a grant the entitlement refuses. The controls are
        // rendered disabled and the seeding paths already skip these, so this
        // normally changes nothing — it is here because it is the LAST point
        // before the write, and it makes the guarantee independent of the
        // entitlement fetch having landed before the owner pressed Save.
        //
        // Written as 'none' rather than deleted: the owner's intent for the
        // rest of the record is explicit, and a silent omission would read as
        // "never configured" if the camp's plan later gained that section.
        Object.keys(payload).forEach(function (k) {
            if (payload[k] !== 'none' && !capEntitled(k)) payload[k] = 'none';
        });

        if (_mode === 'group') { doSaveGroup(m, btn, client, payload); return; }

        client.rpc('set_member_access', {
            p_member_id: _member.id,
            p_preset: _preset,
            p_section_access: payload
        }).then(function (res) {
            btn.disabled = false;
            btn.textContent = 'Save access';
            if (res.error) {
                alert('Could not save: ' + res.error.message);
                return;
            }
            var r = res.data;
            if (!r || !r.success) {
                var e = r && r.error;
                alert(e === 'not_authorized' ? 'Only the camp owner or an admin can change access.'
                    : e === 'cannot_restrict_admin' ? 'Owners and admins always have full access — change their role first.'
                    : e === 'invalid_level' ? 'Something went wrong with one of the toggles. Please try again.'
                    : 'Could not save access.');
                return;
            }
            _member.access_preset = _preset;
            _member.section_access = payload;
            m.remove();
            if (_onSaved) { try { _onSaved(_member); } catch (e) {} }
        }, function () {
            btn.disabled = false;
            btn.textContent = 'Save access';
            alert('Could not save access — please try again.');
        });
    }

    function doSaveGroup(m, btn, client, payload) {
        var nameEl = document.getElementById('agName');
        var name = nameEl ? nameEl.value.trim() : '';
        if (!name) {
            alert('Give this group a name.');
            btn.disabled = false;
            btn.textContent = 'Save access';
            return;
        }
        var products = computeProducts();
        var rpc = _group.id ? 'update_access_group' : 'create_access_group';
        var args = _group.id
            ? { p_group_id: _group.id, p_name: name, p_product_access: products, p_preset: _preset, p_section_access: payload }
            : { p_camp_id: _member.campId, p_name: name, p_product_access: products, p_preset: _preset, p_section_access: payload };

        client.rpc(rpc, args).then(function (res) {
            btn.disabled = false;
            btn.textContent = 'Save access';
            if (res.error) { alert('Could not save: ' + res.error.message); return; }
            var r = res.data;
            if (!r || !r.success) {
                var e = r && r.error;
                alert(e === 'not_authorized' ? 'Only the camp owner or an admin can manage roles.'
                    : e === 'name_required' ? 'Give this group a name.'
                    : e === 'invalid_level' ? 'Something went wrong with one of the toggles. Please try again.'
                    : 'Could not save this group.');
                return;
            }
            _group.id = _group.id || r.id;
            _group.name = name;
            _group.product_access = products;
            _group.access_preset = _preset;
            _group.section_access = payload;
            m.remove();
            if (_onSaved) { try { _onSaved(_group); } catch (e) {} }
        }, function () {
            btn.disabled = false;
            btn.textContent = 'Save access';
            alert('Could not save this group — please try again.');
        });
    }

    window.CampistryAccessSettings = A;
})();
