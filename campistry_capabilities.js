// =============================================================================
// campistry_capabilities.js — what a staff member is allowed to open, section
// by section. The registry + the resolution rules. No DOM, no network.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS SOLVES
//
// product_access (migration 027) gates whole apps: you get Campistry Me or you
// don't. But Me contains the camper roster AND billing AND payroll, and a
// division head who needs the roster has no business in the payment history.
// Same story in every app — Go holds bussing and luggage, Snacks holds the
// canteen and the shop.
//
// So capabilities are per SECTION, not per app. A capability key is
// "<app>.<section>", matching the section ids the pages already use
// (data-page / data-tab), so a gate can be wired to existing markup without
// renaming anything.
//
// ─────────────────────────────────────────────────────────────────────────────
// LEVELS
//
//   'none'  — the section doesn't appear, and opening it directly is blocked
//   'view'  — visible, read-only; actions that write are refused
//   'edit'  — full use of that section
//
// Some sections have nothing to edit (reports, analytics). They're marked
// viewOnly so the settings UI doesn't offer a meaningless third state.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BACKWARD-COMPATIBILITY RULE — read this before changing resolve()
//
// A camp that has never touched these settings must keep working exactly as it
// did. If a user has NO preset and NO overrides, they are UNCONFIGURED, and
// resolve() grants 'edit' on every section of every app their product_access
// already allows. Gating only begins once an owner deliberately assigns a
// preset or an override.
//
// Getting this backwards would silently lock every existing staff member out
// of everything the moment this file shipped.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES AND DOESN'T ENFORCE
//
// This is a UI/navigation boundary, like product_access_guard.js. It decides
// what renders and what actions are refused in the browser. It is NOT a
// cryptographic boundary: several apps hydrate one JSON blob per app from
// camp_state_kv, so data for a hidden section may still reach the client.
// campistry_access_sections.js scrubs restricted sections out of the cached
// blob and preserves them on save, which stops accidental exposure and
// accidental overwrites. True per-section read enforcement needs the storage
// split per section and an RPC-mediated read path.
//
// Exposed as window.CampistryCapabilities (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var C = {};

    C.LEVELS = ['none', 'view', 'edit'];
    C.rank = function (level) {
        var i = C.LEVELS.indexOf(level);
        return i < 0 ? 0 : i;
    };

    // ── the registry ─────────────────────────────────────────────────────────
    // section ids match the pages' own data-page / data-tab values.
    C.APPS = [
        {
            key: 'me', label: 'Campistry Me', hint: 'Campers, registration, billing, payroll',
            sections: [
                { key: 'campers',     label: 'Campers',            desc: 'The roster — camper records, contacts, medical notes' },
                { key: 'structure',   label: 'Camp Structure',     desc: 'Divisions, grades and bunks' },
                { key: 'bunkbuilder', label: 'Bunk Builder',       desc: 'Placing campers into bunks' },
                { key: 'enrollment',  label: 'Registration',       desc: 'Applications, enrolment status, forms' },
                { key: 'billing',     label: 'Billing',            desc: 'Tuition, family balances, payments', sensitive: true },
                { key: 'payroll',     label: 'Payroll',            desc: 'Staff pay, rates and Youth Corps', sensitive: true },
                { key: 'analytics',   label: 'Analytics & Finance', desc: 'Revenue, expenses, financial reports', viewOnly: true, sensitive: true },
                { key: 'reports',     label: 'Reports',            desc: 'Camper and roster reports', viewOnly: true },
                { key: 'printsheets', label: 'Print Sheets',       desc: 'Custom printable sheets' },
                { key: 'settings',    label: 'Settings',           desc: 'Camp-wide settings, custom fields, payment keys', sensitive: true }
            ]
        },
        {
            key: 'flow', label: 'Campistry Flow', hint: 'Scheduling',
            sections: [
                { key: 'setup',              label: 'Setup',              desc: 'Camp setup for the scheduler' },
                { key: 'facilities',         label: 'Facilities',         desc: 'Fields, activities and specials' },
                { key: 'zones',              label: 'Zones',              desc: 'Field zones and access' },
                { key: 'rules',              label: 'Rules',              desc: 'Scheduling rules and restrictions' },
                { key: 'leagues',            label: 'Leagues',            desc: 'League setup and fixtures' },
                { key: 'specialty-leagues',  label: 'Specialty Leagues',  desc: 'Specialty league setup' },
                { key: 'master-scheduler',   label: 'Schedule Builder',   desc: 'Building and generating schedules' },
                { key: 'schedule',           label: 'Schedule View',      desc: 'Viewing the generated schedule' },
                { key: 'daily-adjustments',  label: 'Daily Adjustments',  desc: 'Day-of changes to a live schedule' },
                { key: 'camper-locator',     label: 'Camper Locator',     desc: 'Finding where a camper is now' },
                { key: 'print',              label: 'Print',              desc: 'Printing schedules' },
                { key: 'report',             label: 'Reports',            desc: 'Rotation and fairness reports', viewOnly: true }
            ]
        },
        {
            key: 'go', label: 'Campistry Go', hint: 'Bussing and luggage',
            sections: [
                { key: 'setup',      label: 'Setup',      desc: 'Transport setup and API config', sensitive: true },
                { key: 'addresses',  label: 'Addresses',  desc: 'Camper addresses and geocoding' },
                { key: 'fleet',      label: 'Bus Fleet',  desc: 'Buses, capacity and shifts' },
                { key: 'staff',      label: 'Bus Staff',  desc: 'Monitors and counselors on buses' },
                { key: 'routes',     label: 'Routes & Map', desc: 'Generating and editing routes' },
                { key: 'luggage',    label: 'Luggage',    desc: 'Bag bookings, tags and delivery' }
            ]
        },
        {
            key: 'health', label: 'Campistry Health', hint: 'Nurse station',
            sections: [
                { key: 'dashboard',   label: 'Dashboard',    desc: 'Health overview' },
                { key: 'campers',     label: 'Camper Health', desc: 'Health records per camper', sensitive: true },
                { key: 'intake',      label: 'Intake',       desc: 'Health intake forms', sensitive: true },
                { key: 'medications', label: 'Medications',  desc: 'Medication schedule and log', sensitive: true },
                { key: 'allergies',   label: 'Allergies',    desc: 'Allergy list', sensitive: true },
                { key: 'sick-visits', label: 'Sick Visits',  desc: 'Visit log', sensitive: true },
                { key: 'nighttime',   label: 'Nighttime',    desc: 'Overnight care log', sensitive: true },
                { key: 'doctor',      label: 'Doctor',       desc: 'Doctor visits and referrals', sensitive: true },
                { key: 'reports',     label: 'Reports',      desc: 'Health reporting', viewOnly: true, sensitive: true }
            ]
        },
        {
            key: 'snacks', label: 'Campistry Snacks', hint: 'Canteen and camp shop',
            sections: [
                { key: 'dashboard',    label: 'Dashboard',    desc: 'Canteen overview' },
                { key: 'transactions', label: 'Transactions', desc: 'Purchase and deposit history' },
                { key: 'accounts',     label: 'Accounts',     desc: 'Camper balances, deposits, cash out', sensitive: true },
                { key: 'menu',         label: 'Menu Items',   desc: 'Canteen stock and pricing' },
                { key: 'pos',          label: 'POS Terminal', desc: 'Ringing up canteen sales at the window' },
                { key: 'shop',         label: 'Camp Shop',    desc: 'Swag catalogue, orders and fulfilment' },
                { key: 'settings',     label: 'Settings',     desc: 'Canteen settings and payment methods', sensitive: true }
            ]
        },
        {
            key: 'live', label: 'Campistry Live', hint: 'Attendance and day-of ops',
            sections: [
                { key: 'roll-call',        label: 'Roll Call',        desc: 'Taking attendance' },
                { key: 'absences',         label: 'Absences',         desc: 'Absence log' },
                { key: 'bunk-tracker',     label: 'Bunk Tracker',     desc: 'Where each bunk is now' },
                { key: 'activity-board',   label: 'Activity Board',   desc: 'Live activity display' },
                { key: 'camper-locator',   label: 'Camper Locator',   desc: 'Find a camper + read-only day schedule', viewOnly: true },
                { key: 'early-pickup',     label: 'Early Pickup',     desc: 'Early pickup requests' },
                { key: 'parent-requests',  label: 'Parent Requests',  desc: 'Requests coming from parents' },
                { key: 'camper-mail',      label: 'Camper Mail',      desc: 'Mail to campers' },
                { key: 'reports',          label: 'Reports',          desc: 'Attendance reporting', viewOnly: true }
            ]
        },
        {
            key: 'link', label: 'Campistry Link', hint: 'Parent communication',
            sections: [
                { key: 'dashboard', label: 'Dashboard', desc: 'Link overview' },
                { key: 'messages',  label: 'Messages',  desc: 'Messaging parents' },
                { key: 'parents',   label: 'Parents',   desc: 'Parent accounts and invites', sensitive: true },
                { key: 'forms',     label: 'Forms',     desc: 'Forms sent to parents' },
                { key: 'lists',     label: 'Lists',     desc: 'Packing and camp lists' },
                { key: 'photos',    label: 'Photos',    desc: 'Photo sharing' },
                { key: 'tips',      label: 'Tips',      desc: 'Staff tips from parents', sensitive: true }
            ]
        },
        {
            key: 'notes', label: 'Campistry Notes', hint: 'Shared notes',
            sections: [{ key: 'notes', label: 'Notes', desc: 'Shared camp notes' }]
        },
        {
            key: 'guard', label: 'Campistry Guard', hint: 'Safety',
            sections: [{ key: 'guard', label: 'Guard', desc: 'Safety and incident tracking', sensitive: true }]
        }
    ];

    /** Flat list of every capability: { key, app, section, label, ... } */
    C.all = function () {
        var out = [];
        C.APPS.forEach(function (app) {
            app.sections.forEach(function (s) {
                out.push({
                    key: app.key + '.' + s.key,
                    app: app.key, appLabel: app.label,
                    section: s.key, label: s.label, desc: s.desc || '',
                    viewOnly: !!s.viewOnly, sensitive: !!s.sensitive
                });
            });
        });
        return out;
    };

    C.get = function (key) {
        return C.all().filter(function (c) { return c.key === key; })[0] || null;
    };

    C.forApp = function (appKey) {
        return C.all().filter(function (c) { return c.app === appKey; });
    };

    C.appKeys = function () { return C.APPS.map(function (a) { return a.key; }); };

    /** Levels a capability can actually take — no 'edit' on a read-only section. */
    C.levelsFor = function (key) {
        var cap = C.get(key);
        return (cap && cap.viewOnly) ? ['none', 'view'] : ['none', 'view', 'edit'];
    };

    // ── presets: the "simple to use" half ────────────────────────────────────
    // Each preset is a starting point an owner picks in one click. Overrides on
    // top of it are what makes it fully customizable. '*' means every section
    // of that app.
    C.PRESETS = [
        {
            key: 'full', label: 'Full access',
            desc: 'Everything, in every app they can open. Same as before section limits existed.',
            grants: { '*': 'edit' }
        },
        {
            key: 'division-head', label: 'Division Head',
            desc: 'The roster and their schedule. No money — not billing, payroll or finance.',
            grants: {
                'me.campers': 'view', 'me.structure': 'view', 'me.bunkbuilder': 'edit',
                'me.reports': 'view', 'me.printsheets': 'edit',
                'flow.schedule': 'view', 'flow.daily-adjustments': 'edit',
                'flow.camper-locator': 'view', 'flow.print': 'edit', 'flow.report': 'view',
                'live.*': 'edit', 'notes.notes': 'edit'
            }
        },
        {
            key: 'head-counselor', label: 'Head Counselor',
            desc: 'Runs the schedule and the day. Roster read-only, no money.',
            grants: {
                'flow.*': 'edit',
                'me.campers': 'view', 'me.structure': 'view', 'me.bunkbuilder': 'edit',
                'me.printsheets': 'edit', 'me.reports': 'view',
                'live.*': 'edit', 'notes.notes': 'edit'
            }
        },
        {
            key: 'office', label: 'Office / Registrar',
            desc: 'Registration, campers and family billing. Not payroll, not scheduling.',
            grants: {
                'me.campers': 'edit', 'me.structure': 'view', 'me.enrollment': 'edit',
                'me.billing': 'edit', 'me.reports': 'view', 'me.printsheets': 'edit',
                'link.*': 'edit', 'notes.notes': 'edit'
            }
        },
        {
            key: 'bookkeeper', label: 'Bookkeeper',
            desc: 'The money: billing, payroll, finance. Roster read-only.',
            grants: {
                'me.billing': 'edit', 'me.payroll': 'edit', 'me.analytics': 'view',
                'me.campers': 'view', 'me.reports': 'view',
                'snacks.transactions': 'view', 'snacks.accounts': 'view', 'snacks.pos': 'none'
            }
        },
        {
            key: 'nurse', label: 'Nurse',
            desc: 'The health station, and camper records read-only. Nothing else.',
            grants: { 'health.*': 'edit', 'me.campers': 'view', 'notes.notes': 'edit' }
        },
        {
            key: 'canteen', label: 'Canteen Staff',
            desc: 'The canteen and the camp shop. Roster read-only.',
            grants: { 'snacks.*': 'edit', 'me.campers': 'view' }
        },
        {
            key: 'bus-coordinator', label: 'Bus Coordinator',
            desc: 'Bussing and luggage. Addresses and roster read-only.',
            grants: { 'go.*': 'edit', 'me.campers': 'view', 'notes.notes': 'edit' }
        },
        {
            key: 'read-only', label: 'Read-only',
            desc: 'Can look at everything they can open, change nothing.',
            grants: { '*': 'view' }
        }
    ];

    C.preset = function (key) {
        return C.PRESETS.filter(function (p) { return p.key === key; })[0] || null;
    };

    /**
     * Expand a preset's grants (which may use '*' and 'app.*') into an explicit
     * capability -> level map. Most specific wins: an exact key beats 'app.*',
     * which beats '*'.
     */
    C.expandPreset = function (presetKey) {
        var p = C.preset(presetKey);
        var out = {};
        if (!p) return out;
        C.all().forEach(function (cap) {
            var level = p.grants[cap.key];
            if (level === undefined) level = p.grants[cap.app + '.*'];
            if (level === undefined) level = p.grants['*'];
            if (level === undefined) level = 'none';
            // A read-only section can't be granted edit, however it was written.
            if (cap.viewOnly && level === 'edit') level = 'view';
            out[cap.key] = level;
        });
        return out;
    };

    // ── resolution ───────────────────────────────────────────────────────────

    /**
     * True when this user has never had section access configured. Such a user
     * keeps the pre-section-access behaviour: full use of every app in their
     * product_access. See THE BACKWARD-COMPATIBILITY RULE above.
     */
    C.isUnconfigured = function (access) {
        if (!access) return true;
        if (access.preset) return false;
        var o = access.overrides;
        return !o || Object.keys(o).length === 0;
    };

    /**
     * The level a user has for one capability.
     *
     * access = {
     *   role,                  // 'owner' | 'admin' | 'scheduler' | 'viewer' | 'counselor'
     *   products: ['me',...],  // product_access
     *   preset:   'nurse',     // access_preset, or null
     *   overrides: { 'me.billing': 'none' }   // section_access
     * }
     */
    C.resolve = function (key, access) {
        access = access || {};
        var cap = C.get(key);
        if (!cap) return 'none';                    // unknown capability: fail closed

        // Owners and admins are never gated. Anything else and an owner could
        // lock themselves out of their own camp with no way back in.
        if (access.role === 'owner' || access.role === 'admin') {
            return cap.viewOnly ? 'view' : 'edit';
        }

        // No access to the app at all -> no access to any of its sections. The
        // product gate still comes first.
        var products = access.products;
        if (Array.isArray(products) && products.indexOf(cap.app) < 0) return 'none';

        var level;
        if (C.isUnconfigured(access)) {
            level = 'edit';                          // legacy behaviour
        } else {
            var overrides = access.overrides || {};
            if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                level = overrides[key];
            } else if (access.preset) {
                level = C.expandPreset(access.preset)[key];
            } else {
                // Overrides exist but this key isn't among them and there's no
                // preset: the owner is picking sections explicitly, so anything
                // unlisted is off.
                level = 'none';
            }
        }

        if (C.LEVELS.indexOf(level) < 0) level = 'none';

        // A read-only role can never come out above 'view', whatever the
        // preset says — this is the fail-closed floor from access_control.
        if (access.role === 'viewer' || access.role === 'counselor') {
            if (C.rank(level) > C.rank('view')) level = 'view';
        }
        if (cap.viewOnly && level === 'edit') level = 'view';
        return level;
    };

    C.can = function (key, access) { return C.resolve(key, access) !== 'none'; };
    C.canEdit = function (key, access) { return C.resolve(key, access) === 'edit'; };

    /** Every capability -> level, for the settings UI and for scrubbing. */
    C.resolveAll = function (access) {
        var out = {};
        C.all().forEach(function (cap) { out[cap.key] = C.resolve(cap.key, access); });
        return out;
    };

    /**
     * Which preset (if any) a set of overrides exactly matches — so the
     * settings UI can show "Nurse" rather than "Custom" when they happen to
     * line up, and "Custom" the moment one toggle differs.
     */
    C.matchPreset = function (access) {
        if (!access || C.isUnconfigured(access)) return null;
        var effective = {};
        C.all().forEach(function (cap) {
            var o = (access.overrides || {});
            effective[cap.key] = Object.prototype.hasOwnProperty.call(o, cap.key)
                ? o[cap.key]
                : (access.preset ? C.expandPreset(access.preset)[cap.key] : 'none');
        });
        var hit = C.PRESETS.filter(function (p) {
            var exp = C.expandPreset(p.key);
            return C.all().every(function (cap) { return exp[cap.key] === effective[cap.key]; });
        })[0];
        return hit ? hit.key : null;
    };

    /** One-line summary for a staff row in the settings list. */
    C.summarize = function (access) {
        if (!access) return 'Not configured';
        if (access.role === 'owner') return 'Owner — full access';
        if (access.role === 'admin') return 'Admin — full access';
        if (C.isUnconfigured(access)) return 'Full access to their apps';
        var matched = C.matchPreset(access);
        if (matched) {
            var p = C.preset(matched);
            return p ? p.label : 'Custom';
        }
        var levels = C.resolveAll(access);
        var on = C.all().filter(function (c) { return levels[c.key] !== 'none'; });
        return 'Custom — ' + on.length + ' section' + (on.length === 1 ? '' : 's');
    };

    if (typeof window !== 'undefined') window.CampistryCapabilities = C;
    if (typeof module !== 'undefined' && module.exports) module.exports = C;
})();
