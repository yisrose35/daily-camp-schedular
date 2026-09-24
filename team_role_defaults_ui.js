// team_role_defaults_ui.js — "what a whole job / one person can open".
//
// Extracted from campistry_team_access.html (that page still works standalone
// — it just calls TeamRoleDefaults.mount('root') on load now) so the exact
// same by-job/by-person editor can ALSO be embedded as a card on
// team_access_setup.html: the request that drove this split was "combine
// 'manage' and 'what each job could do' into one place" — two separate pages
// before, now one shared module mounted in both, with team_access_setup.html
// as the actual single page an owner needs to visit.
window.TeamRoleDefaults = (function () {
    'use strict';

    var root = null;
    var CAPS = null;
    var _embedded = false; // true when mounted as a card on another page (no page-level header/back-link of its own)

    // =========================================================================
    // The owner's access screen.
    //
    // WHAT CHANGED AND WHY: the first version showed all 62 sections across nine
    // apps at once, four to a row, each with its own controls. It was complete
    // and unreadable — you could not tell an app heading from a section, and
    // finding the one row you came for meant scanning a wall. Three changes:
    //
    //   * THREE NUMBERED STEPS. Who, then a starting role, then optional
    //     fine-tuning. Most camps will never reach step 3.
    //   * PRESETS THAT MATCH THE JOB. Eleven presets is too many to weigh when
    //     you are configuring schedulers; the ones that suit the job come
    //     first, the rest sit behind "show all". See C.presetsForRole.
    //   * THE MATRIX COLLAPSES. One row per app with a count, opened on
    //     demand — nine rows instead of sixty-two — and one section per line
    //     rather than a grid, so it reads as a list.
    //
    // The model underneath is unchanged. Two things to edit:
    //
    //   BY JOB     "what does a Scheduler get here" — covers everyone with that
    //              title, including people hired later. This is the gap: before,
    //              access was per-person only, so a camp that restricted its
    //              four schedulers got a fifth with the run of the place,
    //              because an unconfigured user keeps full access.
    //   BY PERSON  "this scheduler also does bussing" — an exception on top of
    //              the job, not a re-specification: anything left alone here
    //              keeps following the job.
    //
    // A person's own setting always beats the job default. Full precedence in
    // ENTITLEMENTS_DESIGN.md §9 and migration 165.
    // =========================================================================


    // Jobs that can carry a default. Owners and admins are ungated by design,
    // so a default for them would be a setting that silently does nothing —
    // migration 165's CHECK constraint refuses them for the same reason.
    var JOBS = [
        { key: 'manager',   label: 'Manager',   desc: 'Runs part of the camp day to day.' },
        { key: 'scheduler', label: 'Scheduler', desc: 'Builds and adjusts the schedule.' },
        { key: 'counselor', label: 'Counselor', desc: 'Bunk staff. Never more than view.' },
        { key: 'viewer',    label: 'Viewer',    desc: 'Can look, never change.' }
    ];

    var _mode = 'job';
    var _job = null;
    var _person = null;
    var _members = [];
    var _roleDefaults = {};
    var _ent = {};
    var _draft = null;
    var _open = {};            // app key -> expanded?
    var _allPresets = false;   // "show all roles" revealed?
    var _filter = '';
    var _msg = '', _msgKind = '';
    var _dirty = false;

    function client() {
        var d = window.CampistryDB;
        return (d && d.getClient && d.getClient()) ||
               (window.supabase && typeof window.supabase.rpc === 'function' ? window.supabase : null);
    }
    function campId() {
        var d = window.CampistryDB;
        return d && d.getCampId ? d.getCampId() : null;
    }
    function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
    function memberName(m) { return m.display_name || m.name || m.full_name || m.email || 'Staff member'; }
    function sortMembers(rows) {
        return rows.slice().sort(function (a, b) { return memberName(a).localeCompare(memberName(b)); });
    }
    function gate(title, body) {
        root.innerHTML = '<div class="gate"><h1 style="font-family:Fraunces,serif;font-size:1.3rem;margin-bottom:10px;">' +
            esc(title) + '</h1><p>' + body + '</p></div>';
    }

    // ── the entitlement ceiling ─────────────────────────────────────────────
    // resolve() checks this ABOVE the owner/admin bypass, so a section the camp
    // has no entitlement for resolves to 'none' whatever is set here. Offering
    // it would promise access the product cannot deliver.
    function entitled(key) {
        var cap = CAPS.get(key);
        return cap ? CAPS.entitled(cap, _ent) : true;
    }
    function levelOf(key) {
        if (!_draft) return 'none';
        if (Object.prototype.hasOwnProperty.call(_draft.overrides, key)) return _draft.overrides[key];
        if (_draft.preset) return CAPS.expandPreset(_draft.preset)[key] || 'none';
        return 'none';
    }
    function effective(key) { return entitled(key) ? levelOf(key) : 'none'; }
    function isEmptyDraft(d) { return !d || (!d.preset && !Object.keys(d.overrides || {}).length); }

    function currentRole() {
        return _mode === 'job' ? _job : (_person && _person.role) || null;
    }

    // ── render ──────────────────────────────────────────────────────────────

    function render() {
        var h = _embedded ? '' :
            '<header><h1>Teams &amp; Access</h1>' +
            '<a class="back" href="dashboard.html">&larr; Back to dashboard</a></header>';
        h += '<p class="lede">Set access once for a whole job, then make exceptions for individual ' +
            'people. A person’s own setting always beats their job’s. Anything outside your ' +
            'camp’s plan is shown locked — it cannot be given to anyone, including you.</p>';

        // ── step 1: who ──
        h += '<div class="card"><div class="acc-step" style="margin-bottom:0;">' +
             stepHead(1, 'Who are you setting up?', '', true) +
             '<div class="acc-step-body">' +
             '<div class="tabs" style="margin-bottom:14px;">' +
               '<button class="tab' + (_mode === 'job' ? ' on' : '') + '" data-mode="job">A whole job</button>' +
               '<button class="tab' + (_mode === 'person' ? ' on' : '') + '" data-mode="person">One person</button>' +
             '</div>' +
             (_mode === 'job' ? jobPicker() : personPicker()) +
             '</div></div></div>';

        // ── steps 2 and 3 only once a subject is chosen ──
        if (_draft) {
            h += '<div class="card">' + subjectHead() + presetStep() + '</div>';
            h += '<div class="card">' + matrixStep() + '</div>';
            h += actionBar();
        }

        root.innerHTML = h;
        wire();
    }

    function stepHead(n, title, desc, active) {
        return '<div class="acc-step-hd">' +
               '<span class="acc-step-n' + (active ? '' : ' off') + '">' + n + '</span>' +
               '<span class="acc-step-t">' + esc(title) + '</span>' +
               (desc ? '<span class="acc-step-d">' + esc(desc) + '</span>' : '') +
               '</div>';
    }

    function jobPicker() {
        var h = '<p class="acc-step-d" style="margin-bottom:12px;">Applies to everyone with that title, ' +
                'including people you hire later. Owners and admins aren’t listed — they always ' +
                'have full access, so a default for them would do nothing.</p><div class="acc-picker">';
        JOBS.forEach(function (j) {
            var d = _roleDefaults[j.key];
            var set = !isEmptyDraft(d);
            var n = _members.filter(function (m) { return m.role === j.key; }).length;
            h += '<button class="acc-pick' + (_job === j.key ? ' on' : '') + '" data-job="' + esc(j.key) + '">' +
                 '<div class="acc-pick-nm">' + esc(j.label) + '</div>' +
                 '<div class="acc-pick-mt">' + esc(j.desc) + '</div>' +
                 '<span class="acc-pick-tag' + (set ? ' set' : '') + '">' +
                   (set ? esc(summarize(d)) : 'No limits set') + '</span>' +
                 (n ? ' <span class="acc-pick-tag">' + n + ' on staff</span>' : '') +
                 '</button>';
        });
        return h + '</div>';
    }

    function personPicker() {
        if (!_members.length) {
            return '<p class="acc-muted">No staff yet. Invite people from Team &amp; Access on the ' +
                   'dashboard, then come back to fine-tune what they can open.</p>';
        }
        var h = '<p class="acc-step-d" style="margin-bottom:12px;">An exception on top of the person’s ' +
                'job. Anything you leave alone keeps following the job — so to give one scheduler ' +
                'bussing as well, set only the bussing sections.</p><div class="acc-picker">';
        _members.forEach(function (m) {
            var ungated = (m.role === 'owner' || m.role === 'admin');
            var own = !isEmptyDraft({ preset: m.access_preset, overrides: m.section_access || {} });
            h += '<button class="acc-pick' + (_person && _person.id === m.id ? ' on' : '') + '" ' +
                 'data-person="' + esc(m.id) + '">' +
                 '<div class="acc-pick-nm">' + esc(memberName(m)) + '</div>' +
                 '<div class="acc-pick-mt">' + esc(m.role || 'staff') + '</div>' +
                 '<span class="acc-pick-tag' + (own ? ' set' : '') + '">' +
                   (ungated ? 'Always full access' : own ? 'Has its own exceptions' : 'Follows the job') +
                 '</span></button>';
        });
        return h + '</div>';
    }

    function summarize(d) {
        if (isEmptyDraft(d)) return 'No limits set';
        if (d.preset) {
            var p = CAPS.preset(d.preset);
            return (p && p.label) || d.preset;
        }
        var n = Object.keys(d.overrides).filter(function (k) { return d.overrides[k] !== 'none'; }).length;
        return n + ' section' + (n === 1 ? '' : 's') + ' on';
    }

    function subjectHead() {
        var who = _mode === 'job'
            ? 'everyone with the title ' + ((JOBS.filter(function (j) { return j.key === _job; })[0] || {}).label || _job)
            : memberName(_person);
        var h = '<p class="acc-muted" style="margin-bottom:14px;">Setting up <strong style="color:#0F172A;">' +
                esc(who) + '</strong></p>';

        if (_mode === 'person' && (_person.role === 'owner' || _person.role === 'admin')) {
            return h + '<div class="acc-banner warn"><strong>' +
                esc(_person.role === 'owner' ? 'Owners' : 'Admins') + ' always have full access.</strong> ' +
                'Section limits deliberately don’t apply to them — otherwise an owner could lock ' +
                'themselves out of their own camp with no way back in. To restrict this person, change ' +
                'their role first.</div>';
        }
        if (_mode === 'person') {
            var jd = _roleDefaults[_person.role];
            h += '<div class="acc-banner info">Their job (<strong>' + esc(_person.role || 'staff') + '</strong>) ' +
                 (isEmptyDraft(jd)
                    ? 'has no limits set, so anything you leave off here is off for them.'
                    : 'gives them <strong>' + esc(summarize(jd)) + '</strong>. Anything you leave alone ' +
                      'here keeps following it.') + '</div>';
        }
        return h;
    }

    // ── step 2: start from a role ───────────────────────────────────────────
    function presetStep() {
        if (_mode === 'person' && (_person.role === 'owner' || _person.role === 'admin')) return '';

        var role = currentRole();
        var list = CAPS.presetsForRole(role);
        var recs = list.filter(function (x) { return x.recommended; });
        var rest = list.filter(function (x) { return !x.recommended; });

        var h = stepHead(2, 'Start from a role', 'Pick the closest fit. You can adjust anything after.', true) +
                '<div class="acc-step-body"><div class="acc-picker">';

        // "No limits" first, as its own thing rather than a preset called 'full'.
        h += presetCard('__none__', 'No limits',
            'Everything their apps allow. This is how every account worked before access limits existed.',
            isEmptyDraft(_draft), false);

        recs.forEach(function (x) {
            h += presetCard(x.preset.key, x.preset.label, x.preset.desc,
                            _draft.preset === x.preset.key, true);
        });
        if (_allPresets) {
            rest.forEach(function (x) {
                h += presetCard(x.preset.key, x.preset.label, x.preset.desc,
                                _draft.preset === x.preset.key, false);
            });
        }
        h += '</div>';

        if (rest.length && !_allPresets) {
            h += '<button class="acc-btn-ghost" id="showAll" style="margin-top:10px;padding:7px 14px;font-size:.82rem;">' +
                 'Show ' + rest.length + ' more role' + (rest.length === 1 ? '' : 's') + '</button>';
        }
        if (!_draft.preset && Object.keys(_draft.overrides).length) {
            h += '<p class="acc-muted" style="margin-top:10px;">Custom — set section by section below.</p>';
        }
        return h + '</div>';
    }

    function presetCard(key, label, desc, on, rec) {
        // A role is only as useful as the plan behind it: 'Nurse' grants
        // health.*, so at a camp without Health it gives nothing. Saying so on
        // the card saves someone picking it and assuming the screen is broken.
        var note = '';
        if (key !== '__none__') {
            var exp = CAPS.expandPreset(key);
            var granted = 0, reach = 0;
            CAPS.all().forEach(function (c) {
                if ((exp[c.key] || 'none') === 'none') return;
                granted++;
                if (entitled(c.key)) reach++;
            });
            if (granted && !reach) note = 'Nothing in this role is in your plan';
            else if (granted && reach < granted) note = (granted - reach) + ' of its ' + granted + ' sections aren’t in your plan';
        }
        return '<button class="acc-pick' + (on ? ' on' : '') + '" data-preset="' + esc(key) + '">' +
            '<div class="acc-pick-nm">' + esc(label) + (on ? ' ✓' : '') + '</div>' +
            '<div class="acc-pick-mt">' + esc(desc) + '</div>' +
            (rec ? '<span class="acc-pick-tag rec">Suits this job</span>' : '') +
            (note ? ' <span class="acc-pick-tag">' + esc(note) + '</span>' : '') +
            '</button>';
    }

    // ── step 3: fine-tune ───────────────────────────────────────────────────
    function matrixStep() {
        if (_mode === 'person' && (_person.role === 'owner' || _person.role === 'admin')) return '';

        var on = 0, locked = 0;
        CAPS.all().forEach(function (c) {
            if (effective(c.key) !== 'none') on++;
            if (!entitled(c.key)) locked++;
        });

        var h = stepHead(3, 'Fine-tune, if you need to',
                         on + ' of ' + CAPS.all().length + ' sections on', false) +
                '<div class="acc-step-body">';

        if (locked) {
            h += '<div class="acc-banner info">' + locked + ' section' + (locked === 1 ? '' : 's') +
                 ' marked <strong>not in plan</strong> — not part of your camp’s plan, so they ' +
                 'can’t be given to anyone. Shown rather than hidden so it’s clear what exists.</div>';
        }

        h += '<input class="acc-search" id="filter" placeholder="Find a section… (e.g. billing, swim, meds)" ' +
             'value="' + esc(_filter) + '">';

        var q = _filter.trim().toLowerCase();
        var shown = 0;
        h += '<div class="acc-apps">';
        CAPS.APPS.forEach(function (app) {
            var secs = CAPS.forApp(app.key);
            if (!secs.length) return;
            var hits = q ? secs.filter(function (c) {
                return (c.label || '').toLowerCase().indexOf(q) >= 0 ||
                       (app.label || '').toLowerCase().indexOf(q) >= 0 ||
                       c.key.toLowerCase().indexOf(q) >= 0;
            }) : secs;
            if (!hits.length) return;
            shown++;

            // A search opens what it matched — otherwise you would search and
            // then still have to click the app open to see the hit.
            var open = q ? true : !!_open[app.key];
            var appOn = secs.filter(function (c) { return effective(c.key) !== 'none'; }).length;

            h += '<div class="acc-app">' +
                 '<button class="acc-app-hd" aria-expanded="' + (open ? 'true' : 'false') + '" ' +
                   'data-app="' + esc(app.key) + '"' + (q ? ' disabled' : '') + '>' +
                   '<span class="acc-caret">▸</span>' +
                   '<span class="acc-app-nm">' + esc(app.label) + '</span>' +
                   '<span class="acc-app-ct">' + appOn + ' of ' + secs.length + ' on</span>' +
                 '</button>';
            if (open) {
                h += '<div class="acc-app-body">' +
                     '<div style="display:flex;gap:6px;padding:8px 0 2px;">' +
                       '<button class="acc-mini" data-all="' + esc(app.key) + '">Turn all on</button>' +
                       '<button class="acc-mini" data-none="' + esc(app.key) + '">Turn all off</button>' +
                     '</div>';
                hits.forEach(function (cap) {
                    var ok = entitled(cap.key);
                    var lvl = effective(cap.key);
                    h += '<div class="acc-row' + (ok ? '' : ' locked') + '">' +
                         '<div class="acc-row-main">' +
                           '<div class="acc-row-nm">' + esc(cap.label) +
                             (cap.sensitive ? ' <span class="acc-chip sens">SENSITIVE</span>' : '') +
                             (ok ? '' : ' <span class="acc-chip plan">NOT IN PLAN</span>') + '</div>' +
                           (cap.desc ? '<div class="acc-row-d">' + esc(cap.desc) + '</div>' : '') +
                         '</div><div class="acc-seg">';
                    CAPS.levelsFor(cap.key).forEach(function (L) {
                        h += '<button class="' + L + (lvl === L ? ' on' : '') + '"' +
                             ' data-cap="' + esc(cap.key) + '" data-lvl="' + L + '"' +
                             (ok ? '' : ' disabled') + '>' +
                             (L === 'none' ? 'Off' : L === 'view' ? 'View' : 'Edit') + '</button>';
                    });
                    h += '</div></div>';
                });
                h += '</div>';
            }
            h += '</div>';
        });
        h += '</div>';
        if (!shown) h += '<p class="acc-muted" style="margin-top:12px;">Nothing matches “' + esc(_filter) + '”.</p>';
        return h + '</div>';
    }

    function actionBar() {
        if (_mode === 'person' && (_person.role === 'owner' || _person.role === 'admin')) {
            return '<div class="acc-bar"><span class="acc-bar-sum">Nothing to set for this person.</span>' +
                   '<button class="acc-btn-ghost" id="cancel">Close</button></div>';
        }
        var sum = _mode === 'job'
            ? 'Applies to everyone with this title, now and later.'
            : 'Applies to this person only.';
        return '<div class="acc-bar">' +
            '<span class="acc-bar-sum">' +
              (_msg ? '<span class="acc-msg ' + esc(_msgKind) + '">' + esc(_msg) + '</span>'
                    : (_dirty ? 'Unsaved changes. ' : '') + sum) +
            '</span>' +
            '<button class="acc-btn-ghost" id="clear">' +
              (_mode === 'job' ? 'Remove limits' : 'Follow the job') + '</button>' +
            '<button class="acc-btn-ghost" id="cancel">Close</button>' +
            '<button class="acc-btn" id="save">Save</button>' +
            '</div>';
    }

    // ── interaction ─────────────────────────────────────────────────────────

    function wire() {
        root.querySelectorAll('[data-mode]').forEach(function (b) {
            b.onclick = function () {
                if (!confirmDiscard()) return;
                _mode = b.getAttribute('data-mode');
                reset();
                render();
            };
        });
        root.querySelectorAll('[data-job]').forEach(function (b) {
            b.onclick = function () {
                if (!confirmDiscard()) return;
                var k = b.getAttribute('data-job');
                if (_job === k) { reset(); render(); return; }
                reset();
                _job = k;
                var d = _roleDefaults[k];
                _draft = { preset: (d && d.preset) || null,
                           overrides: Object.assign({}, (d && d.overrides) || {}) };
                render();
            };
        });
        root.querySelectorAll('[data-person]').forEach(function (b) {
            b.onclick = function () {
                if (!confirmDiscard()) return;
                var id = b.getAttribute('data-person');
                if (_person && _person.id === id) { reset(); render(); return; }
                reset();
                _person = _members.filter(function (m) { return String(m.id) === String(id); })[0] || null;
                _draft = _person
                    ? { preset: _person.access_preset || null,
                        overrides: Object.assign({}, _person.section_access || {}) }
                    : null;
                render();
            };
        });

        root.querySelectorAll('[data-preset]').forEach(function (b) {
            b.onclick = function () {
                var k = b.getAttribute('data-preset');
                _draft = (k === '__none__') ? { preset: null, overrides: {} }
                                            : { preset: k, overrides: {} };
                _dirty = true; _msg = '';
                render();
            };
        });
        var sa = document.getElementById('showAll');
        if (sa) sa.onclick = function () { _allPresets = true; render(); };

        root.querySelectorAll('[data-app]').forEach(function (b) {
            b.onclick = function () {
                var k = b.getAttribute('data-app');
                _open[k] = !_open[k];
                render();
            };
        });

        root.querySelectorAll('[data-cap]').forEach(function (b) {
            b.onclick = function () {
                var key = b.getAttribute('data-cap');
                // Belt and braces — the control renders disabled, but this is
                // the one place a bad value would enter the draft.
                if (!entitled(key)) return;
                freezePreset();
                _draft.overrides[key] = b.getAttribute('data-lvl');
                _dirty = true; _msg = '';
                render();
            };
        });
        root.querySelectorAll('[data-all]').forEach(function (b) {
            b.onclick = function () { setApp(b.getAttribute('data-all'), 'edit'); };
        });
        root.querySelectorAll('[data-none]').forEach(function (b) {
            b.onclick = function () { setApp(b.getAttribute('data-none'), 'none'); };
        });

        var f = document.getElementById('filter');
        if (f) {
            f.oninput = function () { _filter = f.value; render(); };
            if (_filter) {
                f.focus();
                f.setSelectionRange(_filter.length, _filter.length);
            }
        }

        var s = document.getElementById('save');
        if (s) s.onclick = save;
        var c = document.getElementById('clear');
        if (c) c.onclick = function () {
            _draft = { preset: null, overrides: {} };
            _dirty = true;
            save();
        };
        var x = document.getElementById('cancel');
        if (x) x.onclick = function () { if (!confirmDiscard()) return; reset(); render(); };
    }

    function reset() {
        _draft = null; _job = null; _person = null;
        _open = {}; _filter = ''; _allPresets = false;
        _msg = ''; _dirty = false;
    }

    function confirmDiscard() {
        if (!_dirty) return true;
        return window.confirm('You have unsaved changes. Discard them?');
    }

    // Changing one section while a preset is selected has to freeze the preset
    // into explicit levels first. Otherwise the change reads as "preset plus one
    // override" and every other section silently follows the preset rather than
    // what is on screen — the classic way a settings page lies about itself.
    function freezePreset() {
        if (!_draft.preset) return;
        var exp = CAPS.expandPreset(_draft.preset);
        CAPS.all().forEach(function (c) {
            if (!Object.prototype.hasOwnProperty.call(_draft.overrides, c.key)) {
                _draft.overrides[c.key] = entitled(c.key) ? (exp[c.key] || 'none') : 'none';
            }
        });
        _draft.preset = null;
    }

    function setApp(appKey, lvl) {
        freezePreset();
        CAPS.forApp(appKey).forEach(function (c) {
            if (!entitled(c.key)) { _draft.overrides[c.key] = 'none'; return; }
            _draft.overrides[c.key] = (c.viewOnly && lvl === 'edit') ? 'view' : lvl;
        });
        _dirty = true; _msg = '';
        render();
    }

    function save() {
        var cl = client();
        if (!cl) { _msg = 'Connection not ready — try again in a moment.'; _msgKind = 'err'; render(); return; }

        // Last line of defence before the write: never persist a grant the
        // entitlement refuses. The controls are disabled and setApp skips them,
        // so this normally changes nothing — but it makes the guarantee
        // independent of the screen having rendered with the right plan.
        var payload = {};
        Object.keys(_draft.overrides).forEach(function (k) {
            var v = _draft.overrides[k];
            payload[k] = (v !== 'none' && !entitled(k)) ? 'none' : v;
        });

        var btn = document.getElementById('save');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

        var p = _mode === 'job'
            ? cl.rpc('set_camp_role_access', {
                  p_role: _job, p_preset: _draft.preset, p_section_access: payload })
            : cl.rpc('set_member_access', {
                  p_member_id: _person.id, p_preset: _draft.preset, p_section_access: payload });

        p.then(function (res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
            var d = res.data;
            if (res.error || !d || !d.success) {
                var e = (d && d.error) || (res.error && res.error.message) || 'Could not save.';
                _msg = e === 'not_authorized' ? 'Only the camp owner or an admin can change access.'
                     : e === 'cannot_restrict_admin' ? 'Owners and admins always have full access — change their role first.'
                     : e === 'bad_role' ? ((d && d.detail) || 'That job cannot have a default.')
                     : 'Could not save: ' + e;
                _msgKind = 'err';
                render();
                return;
            }
            if (_mode === 'job') {
                if (d.cleared) delete _roleDefaults[_job];
                else _roleDefaults[_job] = { preset: d.preset || null, overrides: d.overrides || {} };
            } else if (_person) {
                _person.access_preset = _draft.preset;
                _person.section_access = payload;
            }
            _msg = 'Saved.';
            _msgKind = 'ok';
            _dirty = false;
            render();
        }, function (e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
            _msg = 'Could not save: ' + ((e && e.message) || 'unknown error');
            _msgKind = 'err';
            render();
        });
    }

    // ── boot ────────────────────────────────────────────────────────────────

    function boot() {
        var cl = client();
        if (!cl) { gate('Could not reach Campistry', 'Check your connection and reload.'); return; }
        if (!CAPS) { gate('Could not load', 'The capability registry failed to load.'); return; }
        var cid = campId();
        if (!cid) { gate('Not signed in', 'Sign in to Campistry first, then reload this page.'); return; }

        cl.rpc('get_my_access', { p_camp_id: cid }).then(function (r) {
            var d = r.data;
            if (r.error) { gate('Could not check access', esc(r.error.message || 'Unknown error')); return; }
            if (!d || !d.success) { gate('Could not check access', esc((d && d.error) || 'Unknown error')); return; }
            if (d.role !== 'owner' && d.role !== 'admin') {
                gate('Not authorised', 'Only the camp owner or an admin can change who can open what.');
                return;
            }
            _ent = (d.entitlements && typeof d.entitlements === 'object') ? d.entitlements : {};
            return loadAll(cl, cid);
        }, function () {
            gate('Not signed in', 'Sign in to Campistry first, then reload this page.');
        });
    }

    function loadAll(cl, cid) {
        // Neither of these is fatal on its own: with no defaults the job tab
        // shows none set, and with no staff the person tab says so. Failing the
        // whole page for either would make this unusable on a camp that has one
        // but not the other.
        var roles = cl.rpc('get_camp_role_access', {}).then(function (r) {
            var d = r.data;
            if (!r.error && d && d.success && d.roles) _roleDefaults = d.roles;
        }, function () {});

        // The same staff list the dashboard's Team card shows.
        // AccessControl.getTeamMembers() is the canonical accessor and is
        // preferred when the page has access_control.js; this one does not, so
        // the fallback runs — deliberately the IDENTICAL query (select '*' on
        // camp_users) rather than a narrower one. Naming columns would be a
        // guess about what the name column is called, and a wrong guess shows
        // "no staff yet" on a camp that has plenty.
        var staff = (window.AccessControl && window.AccessControl.getTeamMembers)
            ? window.AccessControl.getTeamMembers().then(function (r) {
                  if (Array.isArray(r && r.data)) _members = sortMembers(r.data);
              }, function () {})
            : cl.from('camp_users').select('*').eq('camp_id', cid).then(function (r) {
                  if (!r.error && Array.isArray(r.data)) _members = sortMembers(r.data);
              }, function () {});

        return Promise.all([roles, staff]).then(render, render);
    }

    // Losing a screenful of toggles to a stray click is the kind of thing that
    // stops people trusting a settings page.
    window.addEventListener('beforeunload', function (e) {
        if (!_dirty) return;
        e.preventDefault();
        e.returnValue = '';
    });

    function mount(rootId, opts) {
        root = document.getElementById(rootId);
        CAPS = window.CampistryCapabilities;
        _embedded = !!(opts && opts.embedded);
        if (!root) return;
        boot();
    }

    return { mount: mount };
})();
