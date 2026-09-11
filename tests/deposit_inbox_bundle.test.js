// node --test tests/deposit_inbox_bundle.test.js
//
// The edge function is a GENERATED single file (the Supabase Dashboard flattens
// a function to source/index.ts, so a relative import of a sibling module fails
// to resolve at deploy time). Two things must hold, and both are invisible in
// review:
//   • it stays in sync with the modules the browser runs — otherwise the office
//     previews one matching decision while the server posts a different one
//   • it keeps ZERO local imports — otherwise the next deploy fails outright
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, '..', 'supabase', 'functions', 'deposit-inbox', 'index.ts');

test('the generated deposit-inbox bundle matches its sources', () => {
    try {
        execFileSync(process.execPath,
            [path.join(__dirname, '..', 'tools', 'build_deposit_inbox.js'), '--check'],
            { stdio: 'pipe' });
    } catch (e) {
        assert.fail('deposit-inbox/index.ts is stale — run: node tools/build_deposit_inbox.js');
    }
});

test('the bundle has no local imports the Dashboard cannot resolve', () => {
    // This is the exact failure that broke the first deploy attempt:
    //   Module not found "file:///tmp/user_fn_…/_shared/deposit_core.ts"
    const src = fs.readFileSync(OUT, 'utf8');
    const localImports = src.split('\n').filter(l =>
        /^import\s.+from\s+["']\.{1,2}\//.test(l));
    assert.deepStrictEqual(localImports, [],
        'every import must be a remote URL — a relative one fails at deploy time');
});

test('the bundle carries the parser, the matcher, the templates and the handler', () => {
    const src = fs.readFileSync(OUT, 'utf8');
    assert.ok(src.includes('CampistryDepositTemplate'), 'template engine missing');
    assert.ok(src.includes('const Template = globalThis.CampistryDepositTemplate'),
        'the handler is written against `Template` and needs it bound');
    assert.ok(src.includes('CampistryDepositParser'), 'parser missing');
    assert.ok(src.includes('CampistryDepositMatch'), 'matcher missing');
    assert.ok(src.includes('serve(async (req)'), 'handler missing');
    assert.ok(src.includes('const Parser = globalThis.CampistryDepositParser;'), 'Parser not bound');
    assert.ok(src.includes('const Matcher = globalThis.CampistryDepositMatch;'), 'Matcher not bound');
    // Duplicate identifiers would fail the deploy just as hard as a bad import.
    assert.ok(!/^declare const (Parser|Matcher):/m.test(src), 'declare-const leaked into the bundle');
});
