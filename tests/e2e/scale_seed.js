// =============================================================================
// scale_seed.js — a 600-camper camp, seeded through the REAL write paths.
//
// Used by tests/scale_600.e2e.js. Every document is written the way the app
// writes it (one camp_state_kv upsert per key), so the projection triggers —
// camp_people, camp_families, camp_payments, billing config — run on the real
// volume. The canteen ledger is inserted directly: a season of register sales
// is 30,000+ rows and replaying each through submit_canteen_purchase would test
// the seeding, not the camp.
// =============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const N_DIVISIONS = 6;
const GRADES_PER_DIV = 2;
const BUNKS_PER_GRADE = 5;          // 60 bunks, 10 campers each
const FIRST = ['Avi','Batya','Chaim','Dina','Eli','Faiga','Gavi','Hindy','Itzy','Leah',
               'Moshe','Nechama','Ovadia','Perel','Rivky','Shmuel','Tova','Uri','Yael','Zevi'];
const LAST  = ['Adler','Berger','Cohen','Dresner','Engel','Fried','Gold','Hirsch','Isaacs','Jacobs',
               'Katz','Lerner','Mandel','Neuman','Orenstein','Perl','Rosen','Stern','Tauber','Weiss'];

function lit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/**
 * Seeds `n` campers into `camp` owned by `owner`, with families of two,
 * enrollments, payments, canteen accounts and `txDays` days of sales.
 * Returns { names, timings } — timings are the ms each real write took.
 */
function seedCamp(db, { camp, owner, n = 600, txDays = 30, salesPerDay = 2 }) {
    const t = {};
    const time = (label, fn) => { const s = Date.now(); const r = fn(); t[label] = Date.now() - s; return r; };

    const structure = {}, roster = {}, names = [];
    for (let d = 0; d < N_DIVISIONS; d++) {
        const grades = {};
        for (let g = 0; g < GRADES_PER_DIV; g++) {
            const bunks = [];
            for (let b = 0; b < BUNKS_PER_GRADE; b++) bunks.push('D' + d + 'G' + g + 'B' + b);
            grades['Grade ' + d + '-' + g] = { bunks };
        }
        structure['Division ' + d] = { color: '#3B82F6', grades };
    }
    for (let i = 0; i < n; i++) {
        // Distinct names, and a handful that COLLIDE on purpose: a camp of 600
        // has same-named children, and the "#<id>" keying must hold at volume.
        let name = FIRST[i % 20] + ' ' + LAST[Math.floor(i / 20) % 20];
        if (i >= 400) name = name + ' ' + String.fromCharCode(65 + Math.floor(i / 400));
        if (roster[name]) name = name + ' #' + (i + 1);
        const d = i % N_DIVISIONS, g = Math.floor(i / N_DIVISIONS) % GRADES_PER_DIV,
              b = Math.floor(i / (N_DIVISIONS * GRADES_PER_DIV)) % BUNKS_PER_GRADE;
        roster[name] = { name, camperId: i + 1, division: 'Division ' + d,
                         grade: 'Grade ' + d + '-' + g, bunk: 'D' + d + 'G' + g + 'B' + b };
        names.push(name);
    }

    const families = {}, enrollments = {}, payments = [];
    for (let f = 0; f < Math.ceil(n / 2); f++) {
        const kids = names.slice(f * 2, f * 2 + 2);
        families['fam' + f] = { name: LAST[f % 20] + ' family ' + f, camperIds: kids,
            households: [{ label: 'Primary', parents: [{ name: 'Parent ' + f, email: 'p' + f + '@scale.test' }] }] };
        kids.forEach((k, j) => {
            enrollments['e' + f + '_' + j] = { camperName: k, status: 'enrolled',
                session: 'Full Summer', sessionTuition: 4000 };
        });
        payments.push({ id: 'pay' + f, family: families['fam' + f].name, familyKey: 'fam' + f,
                        amount: 2000, status: 'succeeded', date: '2026-05-01' });
    }

    // Through a FILE: a 600-camper document is well past the 128 KB a single
    // command-line argument may carry, and `psql -c` fails without a word.
    const kv = (key, value) => {
        const f = path.join(os.tmpdir(), 'campistry-scale-' + process.pid + '-' + key + '.sql');
        fs.writeFileSync(f, `INSERT INTO camp_state_kv (camp_id, key, value) VALUES (${lit(camp)}, ${lit(key)}, `
            + lit(JSON.stringify(value)) + `::jsonb)
             ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`);
        try { db.file(f); } finally { fs.unlinkSync(f); }
    };

    db.sql(`INSERT INTO auth.users (id, email) VALUES (${lit(owner)}, 'owner@scale.test') ON CONFLICT DO NOTHING;
            INSERT INTO camps (id, owner, name) VALUES (${lit(camp)}, ${lit(owner)}, 'Scale Camp') ON CONFLICT DO NOTHING;`);
    time('write campStructure', () => kv('campStructure', structure));
    time('write roster (600 campers, projection trigger)', () => kv('app1', { camperRoster: roster }));
    time('write campistryMe (families + enrollments + payments)', () => kv('campistryMe', {
        sessions: [{ name: 'Full Summer', tuition: 4000 }], families, enrollments, payments }));
    time('write campistrySnacks (inventory)', () => kv('campistrySnacks', {
        inventory: [{ id: 1, name: 'Ices', price: 2.5, stock: null }, { id: 2, name: 'Chips', price: 1.5, stock: null }],
        settings: { payMethods: ['cash'], defaultDailyLimit: 0 } }));

    // Canteen: every camper $50, through the row writers' own save.
    time('canteen accounts (600 × canteen_account_save)', () => db.sql(`
        SELECT public.canteen_account_save(${lit(camp)}::uuid, k,
               '{"balance":50,"dailyLimit":0,"spentToday":0}'::jsonb)
          FROM jsonb_object_keys((SELECT value->'camperRoster' FROM camp_state_kv
                                   WHERE camp_id = ${lit(camp)} AND key = 'app1')) k;`));

    // A season of sales.
    time('ledger (' + n * txDays * salesPerDay + ' rows)', () => db.sql(`
        INSERT INTO canteen_transactions (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
        SELECT ${lit(camp)}, 'seed:' || a.account_key || ':' || d || ':' || s,
               a.account_key, a.person_id::text, 'debit', 1.5,
               ((now() AT TIME ZONE 'utc')::date - d)::text, '12:00 PM', 'Chips',
               jsonb_build_object('camper', a.account_key, 'amount', 1.5, 'type', 'debit', 'items', 'Chips',
                                  'date', ((now() AT TIME ZONE 'utc')::date - d)::text)
          FROM camp_canteen_accounts a,
               generate_series(0, ${txDays - 1}) d, generate_series(1, ${salesPerDay}) s
         WHERE a.camp_id = ${lit(camp)};
        ANALYZE canteen_transactions; ANALYZE camp_canteen_accounts; ANALYZE camp_people;`));

    return { names, roster, families, timings: t };
}

module.exports = { seedCamp, lit };
