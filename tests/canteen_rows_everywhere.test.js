// =============================================================================
// Nothing reads canteen ACCOUNTS or the LEDGER out of the campistrySnacks document.
//
// WHY THIS EXISTS. 219 made camp_canteen_accounts and canteen_transactions the
// truth, and the Snacks page strips `accounts` and `transactions` from every
// document save. Everything that still read them from the document read either a
// frozen copy or nothing — and none of it errored:
//
//   canteen-auto-reload     walked snacks.accounts → found nobody → charged nobody
//   payments-charge-nonce   campHasCamper() → "no such camper" → every canteen
//   payments-hosted-link      card deposit refused
//   payments-save-method
//   campistry_me.js         the season close-out → "no unspent canteen money"
//   get_canteen_accounts    returned the document's frozen ledger (migration 245)
//
// Migrations 243 and 245 gave them row readers. This keeps them there.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const FN_DIR = path.join(REPO, 'supabase', 'functions');

/** Comments blanked, so prose describing the old defect is not read as code. */
function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
              .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
}
/** One `function name(` or `async function name(` body, bounded by its braces. */
function bodyOf(src, name) {
    const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
    if (!m) return null;
    let depth = 0;
    for (let j = src.indexOf('{', m.index); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
    }
    return src.slice(m.index);
}

const edgeFunctions = fs.readdirSync(FN_DIR)
    .filter(d => fs.existsSync(path.join(FN_DIR, d, 'index.ts')))
    .map(d => ({ name: d, src: code(fs.readFileSync(path.join(FN_DIR, d, 'index.ts'), 'utf8')) }));

test('no edge function reads the campistrySnacks document', () => {
    // Every canteen fact an edge function needs has a row reader: accounts and
    // the ledger (get_canteen_accounts), who to auto-reload
    // (canteen_autoreload_accounts), whether a camper exists (canteen_camper_known).
    // Inventory is the only thing the document still owns, and no edge function
    // touches inventory.
    // The office's SETTINGS do still live in the document, and are never
    // stripped — the "charge nobody automatically" switch (TED-143) is one. A
    // function may read those; it may not read accounts or the ledger there.
    const offenders = edgeFunctions.filter(f => /["']campistrySnacks["']/.test(f.src)
        && (!/\.settings\b/.test(f.src)
            || /(snacks|doc|kv\.value|value)\??\.(accounts|transactions)\b|\[["'](accounts|transactions)["']\]/.test(f.src)))
        .map(f => f.name);
    assert.deepStrictEqual(offenders, [],
        'these read campistrySnacks from camp_state_kv — its accounts and transactions '
        + 'are stripped on every save since 219, so whatever they find is frozen or empty:\n  '
        + offenders.join('\n  '));
});

test('the nightly auto-reload walks the account rows', () => {
    const f = edgeFunctions.find(e => e.name === 'canteen-auto-reload');
    assert.ok(f, 'canteen-auto-reload is gone');
    assert.match(f.src, /rpc\(\s*"canteen_autoreload_accounts"/,
        'canteen-auto-reload does not read canteen_autoreload_accounts — the nightly run '
        + 'finds its campers somewhere that is not the rows');
    // An account the rows flag as unresolvable is one whose key is now another
    // child's name: charging it credits the wrong child.
    assert.match(f.src, /\.resolvable/,
        'canteen-auto-reload ignores `resolvable` — it would charge a card and credit '
        + 'whichever child now carries an orphaned account\'s old name');
});

test('every campHasCamper asks the rows', () => {
    const withCheck = edgeFunctions.filter(f => /function\s+campHasCamper\s*\(/.test(f.src));
    assert.ok(withCheck.length >= 3, 'expected campHasCamper in at least three payment functions, found '
        + withCheck.length);
    for (const f of withCheck) {
        const body = bodyOf(f.src, 'campHasCamper');
        assert.match(body, /rpc\(\s*"canteen_camper_known"/,
            f.name + '\'s campHasCamper does not call canteen_camper_known');
        // Fail closed: an error must not read as "yes, take the money".
        assert.match(body, /if\s*\(\s*error\s*\)[\s\S]{0,200}return\s+false/,
            f.name + '\'s campHasCamper does not refuse when the check itself fails');
    }
});

test('the season close-out reads canteen balances from the rows, by camper id', () => {
    const ME = code(fs.readFileSync(path.join(REPO, 'campistry_me.js'), 'utf8'));
    const avail = bodyOf(ME, '_canteenAvailableFor');
    assert.ok(avail, 'campistry_me.js no longer defines _canteenAvailableFor');
    assert.doesNotMatch(avail, /campistrySnacks/,
        '_canteenAvailableFor reads the campistrySnacks document again — every family\'s '
        + 'close-out would say there is no canteen money to return');
    assert.match(avail, /camperId/,
        '_canteenAvailableFor no longer matches on camperId — after a rename the account '
        + 'is keyed by the old spelling and a lookup by today\'s name finds nothing');

    const load = bodyOf(ME, '_loadCloseoutCanteen');
    assert.match(load, /rpc\(\s*'get_canteen_accounts'/, '_loadCloseoutCanteen does not read the rows');

    const close = bodyOf(ME, 'closeOutFamily');
    assert.match(close, /_loadCloseoutCanteen\s*\(/,
        'closeOutFamily computes canteen money without reading it first');
    // ...and does not proceed on a zero it could not verify.
    assert.match(close, /if\(!ok\)\{toast\([^)]*\);return\}/,
        'closeOutFamily carries on when the canteen balances could not be read');
});

test('saving the snacks document does not reset the balances on screen', () => {
    // The merge reconciles balances from the ledger it was handed — the frozen
    // document's — so the tab must keep the row-backed branches it already had.
    const SN = code(fs.readFileSync(path.join(REPO, 'campistry_snacks.js'), 'utf8'));
    const save = bodyOf(SN, 'cloudSaveSnacks');
    assert.ok(save, 'cloudSaveSnacks is gone');
    assert.match(save, /merged\.accounts\s*=\s*data\.accounts/,
        'cloudSaveSnacks lets the merge\'s reconciled balances replace the rows it read');
    assert.match(save, /merged\.transactions\s*=\s*data\.transactions/,
        'cloudSaveSnacks lets the document\'s frozen ledger replace the rows it read');
});
