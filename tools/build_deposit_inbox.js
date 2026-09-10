#!/usr/bin/env node
// =============================================================================
// tools/build_deposit_inbox.js
//
// Generates supabase/functions/deposit-inbox/index.ts as ONE self-contained
// file, by inlining the deposit parser and matcher ahead of the handler.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A SINGLE FILE
//
// The obvious structure — handler imports "../_shared/deposit_core.ts" — does
// not survive a Supabase Dashboard deploy. The Dashboard flattens the function
// to source/index.ts, so the relative import resolves to a path outside the
// bundle and the deploy fails outright:
//
//     Module not found "file:///tmp/user_fn_…/_shared/deposit_core.ts"
//       at file:///tmp/user_fn_…/source/index.ts
//
// Campistry has no Supabase CLI, so the Dashboard IS the deploy path and the
// deployable artifact has to have zero local imports. One file, one paste.
//
// WHY GENERATED RATHER THAN HAND-WRITTEN
//
// The parser and matcher also run in the browser (Billing previews a match)
// and in Node (the tests). Hand-copying them into the edge function would let
// the copies drift, and drift here means the browser shows the office one
// decision while the server posts a different one — money follows the server,
// and the discrepancy would be invisible for a whole summer.
//
// So: three authored sources, one generated artifact, and
// tests/deposit_inbox_bundle.test.js fails the build if it goes stale.
// ─────────────────────────────────────────────────────────────────────────────
//
//   node tools/build_deposit_inbox.js           # regenerate
//   node tools/build_deposit_inbox.js --check   # verify it is current
// =============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = ['campistry_deposit_parser.js', 'campistry_deposit_match.js'];
const HANDLER = path.join(ROOT, 'tools', 'deposit_inbox_handler.ts');
const OUT = path.join(ROOT, 'supabase', 'functions', 'deposit-inbox', 'index.ts');

function build() {
    const handlerRaw = fs.readFileSync(HANDLER, 'utf8');

    // Import declarations are hoisted to the top of the generated module. They
    // are legal further down, but keeping them first is what a reader expects
    // and removes any question about evaluation order.
    const imports = [];
    const body = handlerRaw
        .split('\n')
        .filter((line) => {
            if (/^import\s.+from\s+["'].+["'];?\s*$/.test(line)) { imports.push(line); return false; }
            // The handler declares Parser/Matcher so it reads correctly on its
            // own; here they become real bindings, so the declarations would be
            // duplicate identifiers.
            if (/^declare const (Parser|Matcher):/.test(line)) return false;
            return true;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');

    const core = CORE.map((f) => {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8').trimEnd();
        return `// ─── ${f} ${'─'.repeat(Math.max(0, 58 - f.length))}\n${src}`;
    });

    return [
        '// @ts-nocheck',
        '// =============================================================================',
        '// AUTO-GENERATED — DO NOT EDIT.',
        '//',
        '// Deploy this file as the ENTIRE deposit-inbox function. It is deliberately',
        '// self-contained: the Supabase Dashboard flattens a function to source/index.ts,',
        '// so any relative import of a sibling file fails to resolve at deploy time.',
        '//',
        `// Generated from ${CORE.join(' + ')}`,
        '// + tools/deposit_inbox_handler.ts by tools/build_deposit_inbox.js.',
        '// Edit those, then run:  node tools/build_deposit_inbox.js',
        '// =============================================================================',
        '',
        imports.join('\n'),
        '',
        core.join('\n\n'),
        '',
        '// The two modules above register themselves on globalThis; bind them for the',
        '// handler, which is written against these two names.',
        'const Parser = globalThis.CampistryDepositParser;',
        'const Matcher = globalThis.CampistryDepositMatch;',
        '',
        body.trimStart(),
        ''
    ].join('\n');
}

const generated = build();
const check = process.argv.includes('--check');
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (check) {
    if (current !== generated) {
        console.error('deposit-inbox/index.ts is STALE — run: node tools/build_deposit_inbox.js');
        process.exit(1);
    }
    console.log('deposit-inbox/index.ts is up to date.');
} else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, generated);
    console.log((current === generated ? 'unchanged: ' : 'wrote: ') + path.relative(ROOT, OUT));
}
