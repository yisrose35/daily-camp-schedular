// =============================================================================
// campistry_setup_checklist.js — the guided setup for a camp that's just started
//
// A new camp lands on a page of empty tables with no indication of what to do
// first, in what order, or when they're finished. The order genuinely matters —
// bunks can't be built before divisions exist, tuition can't be charged before
// a session exists — and getting it wrong means backtracking.
//
// So: a checklist that reads the camp's actual data rather than tracking
// "steps completed" separately. A camp that imported its roster before ever
// seeing this sees that step already ticked; a camp that deletes everything
// sees it untick. There is no separate progress record to drift out of step
// with reality.
//
// It disappears on its own once the required steps are done. A camp already up
// and running never sees it at all.
//
// Exposed as window.CampistrySetup (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var S = {};

    function count(o) { return o && typeof o === 'object' ? Object.keys(o).length : 0; }
    function nonEmpty(v) { return !!(v && String(v).trim()); }

    /**
     * The steps, in the order a camp actually has to do them. `required` marks
     * the ones that gate the checklist disappearing — connecting Stripe is real
     * setup but a camp taking cash and cheques is legitimately finished without
     * it, so it must not hold the checklist open forever.
     */
    S.STEPS = [
        {
            key: 'name', required: true, page: 'settings',
            label: 'Name your camp',
            detail: 'Appears on registration forms, statements and every message to parents.',
            done: function (s) { return nonEmpty(s.campName); }
        },
        {
            key: 'structure', required: true, page: 'structure',
            label: 'Build your camp structure',
            detail: 'Divisions, then grades inside them, then bunks. Everything else hangs off this.',
            done: function (s) { return s.divisionCount > 0 && s.bunkCount > 0; }
        },
        {
            key: 'dates', required: true, page: 'settings',
            label: 'Set your camp dates',
            detail: 'Start and end dates drive scheduling, rotation fairness and billing periods.',
            done: function (s) { return nonEmpty(s.campStart) && nonEmpty(s.campEnd); }
        },
        {
            key: 'session', required: true, page: 'enrollment',
            label: 'Create a session',
            detail: 'A session carries the tuition and capacity a registration is charged against.',
            done: function (s) { return s.sessionCount > 0; }
        },
        {
            key: 'campers', required: true, page: 'campers',
            label: 'Add your campers',
            detail: 'Import a CSV, or share the registration link and let families apply.',
            done: function (s) { return s.camperCount > 0 || s.enrollmentCount > 0; }
        },
        {
            key: 'bunks', required: true, page: 'bunkbuilder',
            label: 'Place campers in bunks',
            detail: 'Bunk Builder assigns them by grade — the schedule needs this to generate.',
            done: function (s) { return s.campersInBunks > 0; }
        },
        {
            key: 'staff', required: false, page: 'staffing',
            label: 'Add your staff',
            detail: 'Counselors on a bunk get their own schedule in Campistry Lite.',
            done: function (s) { return s.staffCount > 0; }
        },
        {
            key: 'payments', required: false, page: 'settings',
            label: 'Connect payments',
            detail: 'Optional — card payments, pay links and autopay. Cash and cheques work without it.',
            done: function (s) { return nonEmpty(s.stripeKey); }
        }
    ];

    /**
     * Read the camp's state and work out where it is.
     * @returns { steps, completed, total, requiredDone, requiredTotal,
     *            allRequiredDone, nextStep, percent }
     */
    S.evaluate = function (state) {
        var s = state || {};
        var steps = S.STEPS.map(function (step) {
            var isDone = false;
            try { isDone = !!step.done(s); } catch (e) { isDone = false; }
            return {
                key: step.key, label: step.label, detail: step.detail,
                page: step.page, required: step.required, done: isDone
            };
        });
        var required = steps.filter(function (x) { return x.required; });
        var requiredDone = required.filter(function (x) { return x.done; }).length;
        var completed = steps.filter(function (x) { return x.done; }).length;

        return {
            steps: steps,
            completed: completed,
            total: steps.length,
            requiredDone: requiredDone,
            requiredTotal: required.length,
            allRequiredDone: requiredDone === required.length,
            // The first thing still to do — what the "Continue setup" button goes to.
            nextStep: steps.filter(function (x) { return !x.done; })[0] || null,
            percent: required.length ? Math.round((requiredDone / required.length) * 100) : 100
        };
    };

    /**
     * Should the checklist be on screen at all?
     *
     * Hidden once the required steps are done, and hidden for a camp that
     * dismissed it. Also hidden for a camp that was already running before this
     * existed: showing a half-ticked checklist to a camp mid-season reads as
     * "you did this wrong" rather than as help.
     */
    S.shouldShow = function (state, opts) {
        opts = opts || {};
        if (opts.dismissed) return false;
        var r = S.evaluate(state);
        if (r.allRequiredDone) return false;
        // An established camp is judged by its data, not its age: a roster and
        // a schedule mean they are past setup whatever the checklist thinks.
        if (opts.establishedCamp) return false;
        return true;
    };

    /** Days left in the trial, or null when there is no trial running. */
    S.trialDaysLeft = function (trialEndMs, nowMs) {
        if (!trialEndMs) return null;
        var ms = trialEndMs - (nowMs || 0);
        if (ms <= 0) return 0;
        return Math.ceil(ms / 86400000);
    };

    if (typeof window !== 'undefined') window.CampistrySetup = S;
    if (typeof module !== 'undefined' && module.exports) module.exports = S;
})();
