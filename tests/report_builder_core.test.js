/**
 * Tests for report_builder_core.js — filter operators, grouping, CSV.
 * Run with: node --test tests/report_builder_core.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../report_builder_core.js');

const ROWS = [
    { name: 'Ava Katz',   division: 'Seniors', bunk: 'B1', balance: '0',   status: 'enrolled' },
    { name: 'Ben Cohen',  division: 'Seniors', bunk: 'B2', balance: '250', status: 'accepted' },
    { name: 'Cara Levi',  division: 'Juniors', bunk: 'B3', balance: '0',   status: 'applied' },
    { name: 'Dov Adler',  division: 'Juniors', bunk: '',   balance: '100', status: 'enrolled' },
];

describe('compare', () => {
    it('string ops are case-insensitive', () => {
        assert.equal(core.compare('Seniors', 'is', 'seniors'), true);
        assert.equal(core.compare('Seniors', 'is_not', 'juniors'), true);
        assert.equal(core.compare('Ava Katz', 'contains', 'katz'), true);
        assert.equal(core.compare('Ava Katz', 'not_contains', 'levi'), true);
        assert.equal(core.compare('Ava Katz', 'starts_with', 'ava'), true);
    });
    it('empty ops', () => {
        assert.equal(core.compare('', 'is_empty'), true);
        assert.equal(core.compare('x', 'is_empty'), false);
        assert.equal(core.compare('x', 'not_empty'), true);
    });
    it('numeric ops coerce', () => {
        assert.equal(core.compare('250', 'gt', '100'), true);
        assert.equal(core.compare('$1,200', 'gte', '1200'), true);
        assert.equal(core.compare('0', 'lt', '1'), true);
        assert.equal(core.compare('50', 'lte', '50'), true);
    });
    it('one_of matches a comma list', () => {
        assert.equal(core.compare('accepted', 'one_of', 'accepted, enrolled'), true);
        assert.equal(core.compare('applied', 'one_of', 'accepted, enrolled'), false);
    });
});

describe('applyFilters (AND)', () => {
    it('combines filters with AND', () => {
        const out = core.applyFilters(ROWS, [
            { field: 'division', op: 'is', value: 'Seniors' },
            { field: 'balance', op: 'gt', value: '0' },
        ]);
        assert.deepEqual(out.map(r => r.name), ['Ben Cohen']);
    });
    it('no filters returns all', () => {
        assert.equal(core.applyFilters(ROWS, []).length, 4);
    });
    it('unpaid, enrolled-or-accepted', () => {
        const out = core.applyFilters(ROWS, [
            { field: 'balance', op: 'gt', value: '0' },
            { field: 'status', op: 'one_of', value: 'enrolled,accepted' },
        ]);
        assert.deepEqual(out.map(r => r.name).sort(), ['Ben Cohen', 'Dov Adler']);
    });
});

describe('groupRows', () => {
    it('groups with counts, sorted, blank -> —', () => {
        const groups = core.groupRows(ROWS, 'bunk');
        assert.deepEqual(groups.map(g => [g.key, g.count]), [
            ['—', 1], ['B1', 1], ['B2', 1], ['B3', 1],
        ]);
    });
    it('division grouping counts', () => {
        const groups = core.groupRows(ROWS, 'division');
        const seniors = groups.find(g => g.key === 'Seniors');
        assert.equal(seniors.count, 2);
    });
    it('no groupBy -> single bucket', () => {
        const groups = core.groupRows(ROWS, '');
        assert.equal(groups.length, 1);
        assert.equal(groups[0].count, 4);
    });
});

describe('toCSV', () => {
    const fields = [{ key: 'name', label: 'Name' }, { key: 'division', label: 'Division' }];
    it('flat CSV with header', () => {
        const csv = core.toCSV(ROWS, fields);
        const lines = csv.split('\n');
        assert.equal(lines[0], '"Name","Division"');
        assert.equal(lines[1], '"Ava Katz","Seniors"');
        assert.equal(lines.length, 5);
    });
    it('grouped CSV emits group header + count', () => {
        const groups = core.groupRows(ROWS, 'division');
        const csv = core.toCSV(null, fields, groups);
        assert.ok(csv.includes('"Juniors (2)"'));
        assert.ok(csv.includes('"Seniors (2)"'));
    });
    it('escapes quotes', () => {
        const csv = core.toCSV([{ name: 'A "B"' }], [{ key: 'name', label: 'Name' }]);
        assert.ok(csv.includes('"A ""B"""'));
    });
});

describe('run', () => {
    it('filters, groups, and labels fields', () => {
        const out = core.run(ROWS,
            { fields: ['name', 'balance'], filters: [{ field: 'division', op: 'is', value: 'Seniors' }], groupBy: 'status' },
            [{ key: 'name', label: 'Camper' }, { key: 'balance', label: 'Balance' }]);
        assert.equal(out.total, 2);
        assert.deepEqual(out.fields, [{ key: 'name', label: 'Camper' }, { key: 'balance', label: 'Balance' }]);
        assert.deepEqual(out.groups.map(g => g.key).sort(), ['accepted', 'enrolled']);
    });
});
