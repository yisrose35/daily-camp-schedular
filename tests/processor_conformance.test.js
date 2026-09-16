// node --test tests/processor_conformance.test.js
//
// Migration 176 turns payment_processor_catalog.capabilities from documentation
// into a contract, and gates camp_processor_credentials on it. But SQL can only
// check a DECLARATION. A catalog row can say "chargeback": true while nothing
// anywhere handles a dispute, and the database has no way to know.
//
// This file is the other half. It reads the migrations to work out what each
// processor DECLARES, then reads the edge functions and adapters to check that
// something actually implements each claim. Neither half is enough alone:
//
//   * the trigger without this file lets a processor lie its way in;
//   * this file without the trigger catches it in CI and still lets a camp be
//     connected to a half-built processor in production.
//
// The failure it exists to prevent is specific and silent. Cardknox and Banquest
// had no dispute path at all, so a chargeback pulled money out of the camp's
// bank account while Campistry went on showing the payment as collected. Nothing
// errored. The books were simply wrong, and stayed wrong.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readRaw = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

// Every migration in this repo ends with a commented-out "run this to check it"
// block, and 176's shows a deliberately half-built processor being INSERTed and
// refused. Asserting against raw text matches that example and reports a defect
// in a comment — so structural assertions read code only.
//
// Whole-line comments only, deliberately. Stripping a trailing `--` would have
// to know whether it sits inside a string literal, and getting that wrong
// silently deletes real SQL from what the test believes it is checking.
const stripComments = sql =>
  sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
const read = p => stripComments(readRaw(p));

const M176 = read('migrations/176_processor_conformance.sql');
const WEBHOOK = 'supabase/functions/byop-dispute-webhook/index.ts';

// Every migration that writes to the catalog, in the order Postgres would see
// them. Discovered, not hand-listed: a hand-listed set is the bug it is meant to
// catch — migration 177 adding a processor would simply be invisible here.
const CATALOG_MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
  .filter(f => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  .filter(f => read('migrations/' + f).includes('payment_processor_catalog'));

// ── reading the catalog out of the SQL ──────────────────────────────────────
//
// Not a SQL parser. It handles the two shapes the migrations actually use — a
// multi-row INSERT ... VALUES and an UPDATE ... SET capabilities = capabilities
// || '<literal>' — and a test below asserts those are still the only shapes, so
// a third one cannot slip past by being silently ignored.

const jsonish = s => {
  try { return JSON.parse(s.replace(/''/g, "'")); } catch { return null; }
};

function catalogFromMigrations() {
  const caps = {};           // key -> declared capabilities
  const seededIn = {};       // key -> file that first INSERTed it

  for (const file of CATALOG_MIGRATIONS) {
    const sql = read('migrations/' + file);

    // INSERT INTO payment_processor_catalog (...) VALUES ('key', 'label', '[...]', '{...}', '...')
    const insBlock = /INSERT\s+INTO\s+payment_processor_catalog\s*\([^)]*\)\s*VALUES([\s\S]*?)ON\s+CONFLICT/gi;
    let ins;
    while ((ins = insBlock.exec(sql))) {
      // Each row: the key is the first quoted string, the capabilities are the
      // jsonb literal that carries "charge".
      const rowRe = /\(\s*'([a-z0-9_]+)'[\s\S]*?'(\{[\s\S]*?\})'::jsonb\s*,[\s\S]*?\)/gi;
      let row;
      while ((row = rowRe.exec(ins[1]))) {
        const key = row[1];
        const obj = jsonish(row[2]);
        if (!obj) continue;
        if (!(key in caps)) { caps[key] = obj; seededIn[key] = file; }
      }
    }

    // UPDATE payment_processor_catalog SET capabilities = capabilities || '{...}'::jsonb WHERE key = 'x'
    const updRe = /UPDATE\s+payment_processor_catalog\s+SET\s+capabilities\s*=\s*capabilities\s*\|\|\s*'(\{[\s\S]*?\})'::jsonb\s+WHERE\s+key\s*=\s*'([a-z0-9_]+)'/gi;
    let upd;
    while ((upd = updRe.exec(sql))) {
      const obj = jsonish(upd[1]);
      if (obj && caps[upd[2]]) Object.assign(caps[upd[2]], obj);
    }
  }
  return { caps, seededIn };
}

const { caps: CATALOG, seededIn: SEEDED_IN } = catalogFromMigrations();

// What 176 says every processor must have. Read out of the migration rather
// than repeated here, so adding a sixth required capability to the SQL makes
// this file start checking it instead of quietly continuing to check five.
function requiredCapabilities() {
  const body = M176.slice(M176.indexOf('processor_required_capabilities'));
  const block = body.slice(body.indexOf('jsonb_build_object'), body.indexOf('$$;'));
  return [...block.matchAll(/'([a-z]+)'\s*,\s*'/g)].map(m => m[1]);
}
const REQUIRED = requiredCapabilities();

// A processor a camp can be connected to. 'none' is the sentinel for "has not
// chosen one" (migration 153) and is deliberately excluded — see its own test.
const LIVE = Object.keys(CATALOG).filter(k => k !== 'none');

// ── 0. the reader is reading something ──────────────────────────────────────
// Every assertion below is vacuously true if the parse silently returned {}.

test('the catalog parses out of the migrations', () => {
  assert.ok(CATALOG_MIGRATIONS.length >= 3,
    `expected several migrations touching the catalog, found ${CATALOG_MIGRATIONS.length}`);
  for (const k of ['stripe', 'cardknox', 'banquest', 'none']) {
    assert.ok(CATALOG[k], `processor "${k}" was not found in any migration — the parser is broken, not the catalog`);
  }
  assert.ok(LIVE.length >= 3, 'expected at least stripe, cardknox and banquest');
});

test('176 requires exactly the five capabilities money needs', () => {
  assert.deepStrictEqual(REQUIRED.slice().sort(),
    ['charge', 'chargeback', 'recurring', 'refund', 'tokenization']);
});

test('the catalog is only ever written in the two shapes this file can read', () => {
  // The parser ignores anything else. If a migration starts writing capabilities
  // some third way — a jsonb_set, a jsonb_build_object merge, an UPDATE with an
  // IN list — every check below would go on passing while reading stale values.
  for (const file of CATALOG_MIGRATIONS) {
    const sql = read('migrations/' + file);
    const writes = [...sql.matchAll(/(?:UPDATE|INSERT\s+INTO)\s+payment_processor_catalog\b[\s\S]{0,400}/gi)];
    for (const w of writes) {
      const stmt = w[0];
      if (!/\bcapabilities\b/.test(stmt)) continue;          // credential_fields-only writes
      const readable =
        /VALUES/i.test(stmt) ||
        /SET\s+capabilities\s*=\s*capabilities\s*\|\|\s*'\{/i.test(stmt);
      assert.ok(readable,
        `${file} writes capabilities in a shape tests/processor_conformance.test.js ` +
        `cannot read, so its declaration is not being checked:\n${stmt.slice(0, 240)}`);
    }
  }
});

// ── 1. every live processor DECLARES everything ─────────────────────────────

test('every live processor declares all five required capabilities', () => {
  for (const key of LIVE) {
    for (const cap of REQUIRED) {
      assert.strictEqual(CATALOG[key][cap], true,
        `processor "${key}" declares ${cap} as ${JSON.stringify(CATALOG[key][cap])}, not true. ` +
        `The trigger in 176 will REFUSE to connect a camp to it. Either wire the ` +
        `capability and declare it true in a migration, or accept that no camp can use it.`);
    }
  }
});

test('a prose note is not a yes', () => {
  // 127 declared Banquest's recurring as "NMI supports recurring/Customer Vault
  // schedules, not yet wired into charge-due-installments" — an honest note, and
  // precisely not a claim. processor_conformance() compares to the string
  // 'true', so a note counts as missing. This asserts that rule is still in the
  // SQL, because relaxing it to "truthy" would let every such note through.
  assert.match(M176, /COALESCE\(v_caps->>k,\s*''\)\s*<>\s*'true'/,
    'processor_conformance no longer requires the exact string true');
});

// ── 2. every declaration is BACKED BY CODE ──────────────────────────────────

test('every processor declaring chargeback can actually report one', () => {
  const hook = read(WEBHOOK);
  const stripeHook = read('supabase/functions/stripe-webhook/index.ts');

  for (const key of LIVE) {
    if (CATALOG[key].chargeback !== true) continue;

    if (key === 'stripe') {
      // Stripe does not go through the BYOP endpoint; it has its own webhook.
      assert.match(stripeHook, /charge\.dispute/,
        'stripe declares chargeback but stripe-webhook does not handle charge.dispute.*');
      assert.match(stripeHook, /record_chargeback/,
        'stripe-webhook sees a dispute but never posts it to the ledger');
      continue;
    }

    // A BYOP processor needs a branch in the dispute webhook's mapper. Without
    // one, normalise() returns null, the endpoint logs "unknown_processor" and
    // the camp's books silently overstate collected cash — the exact failure
    // this whole migration exists to close.
    assert.ok(new RegExp(`processor\\s*===\\s*["']${key}["']`).test(hook),
      `processor "${key}" declares chargeback:true but byop-dispute-webhook's ` +
      `normalise() has no branch for it. Its disputes would be dropped.`);

    // And the endpoint must accept it at the door — a mapper branch behind a
    // guard that rejects the processor is unreachable code.
    const guard = hook.slice(hook.indexOf('unknown_processor') - 600,
                             hook.indexOf('unknown_processor'));
    assert.ok(guard.includes(`"${key}"`) || guard.includes(`'${key}'`),
      `byop-dispute-webhook rejects ?processor=${key} before normalise() is reached`);
  }
});

test('the dispute webhook posts to the ledger and does not guess a camp', () => {
  const hook = read(WEBHOOK);
  assert.match(hook, /record_chargeback/, 'the webhook never posts the chargeback');
  assert.match(hook, /resolve_chargeback/, 'a dispute that closes is never resolved');

  // Both RPCs live in 175. A rename there with no change here fails at runtime
  // as a warning in a log nobody reads.
  const m175 = read('migrations/175_chargebacks_and_collection_blocks.sql');
  assert.match(m175, /FUNCTION\s+public\.record_chargeback/);
  assert.match(m175, /FUNCTION\s+public\.resolve_chargeback/);

  // Posting a chargeback against the WRONG camp is worse than not posting it:
  // it moves a stranger's balance. When the camp cannot be resolved the endpoint
  // must decline rather than pick one.
  assert.match(hook, /recorded:\s*false/,
    'the webhook has no path that declines to record — it must be able to give up');
  assert.ok(/data\.length\s*===\s*1/.test(hook),
    'the webhook resolves a camp from credentials without requiring an unambiguous match');
});

test('every BYOP processor has the adapter file its catalog row names', () => {
  // 126: "adding a new processor is ONE INSERT plus one adapter file". A row
  // whose adapter_module points at a file that is not there means a camp can be
  // connected to a processor nothing can call.
  for (const key of LIVE) {
    if (key === 'stripe') continue;   // the stripe-* functions, not an adapter
    const p = `supabase/functions/_shared/adapters/${key}_adapter.ts`;
    assert.ok(exists(p),
      `processor "${key}" is in the catalog (seeded by ${SEEDED_IN[key]}) but ${p} does not exist`);
    const src = read(p);
    for (const fn of ['charge', 'refund']) {
      assert.ok(new RegExp(`\\b(async\\s+)?${fn}\\s*\\(`).test(src),
        `${p} declares ${fn} in the catalog but implements no ${fn}()`);
    }
  }
});

test('every processor declaring recurring is reachable from the autopay runner', () => {
  // The one that was actually wrong. Banquest's row said recurring was "not yet
  // wired into charge-due-installments"; it has been wired since. The note being
  // stale in the safe direction is luck — the same staleness the other way round
  // is a camp whose autopay silently never runs.
  const runner = read('supabase/functions/charge-due-installments/index.ts');
  for (const key of LIVE) {
    if (CATALOG[key].recurring !== true) continue;
    assert.ok(new RegExp(`["']${key}["']`).test(runner),
      `processor "${key}" declares recurring:true but charge-due-installments ` +
      `never mentions it, so its families' instalments are never charged`);
  }
});

// ── 3. the gate ─────────────────────────────────────────────────────────────

test('conformance is enforced on the table, not in one function', () => {
  // A check inside _admin_store_camp_processor_credentials would only cover the
  // one path that exists today. A trigger covers every future one.
  assert.match(M176, /CREATE\s+TRIGGER\s+trg_processor_conformance/i);
  assert.match(M176, /BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+processor_key\s+ON\s+camp_processor_credentials/i);
  assert.match(M176, /FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+public\._enforce_processor_conformance/i);
  assert.match(M176, /DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_processor_conformance/i,
    'the trigger is not idempotent — re-running the bundle would fail');
});

test('the refusal names what is missing', () => {
  // "Cannot connect" with no reason sends whoever hit it into the source. The
  // whole point is that the next processor's author is told what they skipped.
  const fn = M176.slice(M176.indexOf('_enforce_processor_conformance'));
  const body = fn.slice(0, fn.indexOf('$$;'));
  assert.match(body, /RAISE\s+EXCEPTION/i);
  assert.match(body, /string_agg\(m->>'capability'/,
    'the exception does not list the missing capabilities');
});

test("the 'none' sentinel stays non-conformant", () => {
  // 153's 'none' means "this camp has not chosen a processor". If a later
  // migration ever declared its capabilities true to make a screen tidier, the
  // gate would start accepting a credentials row that points at nothing.
  assert.ok(CATALOG.none, "the 'none' sentinel is missing from the catalog");
  const declared = REQUIRED.filter(c => CATALOG.none[c] === true);
  assert.deepStrictEqual(declared, [],
    `'none' declares ${declared.join(', ')} — a camp could be connected to the ` +
    `"no processor connected" placeholder`);
});

// ── 4. onboarding hands over the steps it cannot do itself ──────────────────
//
// The dispute webhook lives in the CAMP's own processor dashboard, which no
// code here can reach. That makes it a manual step, and a manual step written
// down only in a setup doc is what produced this whole gap: a camp onboarded
// without it takes payments perfectly well and shows no symptom until a parent
// charges back months later. So the connect call hands the checklist back at
// the moment someone is onboarding, and these tests keep it there.

const CONNECT = 'supabase/functions/admin-connect-processor/index.ts';

test('connecting a camp returns the setup steps it could not perform', () => {
  const src = read(CONNECT);
  assert.match(src, /remainingSetup/,
    'the connect response no longer carries the outstanding manual steps');
  assert.match(src, /byop-dispute-webhook/,
    'connecting a camp never mentions the dispute webhook — the step it exists to stop anyone forgetting');
  assert.match(src, /\$\{SUPABASE_URL\}\/functions\/v1\/byop-dispute-webhook/,
    'the dispute URL is not built from the real project URL, so it is a placeholder to look up rather than a URL to paste');
});

test('the dispute step is given for EVERY processor, not a hardcoded list', () => {
  // The point of generating it from processorKey is that the next processor
  // gets the step for free. A per-processor if/else would reproduce exactly the
  // "whatever its author remembered" failure one level up.
  const src = read(CONNECT);

  // The URL is built once, then pushed as a step. Everything between those two
  // points must be unconditional: an `if` in there is a guard, and the only
  // guard anyone would plausibly add is a per-processor one.
  const declared = src.indexOf('const disputeUrl');
  const pushed = src.indexOf('${disputeUrl}', declared);
  assert.ok(declared >= 0 && pushed > declared,
    'the dispute URL is no longer built and then pushed as a step — this test cannot see the shape it checks');

  const between = src.slice(declared, pushed);
  assert.ok(!/\bif\s*\(/.test(between),
    'the dispute step sits behind a branch. Whatever the condition is, a processor ' +
    'added later will not match it and will be onboarded without dispute reporting — ' +
    'which fails silently and is the exact gap this step exists to close.');

  // And it must be written for whatever processor was just connected.
  assert.ok(/\$\{processorKey\}/.test(between + src.slice(pushed, pushed + 400)),
    'the dispute step does not interpolate processorKey, so it is written for specific processors');
});

test('whether &camp= is needed is counted, never remembered', () => {
  // With one camp on a processor the webhook resolves the camp itself; with
  // several it refuses to guess. Getting that wrong by hand means either a
  // harmless extra parameter or silently dropped disputes, so it is derived.
  const src = read(CONNECT);
  assert.match(src, /camp_processor_credentials[\s\S]{0,200}eq\(\s*["']processor_key["']/,
    'the connect call never counts how many camps share the processor');
  assert.match(src, /campsOnProcessor\s*>\s*1\s*\?\s*`&camp=/,
    '&camp= is not decided from that count');
});

test('connecting a second camp warns that it just broke the first', () => {
  // The nastiest edge in the whole flow: camp #1 was set up correctly with no
  // &camp=, and connecting camp #2 makes the webhook ambiguous, so camp #1's
  // disputes stop being recorded. Nothing errors. The only moment anyone can
  // act on it is right here.
  const src = read(CONNECT);
  assert.match(src, /otherCampIds/,
    'the connect call does not work out which other camps share this processor');
  assert.match(src, /otherCampIds\.length\s*>\s*0/,
    'nothing is said when an existing camp is affected');
  assert.ok(/otherCampIds\.join/.test(src),
    'the affected camps are not named, so there is nothing to act on');
});

test('the required checklist is written down as well as returned', () => {
  // The returned steps are what gets acted on; the doc is what makes the shape
  // of the job visible before starting, and survives someone reading about
  // onboarding without running it.
  const doc = readRaw('BYOP_SETUP.md');
  assert.match(doc, /required checklist/i,
    'BYOP_SETUP.md has no onboarding checklist');
  assert.match(doc, /byop-dispute-webhook/,
    'the checklist does not mention the dispute webhook');
  assert.match(doc, /&camp=/,
    'the checklist never explains when &camp= is needed');
  assert.match(doc, /remainingSetup/,
    'the doc does not point at the steps the connect call hands back, so the two can drift apart unnoticed');
});

test('176 is idempotent', () => {
  // Every migration in this repo is re-run as part of APPLY_BUNDLE.sql.
  const creates = [...M176.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi)];
  for (const c of creates) {
    assert.ok(c[1], 'a CREATE FUNCTION in 176 is missing OR REPLACE');
  }
  for (const upd of M176.matchAll(/INSERT\s+INTO\s+payment_processor_catalog[\s\S]*?;/gi)) {
    assert.match(upd[0], /ON\s+CONFLICT/i, 'an INSERT into the catalog has no ON CONFLICT');
  }
});
