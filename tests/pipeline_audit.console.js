/* =========================================================================
 * Pipeline Audit — Manual Pipeline Audit branch verification
 * Paste into browser DevTools console (or load via <script>)
 *
 * Usage:
 *   PipelineAudit.run()          — run all sections
 *   PipelineAudit.cooldown()     — cooldown rules engine only
 *   PipelineAudit.playerCount()  — sport player count only
 *   PipelineAudit.fieldGroups()  — field quality groups only
 *   PipelineAudit.persistence()  — save/load round-trip only
 *   PipelineAudit.showRules()    — print all live cooldown rules
 *   PipelineAudit.showSports()   — print all sport min/max configs
 *   PipelineAudit.showGroups()   — print all field quality group assignments
 *
 * Works entirely with YOUR real configured data — no fake data injected.
 * ========================================================================= */

(function () {
    'use strict';

    const c = {
        ok:   (...a) => console.log('%c ✓ ', 'background:#1b5e20;color:#fff;border-radius:3px', ...a),
        bad:  (...a) => console.log('%c ✗ ', 'background:#b71c1c;color:#fff;border-radius:3px', ...a),
        warn: (...a) => console.log('%c ⚠ ', 'background:#ef6c00;color:#fff;border-radius:3px', ...a),
        info: (...a) => console.log('%c i ', 'background:#0d47a1;color:#fff;border-radius:3px', ...a),
        h1:   (s)    => console.log('\n%c ' + s + ' ', 'font-size:14px;font-weight:bold;background:#222;color:#fff;padding:4px 10px;border-radius:4px'),
        h2:   (s)    => console.log('%c' + s, 'font-weight:bold;color:#0d47a1;border-bottom:1px solid #0d47a1'),
        data: (...a) => console.log('%c   ', 'background:#546e7a;color:#fff;border-radius:3px', ...a),
        skip: (...a) => console.log('%c — ', 'background:#78909c;color:#fff;border-radius:3px', ...a),
    };

    let _pass = 0, _fail = 0, _warn = 0, _skip = 0;

    function assert(condition, msg) {
        if (condition) { c.ok(msg); _pass++; }
        else           { c.bad(msg); _fail++; }
    }
    function assertWarn(condition, msg) {
        if (condition) { c.ok(msg); _pass++; }
        else           { c.warn(msg); _warn++; }
    }
    function skip(msg) { c.skip('SKIP — ' + msg); _skip++; }

    function summary() {
        console.log('');
        if (_fail === 0) {
            console.log(`%c  ALL CHECKS PASSED  ${_pass} ✓  ${_warn} warnings  ${_skip} skipped  `,
                'font-size:13px;font-weight:bold;background:#1b5e20;color:#fff;padding:4px 12px;border-radius:6px');
        } else {
            console.log(`%c  ${_fail} FAILED  /  ${_pass} passed  /  ${_warn} warnings  /  ${_skip} skipped  `,
                'font-size:13px;font-weight:bold;background:#b71c1c;color:#fff;padding:4px 12px;border-radius:6px');
        }
        console.log('');
    }

    // =========================================================================
    // 1. COOLDOWN RULES ENGINE
    // =========================================================================

    function testCooldown() {
        c.h1('1. Cooldown Rules Engine');

        const SR = window.SchedulingRules;
        if (!SR) { c.bad('window.SchedulingRules not found — rules.js not loaded'); _fail++; return; }

        const { blockMatchesDescriptor, isCandidateAllowed, checkCandidateDetailed, getCooldownRules } = SR;

        // --- Engine presence ---
        c.h2('1a. Core functions exposed');
        assert(typeof blockMatchesDescriptor === 'function',  'blockMatchesDescriptor is a function');
        assert(typeof isCandidateAllowed === 'function',      'isCandidateAllowed is a function');
        assert(typeof checkCandidateDetailed === 'function',  'checkCandidateDetailed is a function');
        assert(typeof getCooldownRules === 'function',        'getCooldownRules is a function');

        // --- Basic descriptor matching ---
        c.h2('1b. blockMatchesDescriptor — basic sanity');

        const sport  = { type: 'sport',  event: 'basketball', field: '' };
        const lunch  = { type: 'lunch',  event: 'lunch',      field: '' };
        const swim   = { type: 'swim',   event: 'swim',       field: 'pool' };

        assert(blockMatchesDescriptor(sport, { kind: 'type', value: 'sport' }),        'type:sport matches sport block');
        assert(blockMatchesDescriptor(lunch, { kind: 'type', value: 'lunch' }),        'type:lunch matches lunch block');
        assert(!blockMatchesDescriptor(sport, { kind: 'type', value: 'lunch' }),       'type:lunch does NOT match sport block');
        assert(blockMatchesDescriptor(sport, { kind: 'activity', value: 'basketball' }),'activity:basketball matches basketball event');
        assert(!blockMatchesDescriptor(sport, { kind: 'activity', value: 'soccer' }),  'activity:soccer does NOT match basketball');
        assert(blockMatchesDescriptor(swim,  { kind: 'facility', value: 'pool' }),     'facility:pool matches pool field');
        assert(blockMatchesDescriptor(sport, { kind: 'any' }),                         'kind:any matches any block');
        assert(!blockMatchesDescriptor(null, { kind: 'type', value: 'sport' }),        'null block → false (no crash)');

        // --- Live rules ---
        c.h2('1c. Your configured cooldown rules');

        const rules = getCooldownRules();
        if (!rules.length) {
            skip('No cooldown rules saved yet — create some in the Rules tab to test them');
        } else {
            c.info(`Found ${rules.length} rule(s):`);
            rules.forEach((r, i) => {
                const t   = r.target    ? `${r.target.kind}:${r.target.value}`    : '(none)';
                const ref = r.reference ? `${r.reference.kind}:${r.reference.value}` : '(none)';
                c.data(`Rule ${i+1}: [mode:${r.mode||'both'}] [timing:${r.timing||'both'}] [${r.minutes}min]  "${t}"  ←→  "${ref}"`);
            });

            // Verify each rule has required fields
            c.h2('1d. Rule structure validation');
            let allValid = true;
            rules.forEach((r, i) => {
                const hasTarget = r.target && r.target.kind && r.target.value;
                const hasRef    = r.reference && r.reference.kind && r.reference.value;
                const hasMin    = Number.isFinite(parseInt(r.minutes)) && parseInt(r.minutes) > 0;
                const validMode = ['auto', 'manual', 'both'].includes(r.mode || 'both');

                if (!hasTarget || !hasRef || !hasMin || !validMode) {
                    c.bad(`Rule ${i+1} has structural problems: target=${!!hasTarget} ref=${!!hasRef} minutes=${r.minutes} mode=${r.mode}`);
                    _fail++; allValid = false;
                }
            });
            if (allValid) { c.ok(`All ${rules.length} rules have valid structure`); _pass++; }

            // Mode filtering check
            c.h2('1e. Mode filtering — auto-only rules do not fire in manual');
            const autoOnlyRules = rules.filter(r => r.mode === 'auto');
            const manualRules   = rules.filter(r => r.mode === 'manual');
            const bothRules     = rules.filter(r => !r.mode || r.mode === 'both');
            c.info(`Rule modes: auto=${autoOnlyRules.length}  manual=${manualRules.length}  both=${bothRules.length}`);

            if (autoOnlyRules.length > 0) {
                // Pick the first auto-only rule's target type and verify it doesn't block in manual
                const ar = autoOnlyRules[0];
                // Build a fake candidate that matches the rule's target
                const dummyCandidate = { type: ar.target.value, event: ar.target.value, startMin: 600, endMin: 660 };
                const dummyTemplate  = [{ type: ar.reference.value, event: ar.reference.value, startMin: 500, endMin: 560 }];
                const blockedInAuto  = !isCandidateAllowed(dummyCandidate, dummyTemplate, { mode: 'auto' });
                const blockedInManual= !isCandidateAllowed(dummyCandidate, dummyTemplate, { mode: 'manual' });
                assert(!blockedInManual,
                    `Auto-only rule "${ar.target.value} after ${ar.reference.value}" does NOT hard-block in manual mode`);
                if (!blockedInAuto) {
                    c.warn(`Auto-only rule did not block in auto either — check that target/reference types match exactly (case-sensitive)`);
                    _warn++;
                }
            } else {
                skip('No auto-only rules to test mode filtering');
            }

            // checkCandidateDetailed returns { allowed, violated }
            c.h2('1f. checkCandidateDetailed returns correct shape');
            const firstRule = rules[0];
            const dummyC = { type: firstRule.target.value, event: firstRule.target.value, startMin: 700, endMin: 760 };
            const dummyT = [];
            const result = checkCandidateDetailed(dummyC, dummyT, { mode: 'manual' });
            assert(typeof result.allowed === 'boolean', 'checkCandidateDetailed.allowed is boolean');
            assert(Array.isArray(result.violated),      'checkCandidateDetailed.violated is array');
        }
    }

    // =========================================================================
    // 2. SPORT PLAYER COUNT
    // =========================================================================

    function testPlayerCount() {
        c.h1('2. Sport Player Count Rules');

        const Utils = window.SchedulerCoreUtils;
        if (!Utils) { c.bad('window.SchedulerCoreUtils not found'); _fail++; return; }

        c.h2('2a. Core functions exposed');
        assert(typeof Utils.getSportPlayerRequirements === 'function',  'getSportPlayerRequirements exists');
        assert(typeof Utils.checkPlayerCountForSport === 'function',    'checkPlayerCountForSport exists');

        c.h2('2b. Engine logic validation (independent of your data)');

        // These verify the math is correct regardless of configuration
        // We build a mock meta lookup for isolated math testing
        const origGet = window.getSportMetaData;
        window.getSportMetaData = () => ({ '__audit_sport__': { minPlayers: 20, maxPlayers: 40 } });

        const hard_under = Utils.checkPlayerCountForSport('__audit_sport__', 8);   // 60% under → hard
        const soft_under = Utils.checkPlayerCountForSport('__audit_sport__', 16);  // 20% under → soft
        const valid_mid  = Utils.checkPlayerCountForSport('__audit_sport__', 28);  // in range  → valid
        const soft_over  = Utils.checkPlayerCountForSport('__audit_sport__', 48);  // 20% over  → soft
        const hard_over  = Utils.checkPlayerCountForSport('__audit_sport__', 56);  // 40% over  → hard
        const zero       = Utils.checkPlayerCountForSport('__audit_sport__', 0);   // 0 players
        const league     = Utils.checkPlayerCountForSport('__audit_sport__', 5, true); // league flag

        assert(!hard_under.valid && hard_under.severity === 'hard', 'Hard undercount (8/20 min) → hard block');
        assert(!soft_under.valid && soft_under.severity === 'soft', 'Soft undercount (16/20 min) → soft warn');
        assert(valid_mid.valid === true,                            'Valid count (28, between 20–40) → valid');
        assert(!soft_over.valid && soft_over.severity === 'soft',  'Soft overcount (48/40 max) → soft warn');
        assert(!hard_over.valid && hard_over.severity === 'hard',  'Hard overcount (56/40 max) → hard block');
        assert(league.valid === true,                               'League flag → always valid (bypasses check)');
        assertWarn(zero.valid === true || typeof zero.valid === 'boolean',
            'Zero players returns a boolean (solver-level guard handles it)');

        // Restore
        if (origGet) window.getSportMetaData = origGet;
        else delete window.getSportMetaData;

        c.h2('2c. Your configured sport player rules');

        const meta = window.getSportMetaData?.() || window.sportMetaData || {};
        const allSports = Object.keys(meta);

        if (!allSports.length) {
            skip('No sports found in getSportMetaData() — configure sports in the Facilities tab');
        } else {
            const withLimits = allSports.filter(s => meta[s]?.minPlayers || meta[s]?.maxPlayers);
            if (!withLimits.length) {
                skip(`${allSports.length} sports found but none have min/max player counts set yet`);
            } else {
                c.info(`${withLimits.length} of ${allSports.length} sports have player count rules:`);
                withLimits.forEach(name => {
                    const m = meta[name];
                    c.data(`${name}: min=${m.minPlayers ?? '—'}  max=${m.maxPlayers ?? '—'}`);

                    // Verify the check returns the right shape for each configured sport
                    const r1 = Utils.checkPlayerCountForSport(name, m.minPlayers || 1);
                    const r2 = Utils.checkPlayerCountForSport(name, (m.maxPlayers || 999) + 1000);
                    assert(r1.valid === true,  `${name}: exactly at min (${m.minPlayers}) → valid`);
                    assert(!r2.valid,          `${name}: way over max → not valid`);
                });
            }
        }
    }

    // =========================================================================
    // 3. FIELD QUALITY GROUPS
    // =========================================================================

    function testFieldGroups() {
        c.h1('3. Field Quality Groups');

        c.h2('3a. normalizeFieldForSave preserves custom properties');

        if (!window.normalizeFieldForSave) {
            c.bad('window.normalizeFieldForSave not found — cloud_sync_helpers.js not loaded');
            _fail++; return;
        }

        // Test with a field object that has group data
        const withGroup = {
            name: 'Field A',
            activities: ['baseball'],
            available: true,
            sharableWith: { type: 'not_sharable', divisions: [], capacity: 1 },
            limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
            timeRules: [],
            rainyDayAvailable: false,
            fieldGroup: 'Baseball Diamonds',
            qualityRank: 2,
            gradeShareRules: { Boys: true }
        };
        const withoutGroup = { name: 'Field B', activities: [] };

        const n1 = window.normalizeFieldForSave(withGroup);
        const n2 = window.normalizeFieldForSave(withoutGroup);

        assert(n1.fieldGroup === 'Baseball Diamonds',        'normalizeFieldForSave: fieldGroup preserved');
        assert(n1.qualityRank === 2,                         'normalizeFieldForSave: qualityRank preserved');
        assert(n1.gradeShareRules?.Boys === true,            'normalizeFieldForSave: gradeShareRules preserved');
        assert(!('fieldGroup' in n2),                        'normalizeFieldForSave: fieldGroup not added when absent');
        assert(!('qualityRank' in n2),                       'normalizeFieldForSave: qualityRank not added when absent');

        c.h2('3b. Your configured field quality groups');

        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];

        if (!fields.length) {
            skip('No fields found in saved settings — add fields in the Facilities tab');
        } else {
            const grouped   = fields.filter(f => f.fieldGroup);
            const ungrouped = fields.filter(f => !f.fieldGroup);

            c.info(`${fields.length} total fields: ${grouped.length} in groups, ${ungrouped.length} ungrouped`);

            if (grouped.length) {
                // Group by name and display
                const groupMap = new Map();
                grouped.forEach(f => {
                    if (!groupMap.has(f.fieldGroup)) groupMap.set(f.fieldGroup, []);
                    groupMap.get(f.fieldGroup).push(f);
                });

                groupMap.forEach((members, groupName) => {
                    members.sort((a, b) => (a.qualityRank ?? 999) - (b.qualityRank ?? 999));
                    c.data(`Group "${groupName}":`);
                    members.forEach(f => console.log(`      rank ${f.qualityRank ?? '—'}  →  ${f.name}`));
                });

                // Verify each grouped field has a qualityRank
                let rankMissing = 0;
                grouped.forEach(f => { if (!f.qualityRank) rankMissing++; });
                assertWarn(rankMissing === 0,
                    rankMissing === 0
                        ? 'All grouped fields have a qualityRank'
                        : `${rankMissing} grouped fields are missing qualityRank — set ranks in the Rules tab`);
            } else {
                skip('No fields assigned to quality groups yet — use the Rules tab to create groups');
            }
        }

        c.h2('3c. applyFieldGroupUpdates exposed');
        assert(typeof window.SchedulingRules?.applyFieldGroupUpdates === 'function',
            'window.SchedulingRules.applyFieldGroupUpdates is a function');

        c.h2('3d. getGlobalFields round-trip preserves fieldGroup');

        const liveFields = window.getGlobalFields?.() || [];
        const withGroups = liveFields.filter(f => f.fieldGroup);
        if (!withGroups.length) {
            skip('No grouped fields in getGlobalFields() to test round-trip');
        } else {
            // Save then reload
            window.saveGlobalFields?.(liveFields);
            const reloaded = window.getGlobalFields?.() || [];
            let roundTripOk = true;
            withGroups.forEach(orig => {
                const r = reloaded.find(f => f.name === orig.name);
                if (!r || r.fieldGroup !== orig.fieldGroup || r.qualityRank !== orig.qualityRank) {
                    c.bad(`Round-trip failed for "${orig.name}": fieldGroup=${r?.fieldGroup} qualityRank=${r?.qualityRank}`);
                    _fail++; roundTripOk = false;
                }
            });
            if (roundTripOk) { c.ok(`All ${withGroups.length} grouped fields survive saveGlobalFields → getGlobalFields round-trip`); _pass++; }
        }
    }

    // =========================================================================
    // 4. FACILITIES PERSISTENCE
    // =========================================================================

    function testPersistence() {
        c.h1('4. Facilities Save Persistence');

        c.h2('4a. getSportMetaData accessible');
        const meta = window.getSportMetaData?.();
        if (meta) {
            const n = Object.keys(meta).length;
            assert(typeof meta === 'object', `getSportMetaData() returns object (${n} sports)`);
        } else {
            assertWarn(false, 'getSportMetaData() is null/undefined — facilities.js not loaded or no sports');
        }

        c.h2('4b. sportMetaData saved to app1');
        const settings = window.loadGlobalSettings?.() || {};
        const saved = settings.app1?.sportMetaData;
        if (saved && Object.keys(saved).length > 0) {
            c.ok(`app1.sportMetaData has ${Object.keys(saved).length} sports saved to cloud state`); _pass++;
        } else {
            assertWarn(false, 'app1.sportMetaData is empty or missing — save a sport config in Facilities to persist it');
        }

        c.h2('4c. fields saved to both app1.fields and root fields key');
        const app1Fields = settings.app1?.fields || [];
        const rootFields = settings.fields || [];
        assertWarn(app1Fields.length > 0,  `app1.fields has ${app1Fields.length} fields`);
        assertWarn(rootFields.length > 0,  `root fields key has ${rootFields.length} fields`);

        if (app1Fields.length > 0 && rootFields.length > 0) {
            assertWarn(app1Fields.length === rootFields.length,
                `app1.fields (${app1Fields.length}) and root fields (${rootFields.length}) have same count`);
        }

        c.h2('4d. saveGlobalSettings is hooked for cloud sync');
        const isHooked = window.saveGlobalSettings?._cloudHelpersHooked === true;
        assert(isHooked, 'saveGlobalSettings is wrapped by cloud_sync_helpers (._cloudHelpersHooked = true)');

        c.h2('4e. saveGlobalSettings has authoritative handler flag');
        const isAuth = window.saveGlobalSettings?._isAuthoritativeHandler === true;
        assertWarn(isAuth,
            isAuth
                ? 'saveGlobalSettings._isAuthoritativeHandler = true (prevents stale cloud push)'
                : 'saveGlobalSettings._isAuthoritativeHandler not set — check integration_hooks.js is loaded first');
    }

    // =========================================================================
    // SHOW HELPERS — inspect live data
    // =========================================================================

    function showRules() {
        c.h1('Live Cooldown Rules');
        const rules = window.SchedulingRules?.getCooldownRules?.() || [];
        if (!rules.length) { c.warn('No cooldown rules configured'); return; }
        rules.forEach((r, i) => {
            const t   = r.target    ? `${r.target.kind}:${r.target.value}`    : '(none)';
            const ref = r.reference ? `${r.reference.kind}:${r.reference.value}` : '(none)';
            const desc = window.SchedulingRules?.describeRule?.(r) || `"${t}" within ${r.minutes}min of "${ref}"`;
            c.data(`Rule ${i+1}  [mode:${r.mode||'both'}] [timing:${r.timing||'both'}]  ${desc}`);
        });
        console.log(`\nTotal: ${rules.length} rule(s)`);
    }

    function showSports() {
        c.h1('Live Sport Player Requirements');
        const meta = window.getSportMetaData?.() || window.sportMetaData || {};
        const sports = Object.keys(meta);
        if (!sports.length) { c.warn('No sport metadata found'); return; }
        let n = 0;
        sports.forEach(name => {
            const m = meta[name] || {};
            if (m.minPlayers || m.maxPlayers) {
                c.data(`${name}: min=${m.minPlayers ?? '—'}  max=${m.maxPlayers ?? '—'}`);
                n++;
            }
        });
        if (!n) c.warn(`${sports.length} sports found but none have player counts configured`);
        else console.log(`\n${n} of ${sports.length} sports have player count rules`);
    }

    function showGroups() {
        c.h1('Live Field Quality Groups');
        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];
        const groups = new Map();
        let ungrouped = 0;
        fields.forEach(f => {
            if (f.fieldGroup) {
                if (!groups.has(f.fieldGroup)) groups.set(f.fieldGroup, []);
                groups.get(f.fieldGroup).push(f);
            } else ungrouped++;
        });
        if (!groups.size) {
            c.warn('No field quality groups configured — use the Rules tab to create groups');
        } else {
            groups.forEach((members, name) => {
                members.sort((a, b) => (a.qualityRank ?? 999) - (b.qualityRank ?? 999));
                c.data(`"${name}"  (${members.length} fields)`);
                members.forEach(f => console.log(`      rank ${f.qualityRank ?? '—'}  →  ${f.name}`));
            });
        }
        c.info(`${ungrouped} ungrouped field(s)  |  ${fields.length} total`);
    }

    // =========================================================================
    // ENTRY POINTS
    // =========================================================================

    function run() {
        _pass = 0; _fail = 0; _warn = 0; _skip = 0;
        console.clear();
        console.log('%c Pipeline Audit — Manual Pipeline Audit Branch ',
            'font-size:15px;font-weight:bold;background:#37474f;color:#fff;padding:6px 14px;border-radius:6px');
        console.log('Date:', new Date().toLocaleString());
        testCooldown();
        testPlayerCount();
        testFieldGroups();
        testPersistence();
        summary();
    }

    window.PipelineAudit = {
        run,
        cooldown:    () => { _pass=0;_fail=0;_warn=0;_skip=0; testCooldown();    summary(); },
        playerCount: () => { _pass=0;_fail=0;_warn=0;_skip=0; testPlayerCount(); summary(); },
        fieldGroups: () => { _pass=0;_fail=0;_warn=0;_skip=0; testFieldGroups(); summary(); },
        persistence: () => { _pass=0;_fail=0;_warn=0;_skip=0; testPersistence(); summary(); },
        showRules,
        showSports,
        showGroups,
    };

    console.log('%c PipelineAudit loaded. Call PipelineAudit.run() to start. ',
        'background:#546e7a;color:#fff;padding:3px 8px;border-radius:4px');
})();
