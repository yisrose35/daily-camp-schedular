/**
 * report_builder_core.js
 * -----------------------------------------------------------------------------
 * Pure, dependency-free engine behind the Campistry Me custom report builder.
 * Works on plain row objects ({ fieldKey: value }) so the exact same filter /
 * group / serialize logic runs in the browser AND under `node --test`.
 *
 * The Me page owns the field registry (how to extract a value from a camper /
 * family / enrollment / staff record); this module only cares about rows that
 * are already flat maps of fieldKey -> value.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ReportBuilderCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Supported filter operators. `numeric` ops coerce both sides to numbers;
    // `unary` ops ignore the target value.
    var OPERATORS = [
        { op: 'is',           label: 'is' },
        { op: 'is_not',       label: 'is not' },
        { op: 'contains',     label: 'contains' },
        { op: 'not_contains', label: 'does not contain' },
        { op: 'starts_with',  label: 'starts with' },
        { op: 'is_empty',     label: 'is empty',     unary: true },
        { op: 'not_empty',    label: 'is not empty', unary: true },
        { op: 'gt',           label: '>',  numeric: true },
        { op: 'lt',           label: '<',  numeric: true },
        { op: 'gte',          label: '≥',  numeric: true },
        { op: 'lte',          label: '≤',  numeric: true },
        { op: 'one_of',       label: 'is any of' } // target = comma-separated list
    ];

    function _s(v) { return (v == null ? '' : String(v)); }
    function _num(v) {
        if (typeof v === 'number') return v;
        var n = parseFloat(_s(v).replace(/[^0-9.\-]/g, ''));
        return isNaN(n) ? NaN : n;
    }

    /** Evaluate one operator against a cell value and a target. Pure. */
    function compare(value, op, target) {
        var v = _s(value).trim(), t = _s(target).trim();
        var vl = v.toLowerCase(), tl = t.toLowerCase();
        switch (op) {
            case 'is':           return vl === tl;
            case 'is_not':       return vl !== tl;
            case 'contains':     return tl !== '' && vl.indexOf(tl) >= 0;
            case 'not_contains': return tl === '' || vl.indexOf(tl) < 0;
            case 'starts_with':  return vl.indexOf(tl) === 0;
            case 'is_empty':     return v === '';
            case 'not_empty':    return v !== '';
            case 'gt':           return _num(value) >  _num(target);
            case 'lt':           return _num(value) <  _num(target);
            case 'gte':          return _num(value) >= _num(target);
            case 'lte':          return _num(value) <= _num(target);
            case 'one_of':
                return t.split(',').map(function (x) { return x.trim().toLowerCase(); })
                        .filter(Boolean).indexOf(vl) >= 0;
            default:             return true;
        }
    }

    /** A row passes when it matches EVERY filter (AND). Filters: [{field,op,value}]. */
    function matchesAll(row, filters) {
        if (!filters || !filters.length) return true;
        for (var i = 0; i < filters.length; i++) {
            var f = filters[i];
            if (!f || !f.field || !f.op) continue;
            if (!compare(row[f.field], f.op, f.value)) return false;
        }
        return true;
    }

    /** Filter rows by an AND list of {field, op, value}. */
    function applyFilters(rows, filters) {
        if (!Array.isArray(rows)) return [];
        return rows.filter(function (r) { return matchesAll(r, filters); });
    }

    /**
     * Group rows by a field into [{ key, count, rows }], sorted by key.
     * Blank values collapse into a "—" bucket. groupBy falsy → single ungrouped
     * bucket with key ''.
     */
    function groupRows(rows, groupBy) {
        rows = Array.isArray(rows) ? rows : [];
        if (!groupBy) return [{ key: '', count: rows.length, rows: rows }];
        var buckets = {};
        rows.forEach(function (r) {
            var k = _s(r[groupBy]).trim() || '—';
            (buckets[k] = buckets[k] || []).push(r);
        });
        return Object.keys(buckets).sort(function (a, b) {
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        }).map(function (k) { return { key: k, count: buckets[k].length, rows: buckets[k] }; });
    }

    function _csvCell(v) { return '"' + _s(v).replace(/"/g, '""') + '"'; }

    /**
     * Serialize rows to CSV. fields: [{key,label}]. When `groups` is provided
     * (from groupRows with a groupBy), a group header + count row precedes each
     * group's rows so the CSV mirrors the on-screen grouping.
     */
    function toCSV(rows, fields, groups) {
        fields = fields || [];
        var header = fields.map(function (f) { return _csvCell(f.label); }).join(',');
        var lines = [header];
        function pushRows(list) {
            list.forEach(function (r) {
                lines.push(fields.map(function (f) { return _csvCell(r[f.key]); }).join(','));
            });
        }
        if (groups && groups.length && !(groups.length === 1 && groups[0].key === '')) {
            groups.forEach(function (g) {
                lines.push(_csvCell(g.key + ' (' + g.count + ')'));
                pushRows(g.rows);
                lines.push('');
            });
        } else {
            pushRows(rows);
        }
        return lines.join('\n');
    }

    /** Run a full report spec against rows → { fields, groups, total }. */
    function run(rows, spec, fieldDefs) {
        spec = spec || {};
        var filtered = applyFilters(rows, spec.filters);
        var groups = groupRows(filtered, spec.groupBy);
        var fields = (spec.fields || []).map(function (key) {
            var def = (fieldDefs || []).filter(function (d) { return d.key === key; })[0];
            return { key: key, label: def ? def.label : key };
        });
        return { fields: fields, groups: groups, total: filtered.length };
    }

    return {
        OPERATORS: OPERATORS,
        compare: compare,
        matchesAll: matchesAll,
        applyFilters: applyFilters,
        groupRows: groupRows,
        toCSV: toCSV,
        run: run
    };
});
