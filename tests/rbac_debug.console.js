// =============================================================================
// rbac_debug.console.js — RBAC State Diagnostic
// =============================================================================
// Paste into browser console on flow.html (or any page that loads RBAC).
// Prints a full snapshot of every RBAC module's state and permission checks.
//
// Usage:
//   1. Open flow.html and log in
//   2. Open DevTools → Console
//   3. Paste this entire script and press Enter
// =============================================================================

(async function RBACDebug() {
    'use strict';

    // =========================================================================
    // HELPERS
    // =========================================================================

    const PASS  = (label, value) => console.log(`  %c✅ ${label}%c`, 'color:#16a34a;font-weight:bold', 'color:inherit', value !== undefined ? value : '');
    const FAIL  = (label, value) => console.log(`  %c❌ ${label}%c`, 'color:#dc2626;font-weight:bold', 'color:inherit', value !== undefined ? value : '');
    const INFO  = (label, value) => console.log(`  %cℹ️  ${label}%c`, 'color:#2563eb;font-weight:bold', 'color:inherit', value !== undefined ? value : '');
    const WARN  = (label, value) => console.log(`  %c⚠️  ${label}%c`, 'color:#d97706;font-weight:bold', 'color:inherit', value !== undefined ? value : '');
    const HEAD  = (title)        => console.log(`\n%c━━━ ${title} ━━━`, 'color:#7c3aed;font-weight:bold;font-size:13px');
    const SUBH  = (title)        => console.log(`%c  ▸ ${title}`, 'color:#6b7280;font-style:italic');

    function check(label, value, expect) {
        if (value === expect || (expect === true && !!value) || (expect === false && !value)) {
            PASS(label, value);
        } else {
            FAIL(`${label} (expected: ${expect})`, value);
        }
    }

    let passCount = 0, warnCount = 0, failCount = 0;

    function tally(ok, warning = false) {
        if (warning) warnCount++;
        else if (ok) passCount++;
        else failCount++;
    }

    // =========================================================================
    // HEADER
    // =========================================================================

    console.log('%c🔐 RBAC DEBUG SNAPSHOT', 'font-size:16px;font-weight:bold;color:#7c3aed');
    console.log(`%c   ${new Date().toLocaleTimeString()} — ${window.location.pathname}`, 'color:#6b7280');

    // =========================================================================
    // SECTION 1: MODULE PRESENCE
    // =========================================================================

    HEAD('MODULE PRESENCE');

    const modules = {
        'AccessControl':              window.AccessControl,
        'VisualRestrictions':         window.VisualRestrictions,
        'EditRestrictions':           window.EditRestrictions,
        'RBACIntegration':            window.RBACIntegration,
        'RBACInit':                   window.RBACInit,
        'PermissionsDB':              window.PermissionsDB,
        'SubdivisionScheduleManager': window.SubdivisionScheduleManager,
        'DivisionSelector':           window.DivisionSelector,
    };

    for (const [name, mod] of Object.entries(modules)) {
        if (mod) {
            PASS(name, 'loaded');
            tally(true);
        } else {
            WARN(`${name}`, 'not found (may not be needed on this page)');
            tally(true, true);
        }
    }

    if (!window.AccessControl) {
        FAIL('AccessControl is MISSING — cannot run further checks', '');
        console.log('%c   Run this script on flow.html after logging in.', 'color:#dc2626');
        return;
    }

    // =========================================================================
    // SECTION 2: ACCESSCONTROL STATE
    // =========================================================================

    HEAD('ACCESS CONTROL STATE');

    const ac = window.AccessControl;

    const role       = ac.getCurrentRole?.();
    const initialized = ac.isInitialized;
    const isOwner    = ac.isOwner?.();
    const isAdmin    = ac.isAdmin?.();
    const isScheduler = ac.isScheduler?.();
    const isViewer   = ac.isViewer?.();
    const editable   = ac.getEditableDivisions?.() || [];
    const userInfo   = ac.getCurrentUserInfo?.();
    const campName   = ac.getCampName?.();
    const subdivisions = ac.getSubdivisions?.() || [];
    const subIds     = ac.getUserSubdivisionIds?.() || [];
    const subDetails = ac.getUserSubdivisionDetails?.() || [];
    const directDivs = ac.getDirectDivisionAssignments?.() || [];

    if (initialized) { PASS('isInitialized', true); tally(true); }
    else              { FAIL('isInitialized — module not ready!', false); tally(false); }

    if (role) { INFO('role', role); }
    else      { FAIL('role is null/undefined', role); tally(false); }

    INFO('isOwner',     isOwner);
    INFO('isAdmin',     isAdmin);
    INFO('isScheduler', isScheduler);
    INFO('isViewer',    isViewer);

    if (userInfo) {
        INFO('userId',  userInfo.userId);
        INFO('email',   userInfo.email);
        INFO('name',    userInfo.name);
    } else {
        WARN('getCurrentUserInfo() returned null', '');
    }

    INFO('campName',         campName || '(none)');
    INFO('editableDivisions', editable.length ? editable : '(none)');
    INFO('allSubdivisions',  `${subdivisions.length} loaded`);
    INFO('userSubdivisionIds', subIds.length ? subIds : '(none)');
    INFO('userSubdivisionDetails', subDetails.length ? subDetails.map(s => s.name) : '(none)');
    INFO('directDivisionAssignments', directDivs.length ? directDivs : '(none)');

    // Role sanity checks
    SUBH('Role sanity');
    const rolePriority = { owner: 4, admin: 3, scheduler: 2, viewer: 1 };
    const roleFlags = [isOwner, isAdmin, isScheduler, isViewer].filter(Boolean).length;

    if (role === 'scheduler' && editable.length === 0) {
        WARN('Scheduler has NO editable divisions — contact owner to assign subdivisions', '');
        tally(false, true);
    } else {
        tally(true);
    }

    if (roleFlags === 0) {
        FAIL('No role flags are true — module may not have initialized correctly', '');
        tally(false);
    } else if (roleFlags > 1 && !(isAdmin && isOwner)) {
        // isAdmin returns true for both owner+admin — that's expected
        tally(true);
    } else {
        tally(true);
    }

    // =========================================================================
    // SECTION 3: PERMISSION CHECKS
    // =========================================================================

    HEAD('PERMISSION CHECK RESULTS');
    SUBH('Feature permissions');

    const permChecks = [
        ['canSave()',                 ac.canSave?.()],
        ['canEditAnything()',         ac.canEditAnything?.()],
        ['canRunGenerator()',         ac.canRunGenerator?.()],
        ['canInviteUsers()',          ac.canInviteUsers?.()],
        ['canManageTeam()',           ac.canManageTeam?.()],
        ['canManageSubdivisions()',   ac.canManageSubdivisions?.()],
        ['canEraseData()',            ac.canEraseData?.()],
        ['canEraseAllCampData()',     ac.canEraseAllCampData?.()],
        ['canDeleteCampData()',       ac.canDeleteCampData?.()],
        ['canEditFields()',           ac.canEditFields?.()],
        ['canEditGlobalFields()',     ac.canEditGlobalFields?.()],
        ['canEditSetup()',            ac.canEditSetup?.()],
        ['canEditPrintTemplates()',   ac.canEditPrintTemplates?.()],
        ['canDeletePrintTemplates()', ac.canDeletePrintTemplates?.()],
        ['canPrintSchedules()',       ac.canPrintSchedules?.()],
        ['canPrint()',                ac.canPrint?.()],
        ['canUseCamperLocator()',     ac.canUseCamperLocator?.()],
        ['canViewDailySchedule()',    ac.canViewDailySchedule?.()],
    ];

    for (const [label, value] of permChecks) {
        if (value === undefined) {
            WARN(`${label}`, 'method not found');
        } else if (value) {
            PASS(label, '✓ allowed');
        } else {
            INFO(label, '✗ denied');
        }
    }

    // Division-level checks
    if (editable.length > 0) {
        SUBH('Division-level permissions (first 5 editable)');
        for (const div of editable.slice(0, 5)) {
            const canEdit = ac.canEditDivision?.(div);
            if (canEdit) { PASS(`canEditDivision("${div}")`, '✓'); tally(true); }
            else         { FAIL(`canEditDivision("${div}") — should be true!`, '✗'); tally(false); }
        }

        // Sample check: a division the scheduler should NOT be able to edit
        if (role === 'scheduler') {
            const allDivs = Object.keys(window.divisions || {});
            const lockedDivs = allDivs.filter(d => !editable.includes(d));
            if (lockedDivs.length > 0) {
                SUBH('Division lock check (first non-editable)');
                const locked = lockedDivs[0];
                const shouldBeLocked = !ac.canEditDivision?.(locked);
                if (shouldBeLocked) { PASS(`canEditDivision("${locked}") correctly returns false`, '✗'); tally(true); }
                else                { FAIL(`canEditDivision("${locked}") returned true — should be locked!`, '✓'); tally(false); }
            }
        }
    }

    // =========================================================================
    // SECTION 4: SESSION CACHE
    // =========================================================================

    HEAD('SESSION & LOCAL STORAGE CACHE');

    const rawCache = sessionStorage.getItem('campistry_rbac_cache');
    if (rawCache) {
        try {
            const cache = JSON.parse(rawCache);
            const ageMin = ((Date.now() - cache.cachedAt) / 60000).toFixed(1);
            INFO('sessionStorage cache', 'present');
            INFO('  cached role',     cache.role);
            INFO('  cached campId',   cache.campId);
            INFO('  cache age',       `${ageMin} minutes`);
            INFO('  userId matches',  cache.userId === userInfo?.userId ? '✅ yes' : '❌ NO MATCH');
            tally(cache.userId === userInfo?.userId);
        } catch (e) {
            FAIL('sessionStorage cache parse error', e.message);
            tally(false);
        }
    } else {
        INFO('sessionStorage cache', '(none — using full Supabase resolution)');
    }

    SUBH('localStorage RBAC values');
    const lsKeys = [
        'campistry_role',
        'campistry_user_id',
        'campistry_auth_user_id',
        'campistry_is_team_member',
    ];
    for (const key of lsKeys) {
        const val = localStorage.getItem(key);
        if (val !== null) INFO(key, val);
        else              WARN(key, '(not set)');
    }

    // Check for role mismatch between localStorage and AccessControl
    const lsRole = localStorage.getItem('campistry_role');
    if (lsRole && role && lsRole !== role) {
        WARN(`localStorage role "${lsRole}" doesn't match AC role "${role}" — may indicate a mid-session change`, '');
        tally(false, true);
    } else if (lsRole && role) {
        PASS('localStorage role matches AccessControl role', role);
        tally(true);
    }

    // =========================================================================
    // SECTION 5: VISUAL RESTRICTIONS STATE
    // =========================================================================

    HEAD('VISUAL RESTRICTIONS STATE');

    const vr = window.VisualRestrictions || window.EditRestrictions;
    if (!vr) {
        WARN('VisualRestrictions not loaded (expected on viewer/scheduler pages)', '');
    } else {
        // Same object check
        if (window.VisualRestrictions === window.EditRestrictions) {
            PASS('EditRestrictions alias points to same object', '✓');
        } else {
            WARN('EditRestrictions and VisualRestrictions are different objects', '');
        }

        // Frozen check (tamper-proof)
        if (Object.isFrozen(vr)) {
            PASS('VisualRestrictions is Object.frozen()', '✓ tamper-proof');
            tally(true);
        } else {
            FAIL('VisualRestrictions is NOT frozen — monkey-patching possible!', '');
            tally(false);
        }

        // Check window property is non-configurable
        const vrDesc = Object.getOwnPropertyDescriptor(window, 'VisualRestrictions');
        if (vrDesc && vrDesc.configurable === false && vrDesc.writable === false) {
            PASS('window.VisualRestrictions is non-writable/configurable', '✓');
            tally(true);
        } else {
            WARN('window.VisualRestrictions may be replaceable', vrDesc);
            tally(false, true);
        }
    }

    // =========================================================================
    // SECTION 6: ACCESSCONTROL TAMPER-PROOF CHECK
    // =========================================================================

    HEAD('TAMPER-PROOF CHECKS');

    // Is AccessControl frozen?
    if (Object.isFrozen(ac)) {
        PASS('AccessControl is Object.frozen()', '✓');
        tally(true);
    } else {
        FAIL('AccessControl is NOT frozen — monkey-patching possible!', '');
        tally(false);
    }

    // Is window.AccessControl non-configurable?
    const acDesc = Object.getOwnPropertyDescriptor(window, 'AccessControl');
    if (acDesc && acDesc.configurable === false && acDesc.writable === false) {
        PASS('window.AccessControl is non-writable/configurable', '✓');
        tally(true);
    } else {
        WARN('window.AccessControl property may be replaceable', acDesc);
        tally(false, true);
    }

    // =========================================================================
    // SECTION 7: PERMISSIONSDB CONSISTENCY
    // =========================================================================

    HEAD('PERMISSIONSDB CONSISTENCY');

    const pdb = window.PermissionsDB;
    if (!pdb) {
        WARN('PermissionsDB not loaded', '');
    } else {
        const pdbDivs  = pdb.getEditableDivisions?.() || [];
        const acDivs   = ac.getEditableDivisions?.() || [];
        const pdbRole  = pdb.isReadOnly?.() ? 'read-only' : 'writable';
        const pdbFull  = pdb.hasFullAccess?.();

        INFO('PermissionsDB.isReadOnly()',  pdb.isReadOnly?.());
        INFO('PermissionsDB.hasFullAccess()', pdbFull);
        INFO('PermissionsDB editableDivisions', pdbDivs.length ? pdbDivs : '(none)');

        // Check consistency with AccessControl
        const pdbSet = new Set(pdbDivs);
        const acSet  = new Set(acDivs);
        const inPdbNotAc = pdbDivs.filter(d => !acSet.has(d));
        const inAcNotPdb = acDivs.filter(d => !pdbSet.has(d));

        if (inPdbNotAc.length === 0 && inAcNotPdb.length === 0) {
            PASS('PermissionsDB and AccessControl editable divisions match', '✓');
            tally(true);
        } else {
            WARN('Division mismatch between PermissionsDB and AccessControl', {
                inPdbNotAc,
                inAcNotPdb
            });
            tally(false, true);
        }
    }

    // =========================================================================
    // SECTION 8: RBACINTEGRATION STATE
    // =========================================================================

    HEAD('RBAC INTEGRATION');

    const ri = window.RBACIntegration;
    if (!ri) {
        WARN('RBACIntegration not loaded', '');
    } else {
        const uiCfg = ri.getUIConfig?.();
        if (uiCfg) {
            INFO('showGenerateButton', uiCfg.showGenerateButton);
            INFO('showClearButton',    uiCfg.showClearButton);
            INFO('showEditButtons',    uiCfg.showEditButtons);
            INFO('showTeamSection',    uiCfg.showTeamSection);
            INFO('canDragDrop',        uiCfg.canDragDrop);
            INFO('canInlineEdit',      uiCfg.canInlineEdit);
        }

        // Check generate button presence
        const genBtn = document.querySelector('#generate-btn, [data-action="generate"], .generate-button');
        if (genBtn) {
            const isVisible = genBtn.style.display !== 'none' && !genBtn.disabled;
            INFO('Generate button found', genBtn.id || genBtn.className);
            INFO('Generate button visible/enabled', isVisible);
            if (!uiCfg?.showGenerateButton && isVisible) {
                WARN('Generate button is visible but UI config says to hide it — possible timing issue', '');
                tally(false, true);
            }
        } else {
            INFO('Generate button', 'not found in DOM');
        }
    }

    // =========================================================================
    // SECTION 9: WINDOW.DIVISIONS SNAPSHOT
    // =========================================================================

    HEAD('WINDOW.DIVISIONS SNAPSHOT');

    const allDivs = Object.keys(window.divisions || {});
    if (allDivs.length === 0) {
        WARN('window.divisions is empty — data may not have loaded yet', '');
        tally(false, true);
    } else {
        INFO('Total divisions loaded', allDivs.length);
        INFO('Divisions', allDivs);
        if (role === 'scheduler' || role === 'admin' || role === 'owner') {
            INFO('Editable subset', editable);
            INFO('Locked subset',  allDivs.filter(d => !editable.includes(d)));
        }
    }

    // =========================================================================
    // SECTION 10: VERIFYBEFOREWRITE READINESS
    // =========================================================================

    HEAD('WRITE VERIFICATION READINESS');

    if (typeof ac.verifyBeforeWrite === 'function') {
        PASS('verifyBeforeWrite() method present', '✓');
        tally(true);
        INFO('Note', 'Call await AccessControl.verifyBeforeWrite("test") to run a live DB check');
    } else {
        FAIL('verifyBeforeWrite() is missing!', '');
        tally(false);
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================

    HEAD('SUMMARY');

    const total = passCount + warnCount + failCount;
    console.log(`  %c${passCount} passed  %c${warnCount} warnings  %c${failCount} failed  %c(${total} checks)`,
        'color:#16a34a;font-weight:bold',
        'color:#d97706;font-weight:bold',
        failCount > 0 ? 'color:#dc2626;font-weight:bold' : 'color:#6b7280',
        'color:#6b7280'
    );

    if (failCount === 0 && warnCount === 0) {
        console.log('%c  🎉 All RBAC checks clean!', 'color:#16a34a;font-weight:bold;font-size:13px');
    } else if (failCount === 0) {
        console.log(`%c  ⚠️  ${warnCount} warning(s) — review above`, 'color:#d97706;font-weight:bold');
    } else {
        console.log(`%c  ❌ ${failCount} failure(s) found — review above`, 'color:#dc2626;font-weight:bold;font-size:13px');
    }

    console.log('\n%c  Tip: call AccessControl.getRole() / getEditableDivisions() / getCurrentUserInfo() directly for live values.',
        'color:#6b7280;font-style:italic');

    return {
        role,
        initialized,
        editableDivisions: editable,
        userInfo,
        campName,
        subdivisions: subdivisions.length,
        passCount,
        warnCount,
        failCount
    };

})();
