// =============================================================================
// Me Page CRUD Test Recorder v2 — paste into browser console on campistry_me.html
//
// Intercepts saveGlobalSettings calls and logs what's being saved.
// Also tracks camper add/edit/delete/import operations.
// Run through the checklist, then call MeTestRecorder.report() to see results.
// =============================================================================

(function() {
    'use strict';

    const _log = [];
    let _testNum = 0;
    const _origSave = window.saveGlobalSettings;
    let _prevCamperCount = 0;
    let _prevDivCount = 0;
    let _prevBunkCount = 0;

    // Capture initial state
    try {
        const s = window.loadGlobalSettings?.() || {};
        const r = s.campistryMe?.roster || s.campistryMeRoster || {};
        _prevCamperCount = Object.keys(r).length;
        const st = s.campStructure || {};
        _prevDivCount = Object.keys(st).length;
        for (const d of Object.values(st)) {
            if (d.grades) for (const g of Object.values(d.grades)) _prevBunkCount += (g.bunks || []).length;
        }
    } catch(e) {}

    function record(action, details) {
        _log.push({
            num: ++_testNum,
            time: new Date().toLocaleTimeString(),
            action,
            details,
        });
        console.log(`%c[RECORDER #${_testNum}] ${action}`, 'color: #00bcd4; font-weight: bold;', details);
    }

    // Intercept saveGlobalSettings to log every save
    window.saveGlobalSettings = function(key, data) {
        if (key === 'campStructure' && data) {
            const summary = { divisions: Object.keys(data), totalGrades: 0, totalBunks: 0 };
            for (const div of Object.values(data)) {
                if (div.grades) {
                    for (const [gName, gData] of Object.entries(div.grades)) {
                        summary.totalGrades++;
                        summary.totalBunks += (gData.bunks || []).length;
                    }
                }
            }
            const divDelta = summary.divisions.length - _prevDivCount;
            const bunkDelta = summary.totalBunks - _prevBunkCount;
            if (divDelta !== 0) summary.divChange = (divDelta > 0 ? '+' : '') + divDelta;
            if (bunkDelta !== 0) summary.bunkChange = (bunkDelta > 0 ? '+' : '') + bunkDelta;
            _prevDivCount = summary.divisions.length;
            _prevBunkCount = summary.totalBunks;
            record('SAVE campStructure', summary);
        } else if (key === 'app1') {
            record('SAVE app1', { keys: Object.keys(data || {}).slice(0, 10) });
        } else if (key === 'campistryMe') {
            const roster = data?.roster || {};
            const count = Object.keys(roster).length;
            const delta = count - _prevCamperCount;
            const summary = { camperCount: count };
            if (delta !== 0) summary.change = (delta > 0 ? '+' : '') + delta + ' camper(s)';
            _prevCamperCount = count;
            record('SAVE campistryMe', summary);
        } else {
            record('SAVE ' + key, { type: typeof data });
        }

        return _origSave.call(this, key, data);
    };

    // Preserve flags from the original
    if (_origSave._isAuthoritativeHandler) {
        window.saveGlobalSettings._isAuthoritativeHandler = true;
    }
    if (_origSave._cloudHelpersHooked) {
        window.saveGlobalSettings._cloudHelpersHooked = true;
    }

    window.MeTestRecorder = {
        snapshot() {
            const settings = window.loadGlobalSettings?.() || {};
            const structure = settings.campStructure || {};
            const roster = settings.campistryMe?.roster || settings.campistryMeRoster || {};
            const snap = { divisions: {}, camperCount: Object.keys(roster).length, sampleCampers: [] };
            for (const [dName, dData] of Object.entries(structure)) {
                snap.divisions[dName] = {};
                if (dData.grades) {
                    for (const [gName, gData] of Object.entries(dData.grades)) {
                        snap.divisions[dName][gName] = (gData.bunks || []).slice();
                    }
                }
            }
            // Show first 5 campers as sample
            const names = Object.keys(roster).slice(0, 5);
            names.forEach(n => {
                const c = roster[n];
                snap.sampleCampers.push({
                    name: n,
                    division: c.division || '',
                    grade: c.grade || '',
                    bunk: c.bunk || ''
                });
            });
            if (Object.keys(roster).length > 5) {
                snap.sampleCampers.push('... and ' + (Object.keys(roster).length - 5) + ' more');
            }
            console.log('%c[SNAPSHOT]', 'color: #ff9800; font-weight: bold;', JSON.stringify(snap, null, 2));
            return snap;
        },

        report() {
            console.log('%c\n========== ME PAGE TEST REPORT ==========', 'color: #4caf50; font-weight: bold; font-size: 14px;');
            console.log(`Total saves recorded: ${_log.length}`);
            console.log('');

            // Group by timestamp to show operations clearly
            let lastTime = '';
            _log.forEach(entry => {
                if (entry.time !== lastTime) {
                    console.log(`  --- ${entry.time} ---`);
                    lastTime = entry.time;
                }
                console.log(`  #${entry.num} ${entry.action}`, entry.details);
            });
            console.log('');

            // Check current state
            const settings = window.loadGlobalSettings?.() || {};
            const structure = settings.campStructure || {};
            const roster = settings.campistryMe?.roster || settings.campistryMeRoster || {};
            const divCount = Object.keys(structure).length;
            let gradeCount = 0, bunkCount = 0;
            for (const d of Object.values(structure)) {
                if (d.grades) {
                    for (const g of Object.values(d.grades)) {
                        gradeCount++;
                        bunkCount += (g.bunks || []).length;
                    }
                }
            }
            const camperCount = Object.keys(roster).length;
            console.log(`Current state: ${divCount} divisions, ${gradeCount} grades, ${bunkCount} bunks, ${camperCount} campers`);
            console.log('%c==========================================\n', 'color: #4caf50; font-weight: bold; font-size: 14px;');
            return { saves: _log.length, divCount, gradeCount, bunkCount, camperCount };
        },

        log: _log,

        restore() {
            window.saveGlobalSettings = _origSave;
            console.log('%c[RECORDER] Restored original saveGlobalSettings', 'color: #f44336;');
        }
    };

    console.log('%c[RECORDER v2] Me Page CRUD + Camper Test Recorder active!', 'color: #4caf50; font-weight: bold; font-size: 14px;');
    console.log('Commands:');
    console.log('  MeTestRecorder.snapshot()  — show structure + campers');
    console.log('  MeTestRecorder.report()    — show all recorded saves');
    console.log('  MeTestRecorder.restore()   — unhook and restore original');
})();
