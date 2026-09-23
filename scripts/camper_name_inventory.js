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

// Vendored libraries and generated bundles are not ours to move.
const SKIP = /^(supabase-js@2\.js|jsqr@1\.4\.0\.js|.*\.min\.js)$/;

// Each kind of name-keyed use, in the order they should be moved.
const KINDS = [
    { id: 'records', title: 'Records saved with a camper name and no number',
      why: 'A record (health log, message, order…) that carries only a name is matched to a camper later by that name. It should carry camperId from the moment it is written.',
      test: line => /\bcamperName\s*:/.test(line) && !/camperId/.test(line) },
    { id: 'enrollments', title: 'Enrollments tied to a camper by name',
      why: 'An enrollment finds its camper by comparing camperName. Billing and the family ledger hang off this.',
      test: line => /\bcamperName\s*[!=]==|[!=]==\s*[\w.$\]\[]*\bcamperName\b/.test(line) },
    { id: 'families', title: 'Family membership listed by name',
      why: 'A family lists its children in camperIds, which holds NAMES. The server already stamps the numbers (234); the page does not use them yet.',
      test: line => /\bcamperIds\b/.test(line) },
    { id: 'bunks', title: 'Bunk lists of names',
      why: 'Bunk Builder keeps each bunk as a list of names.',
      test: line => /\bbunkAsgn\b|\bbunkAssignments\b/.test(line) },
    { id: 'roster', title: 'Roster looked up by name',
      why: 'The roster itself is keyed by the camper\'s roster key. Everything else can move to numbers first; re-keying the roster is the last step.',
      test: line => /\b(?:roster|camperRoster|rosterAll)\s*\[/.test(line) },
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

// Database storage that is still KEYED by a camper's name — where the name is
// the identity, not a label beside a number. Each is checked against the
// migrations so the list cannot quietly go stale.
const DB_NAME_KEYS = [
    { what: 'Canteen accounts are keyed by name (camp_canteen_accounts.account_key)',
      plan: 'Key accounts by person_id; keep the name as a label. 227 explains why the key stayed: old sales that carry only a name join through it — stamp those with the number first.',
      present: sql => /account_key\s+text\s+NOT NULL/.test(sql) },
    { what: 'Parent invitations list children by name (link_parent_invites.camper_names)',
      plan: 'Make person_ids the list and camper_names a label; 223 already stamps the numbers position by position.',
      present: sql => /camper_names/.test(sql) },
    { what: 'Families list children by name (camp_families.camper_ids)',
      plan: 'Make person_ids (234) the membership list and drop the name list once the Me page writes numbers.',
      present: sql => /camper_ids\s+jsonb/.test(sql) },
    { what: 'Saved camp documents keyed by the roster key (camp_state_kv: roster, bunks, health, go addresses)',
      plan: 'Follows the page steps below: when the pages key by number, the documents do too.',
      present: sql => /camp_state_kv/.test(sql) },
];

function clientFiles() {
    return fs.readdirSync(REPO)
        .filter(f => /\.(js|html)$/.test(f) && !SKIP.test(f))
        .sort();
}

function count() {
    const byKind = {};
    KINDS.forEach(k => { byKind[k.id] = { total: 0, files: {} }; });
    byKind.edge = { total: 0, files: {} };
    for (const f of edgeFiles()) {
        for (const raw of fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')) {
            const line = raw.replace(/\/\/.*$/, '');
            if (/^\s*\*/.test(line) || /console\.|displayName\(/.test(line)) continue;   // logs and display
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
        for (const raw of lines) {
            const line = raw.replace(/\/\/.*$/, '');          // not comments
            if (/^\s*\*/.test(line)) continue;                   // nor block-comment lines
            for (const k of KINDS) {
                if (k.test(line)) {
                    byKind[k.id].total++;
                    byKind[k.id].files[f] = (byKind[k.id].files[f] || 0) + 1;
                }
            }
        }
    }
    return byKind;
}

function render(byKind) {
    const total = KINDS.reduce((n, k) => n + byKind[k.id].total, 0) + byKind.edge.total + byKind.database.total;
    const out = [];
    out.push('# Where Campistry still identifies a camper by name');
    out.push('');
    out.push('Generated by `node scripts/camper_name_inventory.js`. Do not edit by hand:');
    out.push('`tests/camper_name_inventory.test.js` fails when this file is out of date, and');
    out.push('when any number below goes **up**. The move to camper numbers is finished when');
    out.push('every number here is zero.');
    out.push('');
    out.push('## What is already on camper numbers');
    out.push('');
    out.push('- **Numbers are issued by the server**, one per camper, never shared, never re-issued while the camper\'s records exist (migration 253).');
    out.push('- **Every database function** that names a camper also takes the number, and the number decides who the camper is — including a camper who has left while a new child has their name (248, 257).');
    out.push('- **Parents\' bills, saved cards and payment plans** find the family by the children\'s numbers (255). **Face data, photo tags and forms** are matched by number (256).');
    out.push('- **Every call and every row the pages send** that names a camper carries the number too, from every page including Campistry Lite (campistry_camper_id_rpc.js).');
    out.push('- **The canteen** finds a camper\'s account by number on the Snacks page, so a rename no longer shows an empty account.');
    out.push('- `scripts/verify_identity_chain.sql` checks all of this on the live database.');
    out.push('');
    out.push('## What is still by name: ' + total + ' places');
    out.push('');
    out.push('| # | Kind | Places | Files |');
    out.push('|---|---|---|---|');
    KINDS.forEach((k, i) => {
        out.push('| ' + (i + 1) + ' | Pages: ' + k.title + ' | ' + byKind[k.id].total + ' | ' +
                 Object.keys(byKind[k.id].files).length + ' |');
    });
    out.push('| ' + (KINDS.length + 1) + ' | Edge functions: a camper named without their number | ' + byKind.edge.total + ' | ' +
             Object.keys(byKind.edge.files).length + ' |');
    out.push('| ' + (KINDS.length + 2) + ' | Database: storage keyed by a camper\'s name | ' + byKind.database.total + ' | — |');
    out.push('');
    out.push('## The plan, in order');
    out.push('');
    out.push('Each step is safe on its own and leaves the app working. The order is by risk: money and records first, the roster key last, because everything else must stop depending on it before it can change.');
    out.push('');
    KINDS.forEach((k, i) => {
        out.push('### ' + (i + 1) + '. ' + k.title + ' (' + byKind[k.id].total + ')');
        out.push('');
        out.push(k.why);
        out.push('');
        const files = Object.entries(byKind[k.id].files).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        if (!files.length) { out.push('None left.'); out.push(''); return; }
        out.push('| File | Places |');
        out.push('|---|---|');
        files.forEach(([f, n]) => out.push('| `' + f + '` | ' + n + ' |'));
        out.push('');
    });
    out.push('### ' + (KINDS.length + 1) + '. Edge functions: a camper named without their number (' + byKind.edge.total + ')');
    out.push('');
    out.push('Lines in the server functions that carry a camper\'s name with no number beside them (logs and parent-facing text excluded). Most are the name arriving from the page, where the number now rides alongside on another line; each should read and pass the number.');
    out.push('');
    const ef = Object.entries(byKind.edge.files).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (!ef.length) out.push('None left.');
    else { out.push('| File | Places |'); out.push('|---|---|'); ef.forEach(([f, n]) => out.push('| `' + f + '` | ' + n + ' |')); }
    out.push('');
    out.push('### ' + (KINDS.length + 2) + '. Database: storage keyed by a camper\'s name (' + byKind.database.total + ')');
    out.push('');
    out.push('Every table that stores a camper also stores their number (223) and every function decides by it (248, 255-257). These are the places where the NAME is still the key:');
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
