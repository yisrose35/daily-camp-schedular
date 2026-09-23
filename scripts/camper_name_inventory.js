#!/usr/bin/env node
// =============================================================================
// camper_name_inventory.js — every place Campistry still identifies a camper
// by NAME rather than by camper number: pages, edge functions and database
// storage.                                                   (Ted, TED-002)
//
//   node scripts/camper_name_inventory.js          # rewrite docs/CAMPER_NAME_INVENTORY.md
//   node scripts/camper_name_inventory.js --check  # exit 1 if the document is out of date
//
// Every database function that names a camper takes the number and the number
// decides (248, 255-257), and the verify script proves it on the live
// database. What is left: pages whose data is keyed by the camper's roster key
// (a unique string that is usually their name), edge-function lines that carry
// a name with no number beside it, and database storage whose KEY is a name.
// This counts each, file by file, so the move can be planned, done in order,
// and seen to shrink.
// tests/camper_name_inventory.test.js fails if any count goes UP.
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'docs', 'CAMPER_NAME_INVENTORY.md');

// Vendored libraries and generated bundles are not ours to move; the module
// that ADDS numbers to everything reads camperName by design.
const SKIP = /^(supabase-js@2\.js|jsqr@1\.4\.0\.js|.*\.min\.js|campistry_camper_id_rpc\.js)$/;

// The camper number on the same line: `camperId` (not the family list camperIds).
const NUMBER_TOO = /\bcamperId\b/;

// Each kind of use. `part: 'name'` — a NAME decides who the camper is: must
// be zero. `part: 'key'` — the camper's ROSTER KEY decides, which since 259 the
// server binds to exactly one camper number for as long as anything about
// that camper exists (a new child with the same name gets their own key,
// "Avi Katz #11", shown as "Avi Katz"; a rename keeps the number; erasing
// frees the key and clears what was filed under it). A key is therefore an
// identifier, not a name: these are counted so they cannot grow, not because
// they can reach the wrong child.
const KINDS = [
    { id: 'records', part: 'name', title: 'Records saved with a camper name and no number',
      why: 'A record (health log, message, order…) that carries only a name. Every record now carries camperId from the moment it is written.',
      // The number may sit on a neighbouring line of the same record.
      test: (line, near) => /\bcamperName\s*:/.test(line) && !/camperId/.test(near || line) },
    { id: 'enrollments', part: 'key', title: 'Records compared with a camper by roster key',
      why: 'A saved record (an enrollment, a tag, a route stop…) compared with a camper by key and not by number. Where the record carries a number the comparison goes by it (those lines are not counted); these are comparisons of roster keys only.',
      // A line that also carries the number (camperId) goes by the number and
      // falls back to the key only for a record written before numbers
      // (or checks it on a neighbouring line: the key is the fallback branch).
      test: (line, near) => /\bcamperName\s*[!=]==|[!=]==\s*[\w.$\]\[]*\bcamperName\b/.test(line) && !NUMBER_TOO.test(near || line) },
    { id: 'families', part: 'key', title: 'Family membership listed by roster key',
      why: 'A family lists its children in camperIds, which holds roster keys; the server stamps the numbers beside them (234).',
      test: line => /\bcamperIds\b/.test(line) },
    { id: 'bunks', part: 'key', title: 'Bunk lists of roster keys',
      why: 'Bunk Builder keeps each bunk as a list of roster keys.',
      test: line => /\bbunkAsgn\b|\bbunkAssignments\b/.test(line) },
    { id: 'roster', part: 'key', title: 'Roster looked up by roster key',
      why: 'The roster is keyed by roster key. A line that reads the camper NUMBER through the roster is the bridge from a key to the number and is not counted.',
      test: line => /\b(?:roster|camperRoster|rosterAll)\s*\[/.test(line) && !NUMBER_TOO.test(line) },
];

// Superseded edge functions: they import ../_shared, cannot be deployed from
// the Dashboard, and nothing calls them.
const SUPERSEDED_EDGE = new Set(['payments-checkout', 'payments-canteen-checkout', 'payments-charge']);

function edgeFiles() {
    const root = path.join(REPO, 'supabase', 'functions');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
        .filter(d => !SUPERSEDED_EDGE.has(d) && fs.existsSync(path.join(root, d, 'index.ts')))
        .sort()
        .map(d => 'supabase/functions/' + d + '/index.ts');
}

// Database storage whose KEY is the roster key (with the number beside it,
// which decides). Checked against the migrations so the list cannot go stale.
const DB_NAME_KEYS = [
    { what: 'Canteen accounts (camp_canteen_accounts.account_key)',
      plan: 'Keyed by roster key; every account carries person_id, and every canteen function finds the account by it (227, 245, 248).',
      present: sql => /account_key\s+text\s+NOT NULL/.test(sql) },
    { what: 'Parent invitations (link_parent_invites.camper_names)',
      plan: 'A list of roster keys with person_ids beside them, position by position (223); ownership is decided by the numbers (224, 255).',
      present: sql => /camper_names/.test(sql) },
    { what: 'Families (camp_families.camper_ids)',
      plan: 'A list of roster keys with person_ids beside them (234); parents\' bills find the family by the numbers (255).',
      present: sql => /camper_ids\s+jsonb/.test(sql) },
    { what: 'Saved camp documents (camp_state_kv: roster, bunks, health, Go addresses)',
      plan: 'Keyed by roster key, bound to one child by 259; every record in them carries camperId (stamped on the way to the cloud).',
      present: sql => /camp_state_kv/.test(sql) },
];

// `// name-ok: <reason>` on a line: the name there is not how a camper is
// identified. Each needs a reason, and the total is shown in the document.
const NAME_OK = /\/\/\s*name-ok:\s*\S/;

function clientFiles() {
    return fs.readdirSync(REPO)
        .filter(f => /\.(js|html)$/.test(f) && !SKIP.test(f))
        .sort();
}

function count() {
    const byKind = {};
    KINDS.forEach(k => { byKind[k.id] = { total: 0, files: {} }; });
    byKind.edge = { total: 0, files: {} };
    byKind.nameOk = { total: 0, files: {} };
    for (const f of edgeFiles()) {
        for (const raw of fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')) {
            const line = raw.replace(/\/\/.*$/, '');
            if (/^\s*\*/.test(line) || /console\.|displayName\(/.test(line)) continue;   // logs and display
            if (NAME_OK.test(raw)) { byKind.nameOk.total++; byKind.nameOk.files[f] = (byKind.nameOk.files[f] || 0) + 1; continue; }
            if (/\b(p_camper_name|camper_name|camperName|camperNames)\b/.test(line)
                && !/camperId|camperIds|person_id|p_camper_id|camperIdIn/.test(line)) {
                byKind.edge.total++;
                byKind.edge.files[f] = (byKind.edge.files[f] || 0) + 1;
            }
        }
    }
    const allSql = fs.readdirSync(path.join(REPO, 'migrations')).filter(x => /^\d.*\.sql$/.test(x))
        .map(x => fs.readFileSync(path.join(REPO, 'migrations', x), 'utf8')).join('\n');
    byKind.database = { total: 0, items: [] };
    DB_NAME_KEYS.forEach(d => { if (d.present(allSql)) { byKind.database.total++; byKind.database.items.push(d); } });
    for (const f of clientFiles()) {
        const lines = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\/\/.*$/, '');      // not comments
            if (/^\s*\*/.test(line)) continue;                   // nor block-comment lines
            // A name that is not a camper on the roster (a lead, a sample, the
            // text of a message) is marked in the code with its reason.
            if (NAME_OK.test(lines[i])) { byKind.nameOk.total++; byKind.nameOk.files[f] = (byKind.nameOk.files[f] || 0) + 1; continue; }
            const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
            for (const k of KINDS) {
                if (k.test(line, near)) {
                    byKind[k.id].total++;
                    byKind[k.id].files[f] = (byKind[k.id].files[f] || 0) + 1;
                }
            }
        }
    }
    return byKind;
}

function render(byKind) {
    const nameKinds = KINDS.filter(k => k.part === 'name');
    const keyKinds = KINDS.filter(k => k.part === 'key');
    const byName = nameKinds.reduce((n, k) => n + byKind[k.id].total, 0) + byKind.edge.total;
    const byKey = keyKinds.reduce((n, k) => n + byKind[k.id].total, 0);
    const out = [];
    const table = (files) => {
        const f = Object.entries(files).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        if (!f.length) { out.push('None.'); out.push(''); return; }
        out.push('| File | Places |'); out.push('|---|---|');
        f.forEach(([n, c]) => out.push('| `' + n + '` | ' + c + ' |'));
        out.push('');
    };
    out.push('# Who decides which camper a record belongs to');
    out.push('');
    out.push('Generated by `node scripts/camper_name_inventory.js`. Do not edit by hand:');
    out.push('`tests/camper_name_inventory.test.js` fails when this file is out of date,');
    out.push('when anything in part A is not zero, and when any count goes **up**.');
    out.push('');
    out.push('## The rule');
    out.push('');
    out.push('A camper is identified by their **camper number**, issued by the server — or by their **roster key**, which the server binds to exactly one number. A name is only ever shown.');
    out.push('');
    out.push('- **Numbers are issued by the server**, one per camper, never shared, never re-issued while anything about the camper exists (253). A rename keeps the number (259).');
    out.push('- **A roster key belongs to one camper** for as long as anything about them exists (259). A new child whose name is taken — by a camper here, by one who left, or by somebody\'s old name — gets their own key ("Avi Katz #11"), shown as "Avi Katz". Erasing a camper frees their keys and clears what was filed under them. So a key, like a number, can never reach a different child.');
    out.push('- **Every database function** that names a camper takes the number and the number decides (248, 255-258); `scripts/verify_identity_chain.sql` checks this on the live database, row by row.');
    out.push('- **Every call and row the pages send** that names a camper carries the number (campistry_camper_id_rpc.js), and every saved record is written with it.');
    out.push('');
    out.push('## A. Decided by a name: ' + byName + ' places (must be 0)');
    out.push('');
    out.push('Not counted: ' + byKind.nameOk.total + ' place' + (byKind.nameOk.total === 1 ? '' : 's') +
             ' where a name is not how a camper is identified (a lead who is not a camper yet, a sample, the words of a message or receipt). Each is marked `// name-ok:` in the code with its reason.');
    out.push('');
    out.push('| Kind | Places |');
    out.push('|---|---|');
    nameKinds.forEach(k => out.push('| Pages: ' + k.title + ' | ' + byKind[k.id].total + ' |'));
    out.push('| Edge functions: a camper named without their number | ' + byKind.edge.total + ' |');
    out.push('| Database functions deciding by name | checked live by `verify_identity_chain.sql` |');
    out.push('');
    nameKinds.forEach(k => {
        out.push('### ' + k.title + ' (' + byKind[k.id].total + ')');
        out.push('');
        out.push(k.why);
        out.push('');
        table(byKind[k.id].files);
    });
    out.push('### Edge functions: a camper named without their number (' + byKind.edge.total + ')');
    out.push('');
    out.push('Lines in the server functions that carry a camper\'s name with no number beside them (logs and parent-facing text excluded).');
    out.push('');
    table(byKind.edge.files);
    out.push('## B. Decided by a roster key: ' + byKey + ' places (one child per key since 259)');
    out.push('');
    out.push('Code that finds a camper by their roster key. Since 259 a key is bound to one camper number, so these cannot reach the wrong child; they are counted so that new code uses the number where it has one.');
    out.push('');
    out.push('| Kind | Places | Files |');
    out.push('|---|---|---|');
    keyKinds.forEach(k => out.push('| ' + k.title + ' | ' + byKind[k.id].total + ' | ' + Object.keys(byKind[k.id].files).length + ' |'));
    out.push('| Database storage keyed by roster key | ' + byKind.database.total + ' | — |');
    out.push('');
    keyKinds.forEach(k => {
        out.push('### ' + k.title + ' (' + byKind[k.id].total + ')');
        out.push('');
        out.push(k.why);
        out.push('');
        table(byKind[k.id].files);
    });
    out.push('### Database storage keyed by roster key (' + byKind.database.total + ')');
    out.push('');
    byKind.database.items.forEach(d => { out.push('- **' + d.what + '.** ' + d.plan); });
    out.push('');
    return out.join('\n') + '\n';
}

if (require.main === module) {
    const text = render(count());
    if (process.argv.includes('--check')) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (cur !== text) { console.error('docs/CAMPER_NAME_INVENTORY.md is out of date — run node scripts/camper_name_inventory.js'); process.exit(1); }
        console.log('up to date');
    } else {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, text);
        console.log('wrote', path.relative(REPO, OUT));
    }
}

module.exports = { count, render, KINDS, OUT, DB_NAME_KEYS };
