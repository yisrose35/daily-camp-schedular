/* ============================================================================
   Campistry — what counselors can see
   ----------------------------------------------------------------------------
   One catalogue, shared by Me (where the head counselor sets the policy) and
   Lite (where a counselor reads their bunk). Both pages load this file rather
   than each keeping its own list, because a field that exists in one place and
   not the other is exactly how private data leaks.

   The policy is a plain { key: bool } map stored at
   campistryMe.counselorVisibility. A key that isn't in the map falls back to
   the catalogue default, so adding a new field later doesn't silently expose
   it on every camp that saved a policy before it existed — a new field is
   governed by its own default, not by "missing means yes".

   filterCamper() returns a COPY containing only permitted fields. Lite renders
   from that copy, so a hidden field is absent from the object rather than
   merely unrendered — there is nothing to find in the DOM or in a console.
   ============================================================================ */
(function () {
    'use strict';

    // `always: true` = a counselor cannot do the job without it, so it isn't
    // offered as a toggle. Everything else is the head counselor's call.
    var FIELDS = [
        { key: 'identity',   label: 'Name, bunk, grade and division', always: true,
          fields: ['name', 'firstName', 'lastName', 'bunk', 'grade', 'division'] },

        { key: 'leagueTeam', label: 'League team',              def: true,
          fields: ['team', 'teams'] },
        { key: 'allergies',  label: 'Allergies',                def: true,
          fields: ['allergies'] },
        { key: 'dietary',    label: 'Dietary needs',            def: true,
          fields: ['dietary'] },
        { key: 'medStatus',  label: 'Needs medication (yes/no, and whether it was given)', def: true,
          fields: ['_needsMeds', '_medsGivenToday'] },
        { key: 'emergency',  label: 'Emergency contact',        def: true,
          fields: ['emergencyName', 'emergencyRel', 'emergencyPhone'] },
        { key: 'swim',       label: 'Swim level',               def: true,
          fields: ['swimLevel'] },

        { key: 'medications', label: 'Medication details (names and doses)', def: false,
          fields: ['medications'] },
        { key: 'medicalNotes', label: 'Medical notes',          def: false,
          fields: ['medicalNotes'] },
        { key: 'physician',  label: 'Physician and insurance',  def: false,
          fields: ['physician', 'physicianPhone', 'insuranceProvider', 'insurancePolicy'] },
        { key: 'parent',     label: 'Parent name, phone and email', def: false,
          fields: ['parent1Name', 'parent1Phone', 'parent1Email',
                   'parent2Name', 'parent2Phone', 'parent2Email'] },
        { key: 'homeAddress', label: 'Home address',            def: false,
          fields: ['street', 'city', 'state', 'zip'] },
        { key: 'summerAddress', label: 'Summer address',        def: false,
          fields: ['summerStreet', 'summerCity', 'summerState', 'summerZip',
                   'summerPhone', 'summerSameAsHome'] },
        { key: 'birthday',   label: 'Date of birth and age',    def: false,
          fields: ['dob'] },
        { key: 'school',     label: 'School, school grade and teacher', def: false,
          fields: ['school', 'schoolGrade', 'teacher'] },
        { key: 'bunkmates',  label: 'Bunkmate requests',        def: false,
          fields: ['bunkmateRequest', 'separateFrom'] },
        { key: 'shirtSize',  label: 'Shirt size',               def: false,
          fields: ['shirtSize', 'camperType'] },
        { key: 'notes',      label: 'Internal notes',           def: false,
          fields: ['notes', 'adminNotes'] }
    ];

    function toggleable() { return FIELDS.filter(function (f) { return !f.always; }); }

    function defaults() {
        var out = {};
        toggleable().forEach(function (f) { out[f.key] = !!f.def; });
        return out;
    }

    // Missing key → catalogue default, NOT "allowed". See header.
    function isVisible(policy, key) {
        var f = FIELDS.filter(function (x) { return x.key === key; })[0];
        if (!f) return false;
        if (f.always) return true;
        var p = policy || {};
        return Object.prototype.hasOwnProperty.call(p, key) ? !!p[key] : !!f.def;
    }

    // The set of camper properties a counselor may see under this policy.
    function allowedFields(policy) {
        var allow = {};
        FIELDS.forEach(function (f) {
            if (!isVisible(policy, f.key)) return;
            f.fields.forEach(function (name) { allow[name] = true; });
        });
        return allow;
    }

    // Returns a copy carrying only permitted properties. Anything not in the
    // catalogue is dropped rather than passed through: an unknown field is far
    // more likely to be something new and private than something safe.
    function filterCamper(camper, policy) {
        if (!camper || typeof camper !== 'object') return {};
        var allow = allowedFields(policy), out = {};
        Object.keys(camper).forEach(function (k) { if (allow[k]) out[k] = camper[k]; });
        return out;
    }
    function filterCampers(list, policy) {
        return (list || []).map(function (c) { return filterCamper(c, policy); });
    }

    window.CampistryVisibility = {
        FIELDS: FIELDS,
        toggleable: toggleable,
        defaults: defaults,
        isVisible: isVisible,
        allowedFields: allowedFields,
        filterCamper: filterCamper,
        filterCampers: filterCampers
    };
})();
