// node --test tests/deposit_core_sync.test.js
//
// The edge function runs a GENERATED copy of the parser/matcher (Supabase only
// deploys what lives under supabase/functions/). If that copy goes stale, the
// browser previews one matching decision while the server posts a different
// one -- and money follows the server. This test makes that impossible to ship.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('the Deno deposit_core bundle matches the source modules', () => {
    try {
        execFileSync(process.execPath,
            [path.join(__dirname, '..', 'tools', 'build_deposit_core.js'), '--check'],
            { stdio: 'pipe' });
    } catch (e) {
        assert.fail('supabase/functions/_shared/deposit_core.ts is stale — run: node tools/build_deposit_core.js');
    }
});
