/**
 * Tests for campistry_broadcast_core.js — the pure helpers behind Campistry
 * Link scheduled broadcasts and the camp-name SMS prefix.
 *
 * Run with: node --test tests/broadcast_core.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../campistry_broadcast_core.js');

const T0 = Date.parse('2026-07-20T12:00:00Z');
const MIN = 60000;

describe('validateScheduleTime', () => {
    it('rejects empty / invalid input', () => {
        assert.equal(core.validateScheduleTime('', T0).ok, false);
        assert.equal(core.validateScheduleTime('not-a-date', T0).ok, false);
    });

    it('rejects a past or now time', () => {
        assert.equal(core.validateScheduleTime('2026-07-20T11:59:00Z', T0).ok, false);
        assert.equal(core.validateScheduleTime('2026-07-20T12:00:00Z', T0).ok, false);
    });

    it('enforces the minimum lead time', () => {
        // 30s out with a 60s minimum lead -> rejected
        const soon = new Date(T0 + 30 * 1000).toISOString();
        assert.equal(core.validateScheduleTime(soon, T0, MIN).ok, false);
    });

    it('accepts a valid future time and returns whenMs', () => {
        const later = new Date(T0 + 2 * MIN).toISOString();
        const r = core.validateScheduleTime(later, T0, MIN);
        assert.equal(r.ok, true);
        assert.equal(r.whenMs, T0 + 2 * MIN);
    });
});

describe('selectDue', () => {
    const mk = (id, mins, status) => ({
        id, status: status || 'scheduled',
        scheduledFor: new Date(T0 + mins * MIN).toISOString()
    });

    it('returns only scheduled records at/before now, oldest first', () => {
        const list = [
            mk('future', 10),
            mk('due-1', -5),
            mk('due-2', -20),
            mk('exactly-now', 0),
            mk('sent-past', -30, 'sent'),
            mk('canceled-past', -30, 'canceled'),
        ];
        const due = core.selectDue(list, T0);
        assert.deepEqual(due.map(b => b.id), ['due-2', 'due-1', 'exactly-now']);
    });

    it('ignores malformed input', () => {
        assert.deepEqual(core.selectDue(null, T0), []);
        assert.deepEqual(core.selectDue([{ status: 'scheduled' }], T0), []);
        assert.deepEqual(core.selectDue([{ status: 'scheduled', scheduledFor: 'x' }], T0), []);
    });
});

describe('formatOutgoingSms', () => {
    it('prefixes the camp name', () => {
        assert.equal(core.formatOutgoingSms('Bus is late', 'Sunny Acres'),
            'Sunny Acres: Bus is late');
    });

    it('is idempotent — never double-prefixes', () => {
        const once = core.formatOutgoingSms('Bus is late', 'Sunny Acres');
        assert.equal(core.formatOutgoingSms(once, 'Sunny Acres'), once);
    });

    it('matches an existing prefix case-insensitively', () => {
        assert.equal(core.formatOutgoingSms('sunny acres: hi', 'Sunny Acres'), 'sunny acres: hi');
    });

    it('is a no-op when disabled or when the camp name is blank', () => {
        assert.equal(core.formatOutgoingSms('hi', 'Sunny Acres', { enabled: false }), 'hi');
        assert.equal(core.formatOutgoingSms('hi', ''), 'hi');
        assert.equal(core.formatOutgoingSms('hi', '   '), 'hi');
    });

    it('coerces non-string bodies without throwing', () => {
        assert.equal(core.formatOutgoingSms(null, 'Camp'), 'Camp: ');
        assert.equal(core.formatOutgoingSms(undefined, ''), '');
    });
});

describe('applyMergeTags', () => {
    const d = { camperName: 'Ava Katz', parentName: 'Rivka Katz', bunk: 'B3', division: 'Seniors', grade: '8', familyName: 'Katz Family' };

    it('resolves every tag, case-insensitively', () => {
        const out = core.applyMergeTags(
            'Hi {{parent_name}}, {{child_name}} is in {{bunk}} ({{DIVISION}}/{{grade}}) — {{family_name}}',
            d, { 'Ava Katz': 'Route 5' });
        assert.equal(out, 'Hi Rivka Katz, Ava Katz is in B3 (Seniors/8) — Katz Family');
    });

    it('uses friendly fallbacks for missing data', () => {
        assert.equal(core.applyMergeTags('{{bunk}}', {}), '(unassigned)');
        assert.equal(core.applyMergeTags('{{bus_route}}', { camperName: 'X' }, {}), '(see Go app)');
    });

    it('handles null template', () => {
        assert.equal(core.applyMergeTags(null, d), '');
    });
});

describe('classifyEnrollmentStatus', () => {
    it('buckets each status', () => {
        assert.equal(core.classifyEnrollmentStatus('enrolled'), 'approved');
        assert.equal(core.classifyEnrollmentStatus('Accepted'), 'approved');
        assert.equal(core.classifyEnrollmentStatus('applied'), 'pending');
        assert.equal(core.classifyEnrollmentStatus('waitlisted'), 'pending');
        assert.equal(core.classifyEnrollmentStatus('declined'), 'out');
        assert.equal(core.classifyEnrollmentStatus('withdrawn'), 'out');
        assert.equal(core.classifyEnrollmentStatus(''), 'unknown');
        assert.equal(core.classifyEnrollmentStatus(undefined), 'unknown');
    });
});

describe('matchesAudience', () => {
    it('approved audience keeps only accepted/enrolled', () => {
        assert.equal(core.matchesAudience('enrolled', 'approved'), true);
        assert.equal(core.matchesAudience('accepted', 'approved'), true);
        assert.equal(core.matchesAudience('applied', 'approved'), false);
        assert.equal(core.matchesAudience('waitlisted', 'approved'), false);
        assert.equal(core.matchesAudience('', 'approved'), false); // unknown excluded from strict approved
        assert.equal(core.matchesAudience('withdrawn', 'approved'), false);
    });

    it('active audience keeps everyone except out', () => {
        assert.equal(core.matchesAudience('applied', 'active'), true);
        assert.equal(core.matchesAudience('enrolled', 'active'), true);
        assert.equal(core.matchesAudience('', 'active'), true);   // unknown = active, never dropped
        assert.equal(core.matchesAudience('declined', 'active'), false);
        assert.equal(core.matchesAudience('withdrawn', 'active'), false);
    });

    it('all audience keeps everyone', () => {
        assert.equal(core.matchesAudience('withdrawn', 'all'), true);
        assert.equal(core.matchesAudience('declined', 'all'), true);
    });

    it('defaults to active for an unknown audience', () => {
        assert.equal(core.matchesAudience('applied', 'whatever'), true);
        assert.equal(core.matchesAudience('withdrawn', 'whatever'), false);
    });
});

describe('summarizeRecipients', () => {
    it('describes each scope', () => {
        assert.equal(core.summarizeRecipients('all', [], 42), 'Everyone · 42 recipients');
        assert.equal(core.summarizeRecipients('staff', [], 1), 'All staff · 1 recipient');
        assert.equal(core.summarizeRecipients('division', ['Seniors', 'Juniors'], 0), 'Seniors, Juniors');
        assert.equal(core.summarizeRecipients('bunk', [], 3), 'Selected bunks · 3 recipients');
    });
});
