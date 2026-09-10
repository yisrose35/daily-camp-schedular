#!/usr/bin/env node
// =============================================================================
// tools/build_deposit_core.js
//
// The deposit parser and matcher have to run in three runtimes: the browser
// (Billing UI), Node (tests), and Deno (the deposit-inbox edge function). The
// first two share the root .js files directly. The third cannot: Supabase only
// deploys what lives under supabase/functions/, so anything the function
// imports must physically exist inside that directory.
//
// The obvious workaround -- hand-copying the logic into the edge function --
// guarantees drift, and drift here means the browser previews one decision
// while the server posts a different one. Money follows the server; the office
// believes the browser. That bug would be invisible for a whole summer.
//
// So the Deno copy is GENERATED from the root files verbatim and checked in,
// and tests/deposit_core_sync.test.js fails the build if it ever goes stale.
// One source of truth, one artifact, no drift.
//
//   node tools/build_deposit_core.js            # regenerate
//   node tools/build_deposit_core.js --check     # verify it is current
// =============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['campistry_deposit_parser.js', 'campistry_deposit_match.js'];
const OUT = path.join(ROOT, 'supabase', 'functions', '_shared', 'deposit_core.ts');

function build() {
    const parts = SOURCES.map(f => {
        const body = fs.readFileSync(path.join(ROOT, f), 'utf8').trimEnd();
        return `// ─── ${f} ${'─'.repeat(Math.max(0, 60 - f.length))}\n${body}`;
    });

    return [
        '// @ts-nocheck',
        '// =============================================================================',
        '// AUTO-GENERATED — DO NOT EDIT.',
        '//',
        `// Generated from ${SOURCES.join(' + ')} by`,
        '// tools/build_deposit_core.js. Edit those files and re-run:',
        '//',
        '//     node tools/build_deposit_core.js',
        '//',
        '// tests/deposit_core_sync.test.js fails if this file is out of date, so the',
        '// server can never enforce different matching rules than the browser previews.',
        '// =============================================================================',
        '',
        parts.join('\n\n'),
        '',
        '// The two IIFEs above register themselves on globalThis; re-export them as',
        '// proper ES modules for the edge function to import.',
        'export const Parser = globalThis.CampistryDepositParser;',
        'export const Matcher = globalThis.CampistryDepositMatch;',
        ''
    ].join('\n');
}

const generated = build();
const check = process.argv.includes('--check');
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (check) {
    if (current !== generated) {
        console.error('deposit_core.ts is STALE — run: node tools/build_deposit_core.js');
        process.exit(1);
    }
    console.log('deposit_core.ts is up to date.');
} else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, generated);
    console.log((current === generated ? 'unchanged: ' : 'wrote: ') + path.relative(ROOT, OUT));
}
