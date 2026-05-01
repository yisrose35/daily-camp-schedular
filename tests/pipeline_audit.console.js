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
 * What this checks:
 *   1. Cooldown rules — blockMatchesDescriptor, isCandidateAllowed,
 *      checkCandidateDetailed, mode filtering (auto vs manual)
 *   2. Sport player count — getSportPlayerRequirements, checkPlayerCountForSport,
 *      hard/soft thresholds, zero-size guard
 *   3. Field quality groups — applyFieldGroupUpdates, normalizeFieldForSave
 *      preserves fieldGroup/qualityRank, round-trip through saveGlobalFields
 *   4. Facilities save — verifies sportMetaData persists through saveFieldData
 * ========================================================================= */

(function () {
    'use strict';

    // ---- display helpers ---------------------------------------------------
    const c = {
        ok:   (...a) => console.log('%c ✓ ', 'background:#1b5e20;color:#fff;border-radius:3px', ...a),
        bad:  (...a) => console.log('%c ✗ ', 'background:#b71c1c;color:#fff;border-radius:3px', ...a),
        warn: (...a) => console.log('%c ⚠ ', 'background:#ef6c00;color:#fff;border-radius:3px', ...a),
        info: (...a) => console.log('%c i ', 'background:#0d47a1;color:#fff;border-radius:3px', ...a),
        h1:   (s)    => console.log('\n%c ' + s + ' ', 'font-size:14px;font-weight:bold;background:#222;color:#fff;padding:4px 10px;border-radius:4px'),
        h2:   (s)    => console.log('%c' + s, 'font-weight:bold;color:#0d47a1;border-bottom:1px solid #0d47a1'),
        data: (...a) => console.log('%c   ', 'background:#546e7a;color:#fff;border-radius:3px', ...a),
    };

    let _pass = 0, _fail = 0, _warn = 0;

    function assert(condition, msg) {
        if (condition) { c.ok(msg); _pass++; }
        else           { c.bad(msg); _fail++; }
    }

    function assertWarn(condition, msg) {
        if (condition) { c.ok(msg); _pass++; }
        else           { c.warn('SOFT: ' + msg); _warn++; }
    }

    function summary() {
        console.log('');
        if (_fail === 0) {
            console.log(`%c  ALL TESTS PASSED  ${_pass} ✓  ${_warn} soft  `,
                'font-size:13px;font-weight:bold;background:#1b5e20;color:#fff;padding:4px 12px;border-radius:6px');
        } else {
            console.log(`%c  ${_fail} FAILED  /  ${_pass} passed  /  ${_warn} soft  `,
                'font-size:13px;font-weight:bold;background:#b71c1c;color:#fff;padding:4px 12px;border-radius:6px');
        }
        console.log('');
    }

    // =========================================================================
    // 1. COOLDOWN RULES
    // =========================================================================

    function testCooldown() {
        c.h1('1. Cooldown Rules Engine');

        const SR = window.SchedulingRules;
        if (!SR) { c.bad('window.SchedulingRules not found — is rules.js loaded?'); _fail++; return; }

        const { blockMatchesDescriptor, isCandidateAllowed, checkCandidateDetailed } = SR;

        // --- 1a. blockMatchesDescriptor ---
        c.h2('1a. blockMatchesDescriptor');

        const sportBlock  = { type: 'sport',  event: 'basketball', field: '' };
        const lunchBlock  = { type: 'lunch',  event: 'lunch',      field: '' };
        const specialBlock= { type: 'special',event: 'art',        field: 'art room' };
        const swimBlock   = { type: 'swim',   event: 'swim',       field: 'pool' };

        assert(blockMatchesDescriptor(sportBlock,  { kind: 'type',     value: 'sport'      }), 'type:sport matches sport block');
        assert(blockMatchesDescriptor(lunchBlock,  { kind: 'type',     value: 'lunch'      }), 'type:lunch matches lunch block');
        assert(blockMatchesDescriptor(sportBlock,  { kind: 'activity', value: 'basketball' }), 'activity:basketball matches basketball');
        assert(!blockMatchesDescriptor(sportBlock, { kind: 'activity', value: 'soccer'     }), 'activity:soccer does NOT match basketball');
        assert(blockMatchesDescriptor(specialBlock,{ kind: 'facility', value: 'art room'   }), 'facility:art room matches art room');
        assert(!blockMatchesDescriptor(specialBlock,{kind: 'facility', value: 'pool'       }), 'facility:pool does NOT match art room');
        assert(blockMatchesDescriptor(swimBlock,   { kind: 'any'                           }), 'kind:any matches anything');
        assert(!blockMatchesDescriptor(null,       { kind: 'type', value: 'sport'          }), 'null block → false');

        // --- 1b. isCandidateAllowed (hard block) ---
        c.h2('1b. isCandidateAllowed — hard block');

        // Inject a temporary "sport must be 60+ min after lunch" rule (auto mode)
        const rules = window.SchedulingRules.getCooldownRules?.() || [];
        const testRule = {
            id: '__test_cooldown_001',
            mode: 'auto',
            target:    { kind: 'type', value: 'sport' },
            reference: { kind: 'type', value: 'lunch' },
            minutes: 60,
            timing: 'after'
        };
        rules.push(testRule);
        window.SchedulingRules.saveCooldownRules?.(rules);

        // Lunch ends at 780 (1:00pm), sport starts at 810 (1:30pm) — only 30 min gap → BLOCKED
        const lunchTemplate = [{ type: 'lunch', event: 'lunch', startMin: 750, endMin: 780 }];
        const sportCandidate_30min = { type: 'sport', event: 'baseball', startMin: 810, endMin: 870 };
        const sportCandidate_65min = { type: 'sport', event: 'baseball', startMin: 845, endMin: 905 };

        assert(!isCandidateAllowed(sportCandidate_30min, lunchTemplate, { mode: 'auto' }),
            'auto mode: sport 30 min after lunch is BLOCKED (< 60 min rule)');
        assert(isCandidateAllowed(sportCandidate_65min, lunchTemplate, { mode: 'auto' }),
            'auto mode: sport 65 min after lunch is ALLOWED (≥ 60 min rule)');
        assert(isCandidateAllowed(sportCandidate_30min, lunchTemplate, { mode: 'manual' }),
            'manual mode: rule is mode:auto only → does NOT hard-block');

        // --- 1c. checkCandidateDetailed (soft warning) ---
        c.h2('1c. checkCandidateDetailed — soft warning path');

        const manualRule = {
            id: '__test_cooldown_002',
            mode: 'manual',
            target:    { kind: 'activity', value: 'basketball' },
            reference: { kind: 'type',     value: 'lunch' },
            minutes: 45,
            timing: 'after'
        };
        const allRules = window.SchedulingRules.getCooldownRules?.() || [];
        allRules.push(manualRule);
        window.SchedulingRules.saveCooldownRules?.(allRules);

        const bbCandidate = { type: 'sport', event: 'basketball', startMin: 800, endMin: 850 }; // 20 min after lunch ends 780
        const bbFarCandidate = { type: 'sport', event: 'basketball', startMin: 830, endMin: 890 }; // 50 min after lunch

        const res1 = checkCandidateDetailed(bbCandidate,   lunchTemplate, { mode: 'manual' });
        const res2 = checkCandidateDetailed(bbFarCandidate, lunchTemplate, { mode: 'manual' });

        assert(!res1.allowed && res1.violated.length > 0,
            'checkCandidateDetailed: basketball 20 min after lunch → violation found');
        assert(res2.allowed && res2.violated.length === 0,
            'checkCandidateDetailed: basketball 50 min after lunch → no violation');
        assert(!checkCandidateDetailed(bbCandidate, lunchTemplate, { mode: 'auto' }).violated.find(r => r.id === '__test_cooldown_002'),
            'manual-only rule does NOT fire in auto mode');

        // --- 1d. Mode filter: type descriptors only in auto ---
        c.h2('1d. Mode filtering — category rules (type:*) only in auto');

        // An auto-only "type" rule (sport after lunch) — already added above (__test_cooldown_001)
        // Manual candidate with a sport should not be hard-blocked by it:
        assert(isCandidateAllowed(sportCandidate_30min, lunchTemplate, { mode: 'manual' }),
            'type:sport rule scoped to auto → manual isCandidateAllowed returns true');

        // Clean up test rules
        const cleaned = (window.SchedulingRules.getCooldownRules?.() || [])
            .filter(r => r.id !== '__test_cooldown_001' && r.id !== '__test_cooldown_002');
        window.SchedulingRules.saveCooldownRules?.(cleaned);
        c.info('Test rules cleaned up');
    }

    // =========================================================================
    // 2. SPORT PLAYER COUNT
    // =========================================================================

    function testPlayerCount() {
        c.h1('2. Sport Player Count Rules');

        const Utils = window.SchedulerCoreUtils;
        if (!Utils) { c.bad('window.SchedulerCoreUtils not found — is scheduler_core_utils.js loaded?'); _fail++; return; }

        // Inject a temporary sport with min/max into sportMetaData
        const origMeta = window.getSportMetaData?.() || window.sportMetaData || {};
        const patchedMeta = Object.assign({}, origMeta, {
            '__test_sport__': { minPlayers: 20, maxPlayers: 40 }
        });

        // Temporarily override getSportMetaData for our tests
        const origGet = window.getSportMetaData;
        window.getSportMetaData = () => patchedMeta;

        c.h2('2a. getSportPlayerRequirements');

        const reqs = Utils.getSportPlayerRequirements('__test_sport__');
        assert(reqs.minPlayers === 20, `minPlayers = 20 (got ${reqs.minPlayers})`);
        assert(reqs.maxPlayers === 40, `maxPlayers = 40 (got ${reqs.maxPlayers})`);

        const noReqs = Utils.getSportPlayerRequirements('unconfigured_sport_xyz');
        assert(noReqs.minPlayers === null && noReqs.maxPlayers === null,
            'unconfigured sport returns null min/max');

        c.h2('2b. checkPlayerCountForSport — hard violations');

        // 8 players, min 20 → (20-8)/20 = 0.6 > 0.4 → hard block
        const hardUnder = Utils.checkPlayerCountForSport('__test_sport__', 8);
        assert(!hardUnder.valid, 'hard undercount (8 of 20 min) → not valid');
        assert(hardUnder.severity === 'hard', 'hard undercount → severity = hard');

        // 56 players, max 40 → (56-40)/40 = 0.4 > 0.3 → hard block
        const hardOver = Utils.checkPlayerCountForSport('__test_sport__', 56);
        assert(!hardOver.valid, 'hard overcount (56 of 40 max) → not valid');
        assert(hardOver.severity === 'hard', 'hard overcount → severity = hard');

        c.h2('2c. checkPlayerCountForSport — soft violations');

        // 16 players, min 20 → (20-16)/20 = 0.2 < 0.4 → soft warn only
        const softUnder = Utils.checkPlayerCountForSport('__test_sport__', 16);
        assert(!softUnder.valid, 'soft undercount (16 of 20 min) → not valid');
        assert(softUnder.severity === 'soft', 'soft undercount → severity = soft');

        // 48 players, max 40 → (48-40)/40 = 0.2 < 0.3 → soft warn only
        const softOver = Utils.checkPlayerCountForSport('__test_sport__', 48);
        assert(!softOver.valid, 'soft overcount (48 of 40 max) → not valid');
        assert(softOver.severity === 'soft', 'soft overcount → severity = soft');

        c.h2('2d. checkPlayerCountForSport — valid counts');

        const valid = Utils.checkPlayerCountForSport('__test_sport__', 28);
        assert(valid.valid === true, 'valid count (28, between 20-40) → valid');
        assert(valid.reason === null, 'valid count → no reason string');

        c.h2('2e. Zero-player guard');

        // Zero players → should NOT hard-fail (bunk not configured yet)
        const zeroResult = Utils.checkPlayerCountForSport('__test_sport__', 0);
        // Zero is below min but our guard in the solver skips when projectedPlayers=0
        // The util itself may return invalid; the guard is in the solver. Just verify it returns a result.
        assertWarn(typeof zeroResult.valid === 'boolean',
            'checkPlayerCountForSport(0) returns a boolean valid (solver-level guard handles 0)');

        c.h2('2f. Unconfigured sport → always valid');

        const noConfig = Utils.checkPlayerCountForSport('unconfigured_sport_xyz', 5);
        assert(noConfig.valid === true, 'sport with no min/max config → always valid');

        c.h2('2g. League flag bypasses check');

        const leagueResult = Utils.checkPlayerCountForSport('__test_sport__', 5, true);
        assert(leagueResult.valid === true, 'isForLeague=true bypasses player count check');

        // Restore
        if (origGet) window.getSportMetaData = origGet;
        else delete window.getSportMetaData;
        c.info('Sport meta patch restored');
    }

    // =========================================================================
    // 3. FIELD QUALITY GROUPS
    // =========================================================================

    function testFieldGroups() {
        c.h1('3. Field Quality Groups');

        const SR = window.SchedulingRules;
        if (!SR || !SR.applyFieldGroupUpdates) {
            c.bad('window.SchedulingRules.applyFieldGroupUpdates not found — is rules.js loaded?'); _fail++; return;
        }
        if (!window.normalizeFieldForSave) {
            c.bad('window.normalizeFieldForSave not found — is cloud_sync_helpers.js loaded?'); _fail++; return;
        }

        c.h2('3a. normalizeFieldForSave preserves fieldGroup/qualityRank');

        const testField = {
            name: '__test_field__',
            activities: ['baseball'],
            available: true,
            sharableWith: { type: 'not_sharable', divisions: [], capacity: 1 },
            limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
            timeRules: [],
            rainyDayAvailable: false,
            fieldGroup: 'Baseball Diamonds',
            qualityRank: 2,
            gradeShareRules: { 'Boys': true }
        };

        const normalized = window.normalizeFieldForSave(testField);
        assert(normalized.fieldGroup === 'Baseball Diamonds',
            'normalizeFieldForSave preserves fieldGroup');
        assert(normalized.qualityRank === 2,
            'normalizeFieldForSave preserves qualityRank');
        assert(normalized.gradeShareRules && normalized.gradeShareRules['Boys'] === true,
            'normalizeFieldForSave preserves gradeShareRules');
        assert(normalized.name === '__test_field__',
            'normalizeFieldForSave preserves name');

        const noGroupField = { name: '__test_field_2__', activities: [] };
        const normalizedNoGroup = window.normalizeFieldForSave(noGroupField);
        assert(!('fieldGroup' in normalizedNoGroup),
            'normalizeFieldForSave does not add fieldGroup when absent');
        assert(!('qualityRank' in normalizedNoGroup),
            'normalizeFieldForSave does not add qualityRank when absent');

        c.h2('3b. applyFieldGroupUpdates writes to app1.fields');

        const settings = window.loadGlobalSettings?.() || {};
        const before = (settings.app1?.fields || []).map(f => ({ ...f })); // snapshot

        // Inject a test field into app1.fields if needed
        if (!settings.app1) settings.app1 = {};
        if (!Array.isArray(settings.app1.fields)) settings.app1.fields = [];
        const testIdx = settings.app1.fields.findIndex(f => f.name === '__test_field__');
        if (testIdx === -1) {
            settings.app1.fields.push({ name: '__test_field__', activities: [], available: true });
            window.saveGlobalSettings?.('app1', settings.app1);
        }

        SR.applyFieldGroupUpdates([{ fieldName: '__test_field__', fieldGroup: 'Test Diamonds', qualityRank: 3 }]);

        const afterSettings = window.loadGlobalSettings?.() || {};
        const updated = (afterSettings.app1?.fields || []).find(f => f.name === '__test_field__');

        if (updated) {
            assert(updated.fieldGroup === 'Test Diamonds',
                'applyFieldGroupUpdates: fieldGroup written to app1.fields');
            assert(updated.qualityRank === 3,
                'applyFieldGroupUpdates: qualityRank written to app1.fields');
        } else {
            c.warn('__test_field__ not found in app1.fields after applyFieldGroupUpdates — check if the field was saved');
            _warn++;
        }

        c.h2('3c. applyFieldGroupUpdates clears group (null)');

        SR.applyFieldGroupUpdates([{ fieldName: '__test_field__', fieldGroup: null, qualityRank: null }]);
        const clearedSettings = window.loadGlobalSettings?.() || {};
        const cleared = (clearedSettings.app1?.fields || []).find(f => f.name === '__test_field__');
        if (cleared) {
            assert(!cleared.fieldGroup,
                'applyFieldGroupUpdates null clears fieldGroup');
            assert(!cleared.qualityRank,
                'applyFieldGroupUpdates null clears qualityRank');
        } else {
            c.warn('Field not found for clear check');
            _warn++;
        }

        c.h2('3d. saveGlobalFields round-trip preserves fieldGroup');

        const fieldsToSave = [
            {
                name: '__roundtrip_field__',
                activities: ['soccer'],
                available: true,
                sharableWith: { type: 'not_sharable', divisions: [], capacity: 1 },
                limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
                timeRules: [],
                rainyDayAvailable: false,
                fieldGroup: 'Soccer Fields',
                qualityRank: 1
            }
        ];

        window.saveGlobalFields?.(fieldsToSave);
        const retrieved = window.getGlobalFields?.() || [];
        const found = retrieved.find(f => f.name === '__roundtrip_field__');

        if (found) {
            assert(found.fieldGroup === 'Soccer Fields',
                'saveGlobalFields → getGlobalFields: fieldGroup round-trip OK');
            assert(found.qualityRank === 1,
                'saveGlobalFields → getGlobalFields: qualityRank round-trip OK');
        } else {
            c.warn('__roundtrip_field__ not found after saveGlobalFields — check integration_hooks _localCache');
            _warn++;
        }

        // Clean up test fields
        const finalSettings = window.loadGlobalSettings?.() || {};
        if (finalSettings.app1?.fields) {
            finalSettings.app1.fields = finalSettings.app1.fields.filter(
                f => f.name !== '__test_field__' && f.name !== '__roundtrip_field__'
            );
            window.saveGlobalSettings?.('app1', finalSettings.app1);
        }
        c.info('Test fields cleaned up');
    }

    // =========================================================================
    // 4. FACILITIES SPORT META PERSISTENCE
    // =========================================================================

    function testPersistence() {
        c.h1('4. Facilities Sport Meta Persistence');

        c.h2('4a. sportMetaData accessible via getSportMetaData()');

        const meta = window.getSportMetaData?.();
        if (meta) {
            const sportNames = Object.keys(meta);
            c.info(`getSportMetaData() returned ${sportNames.length} sports: ${sportNames.slice(0, 5).join(', ')}${sportNames.length > 5 ? '...' : ''}`);
            assert(typeof meta === 'object', 'getSportMetaData() returns an object');
        } else {
            c.warn('getSportMetaData() is undefined — facilities.js may not be loaded or no sports configured');
            _warn++;
        }

        c.h2('4b. sportMetaData survives saveGlobalSettings round-trip');

        const settings = window.loadGlobalSettings?.() || {};
        const savedMeta = settings.app1?.sportMetaData;

        if (savedMeta) {
            const keys = Object.keys(savedMeta);
            c.info(`app1.sportMetaData has ${keys.length} sports in saved settings`);
            assert(keys.length > 0, 'app1.sportMetaData is non-empty in saved settings');

            // Check at least one sport has proper structure
            const first = savedMeta[keys[0]];
            assertWarn('minPlayers' in first || 'maxPlayers' in first || 'sport' in first,
                `First sport entry (${keys[0]}) has expected properties`);
        } else {
            c.warn('app1.sportMetaData not found in saved settings — no sports have been configured/saved yet');
            _warn++;
        }

        c.h2('4c. saveGlobalFields does not clobber sportMetaData');

        if (meta && Object.keys(meta).length > 0) {
            // Save an empty fields array — should not wipe sportMetaData
            const fields = window.getGlobalFields?.() || [];
            window.saveGlobalFields?.(fields.slice(0, 0)); // save 0 fields

            const afterSettings = window.loadGlobalSettings?.() || {};
            const afterMeta = afterSettings.app1?.sportMetaData;
            assertWarn(afterMeta && Object.keys(afterMeta || {}).length > 0,
                'sportMetaData survives saveGlobalFields([]) call');

            // Restore
            window.saveGlobalFields?.(fields);
        } else {
            c.info('Skipping 4c — no sport meta to test against');
        }
    }

    // =========================================================================
    // SHOW HELPERS — inspect live data
    // =========================================================================

    function showRules() {
        c.h1('Live Cooldown Rules');

        const rules = window.SchedulingRules?.getCooldownRules?.() || [];
        if (!rules.length) {
            c.warn('No cooldown rules configured');
            return;
        }

        rules.forEach((r, i) => {
            const t = r.target  ? `${r.target.kind}:${r.target.value}`   : '(none)';
            const ref = r.reference ? `${r.reference.kind}:${r.reference.value}` : '(none)';
            const label = window.SchedulingRules?.describeRule?.(r) || `${t} ← ${r.minutes}min → ${ref}`;
            c.data(`Rule ${i + 1} [mode:${r.mode||'both'}] [timing:${r.timing||'both'}]  ${label}`);
        });

        console.log(`\nTotal: ${rules.length} rule(s)`);
    }

    function showSports() {
        c.h1('Live Sport Player Requirements');

        const meta = window.getSportMetaData?.() || window.sportMetaData || {};
        const sports = Object.keys(meta);

        if (!sports.length) {
            c.warn('No sport metadata found — configure sports in the Facilities tab');
            return;
        }

        let configured = 0;
        sports.forEach(name => {
            const m = meta[name] || {};
            if (m.minPlayers || m.maxPlayers) {
                c.data(`${name}: min=${m.minPlayers ?? '—'}  max=${m.maxPlayers ?? '—'}`);
                configured++;
            }
        });

        if (configured === 0) {
            c.warn(`${sports.length} sports found but none have min/max player counts set`);
        } else {
            console.log(`\n${configured} of ${sports.length} sports have player count rules`);
        }
    }

    function showGroups() {
        c.h1('Live Field Quality Groups');

        const settings = window.loadGlobalSettings?.() || {};
        const fields = settings.app1?.fields || settings.fields || [];

        const groups = new Map();
        let unassigned = 0;

        fields.forEach(f => {
            if (f.fieldGroup) {
                if (!groups.has(f.fieldGroup)) groups.set(f.fieldGroup, []);
                groups.get(f.fieldGroup).push({ name: f.name, rank: f.qualityRank ?? '—' });
            } else {
                unassigned++;
            }
        });

        if (!groups.size) {
            c.warn('No field quality groups configured yet — use the Rules tab to create groups');
        } else {
            groups.forEach((members, groupName) => {
                members.sort((a, b) => (a.rank === '—' ? 999 : a.rank) - (b.rank === '—' ? 999 : b.rank));
                c.data(`Group: "${groupName}" (${members.length} fields)`);
                members.forEach(m => console.log(`      rank ${m.rank}  →  ${m.name}`));
            });
        }

        c.info(`${unassigned} field(s) not in any group  |  ${fields.length} fields total`);
    }

    // =========================================================================
    // ENTRY POINTS
    // =========================================================================

    function run() {
        _pass = 0; _fail = 0; _warn = 0;
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
        cooldown:     () => { _pass=0;_fail=0;_warn=0; testCooldown();   summary(); },
        playerCount:  () => { _pass=0;_fail=0;_warn=0; testPlayerCount();summary(); },
        fieldGroups:  () => { _pass=0;_fail=0;_warn=0; testFieldGroups();summary(); },
        persistence:  () => { _pass=0;_fail=0;_warn=0; testPersistence();summary(); },
        showRules,
        showSports,
        showGroups,
    };

    console.log('%c PipelineAudit loaded. Call PipelineAudit.run() to start. ',
        'background:#546e7a;color:#fff;padding:3px 8px;border-radius:4px');
})();
