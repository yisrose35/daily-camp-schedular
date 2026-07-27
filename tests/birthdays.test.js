// node --test tests/birthdays.test.js
// Validates the birthday-reminder date arithmetic:
//   • no UTC-parsing off-by-one, year rollover, leap-day clamping
//   • age at the upcoming birthday vs age today
//   • window filtering, sort order, and roster/staff collection
const test = require('node:test');
const assert = require('node:assert');
const B = require('../campistry_birthdays.js');

const ymd = (y, m, d) => ({ y, m, d });

test('parseYmd accepts YYYY-MM-DD and rejects junk', () => {
    assert.deepStrictEqual(B.parseYmd('2014-07-04'), { y: 2014, m: 7, d: 4 });
    assert.deepStrictEqual(B.parseYmd('2014-7-4'), { y: 2014, m: 7, d: 4 });
    assert.deepStrictEqual(B.parseYmd('2014-07-04T12:00:00'), { y: 2014, m: 7, d: 4 });
    assert.strictEqual(B.parseYmd(''), null);
    assert.strictEqual(B.parseYmd(null), null);
    assert.strictEqual(B.parseYmd('not a date'), null);
    assert.strictEqual(B.parseYmd('2014-13-01'), null);   // month out of range
    assert.strictEqual(B.parseYmd('2014-02-32'), null);   // day out of range
});

test('nextOccurrence: today is zero days away, not a year', () => {
    const n = B.nextOccurrence(7, 15, ymd(2026, 7, 15));
    assert.strictEqual(n.daysUntil, 0);
    assert.strictEqual(n.y, 2026);
});

test('nextOccurrence: a date already past rolls to next year', () => {
    const n = B.nextOccurrence(3, 1, ymd(2026, 7, 15));
    assert.strictEqual(n.y, 2027);
    assert.strictEqual(n.daysUntil, 229);
});

test('nextOccurrence: counts days across a month boundary', () => {
    const n = B.nextOccurrence(8, 2, ymd(2026, 7, 30));
    assert.strictEqual(n.daysUntil, 3);
});

test('nextOccurrence: Feb 29 is observed Feb 28 in a non-leap year', () => {
    // 2027 is not a leap year — clamp back a day rather than skipping it.
    const n = B.nextOccurrence(2, 29, ymd(2027, 2, 1));
    assert.strictEqual(n.m, 2);
    assert.strictEqual(n.d, 28);
    assert.strictEqual(n.daysUntil, 27);
});

test('nextOccurrence: Feb 29 stays Feb 29 in a leap year', () => {
    const n = B.nextOccurrence(2, 29, ymd(2028, 2, 1));  // 2028 is a leap year
    assert.strictEqual(n.d, 29);
});

test('isLeap follows the century rules', () => {
    assert.ok(B.isLeap(2024));
    assert.ok(!B.isLeap(2027));
    assert.ok(!B.isLeap(1900));   // divisible by 100, not by 400
    assert.ok(B.isLeap(2000));    // divisible by 400
});

test('ageOn: birthday not yet reached this year means one year younger', () => {
    assert.strictEqual(B.ageOn({ y: 2014, m: 8, d: 20 }, ymd(2026, 7, 15)), 11);
    assert.strictEqual(B.ageOn({ y: 2014, m: 7, d: 15 }, ymd(2026, 7, 15)), 12); // on the day
    assert.strictEqual(B.ageOn({ y: 2014, m: 6, d: 1 }, ymd(2026, 7, 15)), 12);
});

test('ageOn: null when there is no trustworthy birth year', () => {
    assert.strictEqual(B.ageOn({ y: 0, m: 7, d: 15 }, ymd(2026, 7, 15)), null);
    assert.strictEqual(B.ageOn({ y: 1800, m: 7, d: 15 }, ymd(2026, 7, 15)), null);
    assert.strictEqual(B.ageOn(null, ymd(2026, 7, 15)), null);
});

const PEOPLE = [
    { name: 'Eli Katz', dob: '2014-07-15', kind: 'camper' },      // today
    { name: 'Avi Stern', dob: '2013-07-16', kind: 'camper' },     // tomorrow
    { name: 'Moshe Blum', dob: '2015-07-20', kind: 'camper' },    // in 5
    { name: 'Rivky Gold', dob: '2000-08-14', kind: 'staff' },     // in 30
    { name: 'Shaya Weiss', dob: '2012-08-15', kind: 'camper' },   // in 31 — outside
    { name: 'No Birthday', dob: '', kind: 'camper' }              // skipped
];
const TODAY = ymd(2026, 7, 15);

test('upcoming: filters to the window and sorts soonest first', () => {
    const list = B.upcoming(PEOPLE, { today: TODAY, windowDays: 30 });
    assert.deepStrictEqual(list.map(e => e.name),
        ['Eli Katz', 'Avi Stern', 'Moshe Blum', 'Rivky Gold']);
    assert.deepStrictEqual(list.map(e => e.daysUntil), [0, 1, 5, 30]);
});

test('upcoming: skips anyone without a usable date of birth', () => {
    const list = B.upcoming(PEOPLE, { today: TODAY, windowDays: 365 });
    assert.ok(!list.some(e => e.name === 'No Birthday'));
});

test('upcoming: turningAge is the age ON the birthday, currentAge is today', () => {
    const eli = B.upcoming(PEOPLE, { today: TODAY, windowDays: 30 })[0];
    assert.strictEqual(eli.isToday, true);
    assert.strictEqual(eli.turningAge, 12);
    assert.strictEqual(eli.currentAge, 12);

    const avi = B.upcoming(PEOPLE, { today: TODAY, windowDays: 30 })[1];
    assert.strictEqual(avi.turningAge, 13);
    assert.strictEqual(avi.currentAge, 12);   // hasn't had it yet
});

test('upcoming: includeToday:false drops the same-day entries', () => {
    const list = B.upcoming(PEOPLE, { today: TODAY, windowDays: 30, includeToday: false });
    assert.ok(!list.some(e => e.isToday));
    assert.strictEqual(list[0].name, 'Avi Stern');
});

test('upcoming: same-day birthdays tie-break alphabetically', () => {
    const list = B.upcoming([
        { name: 'Zev', dob: '2010-07-15' },
        { name: 'Ari', dob: '2011-07-15' }
    ], { today: TODAY, windowDays: 0 });
    assert.deepStrictEqual(list.map(e => e.name), ['Ari', 'Zev']);
});

test('upcoming: does not mutate the input people', () => {
    const src = [{ name: 'Eli', dob: '2014-07-15' }];
    B.upcoming(src, { today: TODAY });
    assert.deepStrictEqual(Object.keys(src[0]).sort(), ['dob', 'name']);
});

test('upcoming: empty / missing input is an empty list, not a throw', () => {
    assert.deepStrictEqual(B.upcoming(null, { today: TODAY }), []);
    assert.deepStrictEqual(B.upcoming([], { today: TODAY }), []);
    assert.deepStrictEqual(B.upcoming([null, undefined], { today: TODAY }), []);
});

test('todays returns only the zero-day entries', () => {
    const list = B.todays(PEOPLE, { today: TODAY });
    assert.deepStrictEqual(list.map(e => e.name), ['Eli Katz']);
});

test('relativeLabel: Today / Tomorrow / In N days / a dated weekday', () => {
    const list = B.upcoming(PEOPLE, { today: TODAY, windowDays: 30 });
    assert.strictEqual(B.relativeLabel(list[0]), 'Today');
    assert.strictEqual(B.relativeLabel(list[1]), 'Tomorrow');
    assert.strictEqual(B.relativeLabel(list[2]), 'In 5 days');
    // 2026-08-14 is a Friday.
    assert.strictEqual(B.relativeLabel(list[3]), 'Fri, Aug 14');
});

test('collectFromSettings pulls campers and both staff lists', () => {
    const people = B.collectFromSettings({
        app1: { camperRoster: {
            'Eli Katz': { dob: '2014-07-15', division: 'Aleph', bunk: 'A1' },
            'No DOB': { division: 'Aleph' }
        } },
        campistryMe: {
            payroll: { staff: [{ name: 'Rivky Gold', dob: '2000-08-14', role: 'Counselor' }] },
            finance: { staff: [{ name: 'Shaya Weiss', dob: '1998-03-02', role: 'Head Staff' }] }
        }
    });
    assert.strictEqual(people.length, 3);
    const eli = people.find(p => p.name === 'Eli Katz');
    assert.strictEqual(eli.kind, 'camper');
    assert.strictEqual(eli.bunk, 'A1');
    assert.strictEqual(people.filter(p => p.kind === 'staff').length, 2);
});

test('collectFromSettings: payroll staff wins over the same name in finance', () => {
    const people = B.collectFromSettings({
        campistryMe: {
            payroll: { staff: [{ name: 'Rivky Gold', dob: '2000-08-14', role: 'Head Counselor' }] },
            finance: { staff: [{ name: 'Rivky Gold', dob: '1990-01-01', role: 'Counselor' }] }
        }
    });
    assert.strictEqual(people.length, 1);
    assert.strictEqual(people[0].dob, '2000-08-14');
    assert.strictEqual(people[0].role, 'Head Counselor');
});

test('collectFromSettings tolerates a completely empty blob', () => {
    assert.deepStrictEqual(B.collectFromSettings({}), []);
    assert.deepStrictEqual(B.collectFromSettings(null), []);
});
