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

    // ── group mode ──────────────────────────────────────────────────────────
    // Same preset-picker + fine-tune-matrix UI, retargeted to edit a
    // camp_access_groups row (migration 097) instead of one member's own
    // access_preset/section_access columns — a named, reusable permission
    // template instead of a one-shot per-person combination. _mode picks
    // which save path doSave() takes; everything else below (levelOf,
    // bodyHtml, wire) is shared between the two modes.
    var _mode = 'member';       // 'member' | 'group'
    var _group = null;          // the camp_access_groups row being edited (group mode)
    var _groupProducts = [];    // group mode's own product_access, edited live in this modal

    function C() { return window.CampistryCapabilities; }
    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : s;
        return d.innerHTML.replace(/"/g, '&quot;');
    }

    /**
     * The level currently shown for a capability: an explicit override, else
     * the preset's value, else off.
     */
    function levelOf(key) {
        if (Object.prototype.hasOwnProperty.call(_overrides, key)) return _overrides[key];
        if (_preset) return C().expandPreset(_preset)[key] || 'none';
        return 'none';
    }

    /** Apps this member/group can open at all — no point showing sections of the rest. */
    function visibleApps() {
        var products = _mode === 'group' ? _groupProducts : ((_member && _member.product_access) || []);
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
        draw();
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
        _groupProducts = (_group.product_access || []).slice();
        _advanced = false;
        _onSaved = onSaved || null;
        draw();
    };

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
                          esc(_group.id ? 'Edit access group' : 'New access group') + '</h2>' +
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
                 'color:#94A3B8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Group name</label>' +
                 '<input id="agName" type="text" value="' + esc(_group.name || '') + '" placeholder="e.g. Office Admin" ' +
                 'style="width:100%;padding:9px 12px;border-radius:9px;border:1.5px solid #E2E8F0;font:inherit;font-size:.88rem;box-sizing:border-box;"></div>';

            h += '<div style="margin-bottom:16px;"><div style="font-size:.68rem;font-weight:700;color:#94A3B8;' +
                 'text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Apps this group can open</div>';
            h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:7px;">';
            Cc.APPS.forEach(function (app) {
                var on = _groupProducts.indexOf(app.key) >= 0;
                h += '<label style="display:flex;align-items:center;gap:7px;font-size:.82rem;color:#334155;' +
                     'padding:7px 10px;border-radius:9px;border:1.5px solid ' + (on ? '#4F46E5' : '#E2E8F0') +
                     ';background:' + (on ? '#EEF2FF' : '#fff') + ';cursor:pointer;">' +
                     '<input type="checkbox" data-agproduct="' + esc(app.key) + '"' + (on ? ' checked' : '') + '> ' + esc(app.label) + '</label>';
            });
            h += '</div></div>';
        }

        // ── simple: the preset picker ──
        h += '<div style="font-size:.68rem;font-weight:700;color:#94A3B8;text-transform:uppercase;' +
             'letter-spacing:.05em;margin-bottom:9px;">Start from a role</div>';
        h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(214px,1fr));gap:8px;">';

        h += presetCard('__none__', 'Full access to their apps',
            'No section limits. This is how every account worked before section access existed.',
            unconfigured);
        Cc.PRESETS.filter(function (p) { return p.key !== 'full'; }).forEach(function (p) {
            h += presetCard(p.key, p.label, p.desc, !unconfigured && matched === p.key);
        });
        if (!unconfigured && !matched) {
            h += presetCard('__custom__', 'Custom', 'Your own combination, set below.', true);
        }
        h += '</div>';

        // ── advanced: the full matrix ──
        var onCount = 0;
        Cc.all().forEach(function (c) { if (levelOf(c.key) !== 'none') onCount++; });

        h += '<div style="margin-top:20px;border-top:1px solid #E2E8F0;padding-top:14px;">';
        h += '<button id="asToggleAdv" style="border:none;background:none;padding:0;cursor:pointer;' +
             'font:inherit;font-size:.84rem;font-weight:600;color:#4F46E5;display:flex;align-items:center;gap:6px;">' +
             '<span style="display:inline-block;transform:rotate(' + (_advanced ? '90' : '0') + 'deg);transition:transform .15s;">▸</span>' +
             'Fine-tune section by section' +
             (unconfigured ? '' : ' <span style="font-weight:400;color:#94A3B8;">— ' + onCount + ' of ' + Cc.all().length + ' on</span>') +
             '</button>';

        if (_advanced) {
            if (unconfigured) {
                h += '<p style="font-size:.78rem;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;' +
                     'border-radius:9px;padding:9px 12px;margin:12px 0 0;line-height:1.55;">' +
                     'This person currently has <strong>full access</strong>. Setting any section below ' +
                     'switches them to explicit access — anything you leave off becomes off.</p>';
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
                    var lvl = levelOf(key);
                    var levels = Cc.levelsFor(key);
                    h += '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;' +
                         'border-bottom:1px solid #F1F5F9;">';
                    h += '<div style="flex:1;min-width:0;"><div style="font-size:.82rem;color:#334155;font-weight:500;">' +
                         esc(s.label) +
                         (s.sensitive ? ' <span style="font-size:.62rem;font-weight:700;color:#B45309;' +
                            'background:#FFFBEB;border-radius:999px;padding:1px 6px;vertical-align:middle;">SENSITIVE</span>' : '') +
                         '</div>' +
                         '<div style="font-size:.71rem;color:#94A3B8;">' + esc(s.desc || '') + '</div></div>';
                    h += '<div style="display:flex;gap:3px;flex-shrink:0;">';
                    levels.forEach(function (L) {
                        var on = (lvl === L);
                        var col = L === 'none' ? '#DC2626' : L === 'view' ? '#B45309' : '#059669';
                        h += '<button data-cap="' + esc(key) + '" data-lvl="' + L + '" ' +
                             'style="font:inherit;font-size:.7rem;font-weight:600;padding:3px 10px;border-radius:7px;cursor:pointer;' +
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

        var adv = document.getElementById('asToggleAdv');
        if (adv) adv.onclick = function () { _advanced = !_advanced; redraw(); };

        m.querySelectorAll('[data-agproduct]').forEach(function (cb) {
            cb.onchange = function () {
                var key = cb.getAttribute('data-agproduct');
                var i = _groupProducts.indexOf(key);
                if (cb.checked && i < 0) _groupProducts.push(key);
                else if (!cb.checked && i >= 0) _groupProducts.splice(i, 1);
                redraw();
            };
        });

        m.querySelectorAll('[data-preset]').forEach(function (b) {
            b.onclick = function () {
                var k = b.getAttribute('data-preset');
                if (k === '__none__') { _preset = null; _overrides = {}; }
                else if (k === '__custom__') { /* already custom — no-op */ }
                else {
                    // Picking a preset clears overrides: it's a fresh starting
                    // point, and silently keeping stale overrides on top is how
                    // someone ends up with access they didn't intend to grant.
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
                // First explicit toggle on an unconfigured person: freeze the
                // full access they had into overrides, so flipping ONE section
                // off doesn't silently switch every other section off too.
                if (!_preset && !Object.keys(_overrides).length) {
                    C().all().forEach(function (c) {
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
                    C().all().forEach(function (c) { _overrides[c.key] = c.viewOnly ? 'view' : 'edit'; });
                }
                C().forApp(app).forEach(function (c) {
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
        var rpc = _group.id ? 'update_access_group' : 'create_access_group';
        var args = _group.id
            ? { p_group_id: _group.id, p_name: name, p_product_access: _groupProducts, p_preset: _preset, p_section_access: payload }
            : { p_camp_id: _member.campId, p_name: name, p_product_access: _groupProducts, p_preset: _preset, p_section_access: payload };

        client.rpc(rpc, args).then(function (res) {
            btn.disabled = false;
            btn.textContent = 'Save access';
            if (res.error) { alert('Could not save: ' + res.error.message); return; }
            var r = res.data;
            if (!r || !r.success) {
                var e = r && r.error;
                alert(e === 'not_authorized' ? 'Only the camp owner or an admin can manage access groups.'
                    : e === 'name_required' ? 'Give this group a name.'
                    : e === 'invalid_level' ? 'Something went wrong with one of the toggles. Please try again.'
                    : 'Could not save this group.');
                return;
            }
            _group.id = _group.id || r.id;
            _group.name = name;
            _group.product_access = _groupProducts.slice();
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
