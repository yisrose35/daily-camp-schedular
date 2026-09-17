// node --test tests/session_workspaces.test.js
//
// A camp runs on ONE set of operational state: who is in which bunk, what the
// divisions are, which bus goes where, what the rotation history says. So an
// office three weeks out from the second half has two options today — overwrite
// the running camp, or work on paper.
//
// A WORKSPACE is a named copy of that state. One is LIVE; the others are
// sandboxes. On the day, a sandbox is PROMOTED and the outgoing live state is
// archived so it can still be looked at.
//
// THE PROPERTY EVERYTHING ELSE HANGS OFF, and most of what is asserted here:
// THE LIVE WORKSPACE USES THE BARE KEYS. `app1` is `app1`. Every existing reader
// keeps working and a sandbox is physically unable to reach live data, so the
// worst reachable outcome of a bug in this feature is an empty-looking sandbox.
//
// And the second one: IDENTITY AND MONEY ARE NEVER WORKSPACED. There is no such
// thing as a draft payment.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = p => read(p).split('\n').filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join('\n');

const W = require(path.join(ROOT, 'campistry_workspace.js'));
const SQL = code('migrations/193_session_workspaces.sql');
const HOOKS = read('integration_hooks.js');
const BOOT = read('campistry_cloud_bootstrap.js');
const UI = read('campistry_workspace_ui.js');
const ADMIN = read('campistry_workspace_admin.js');

// ── live is the bare key ───────────────────────────────────────────────────

test('live returns the key untouched, for every key there is', () => {
    W.OPERATIONAL.concat(W.GLOBAL).concat(['somethingNobodyClassified']).forEach(k => {
        assert.strictEqual(W.keyFor(k, 'live'), k, k);
        assert.strictEqual(W.keyFor(k, null), k, k);
        assert.strictEqual(W.keyFor(k, ''), k, k);
        assert.strictEqual(W.keyFor(k, undefined), k, k);
    });
});

test('a sandbox prefixes ONLY the operational keys', () => {
    W.OPERATIONAL.forEach(k =>
        assert.strictEqual(W.keyFor(k, 'second_half'), 'ws:second_half/' + k, k));
    W.GLOBAL.forEach(k =>
        assert.strictEqual(W.keyFor(k, 'second_half'), k, k + ' must never be prefixed'));
});

test('a key nobody classified is GLOBAL, which is the safe direction', () => {
    // A new key that should have been sandboxed and was not is a planning
    // inconvenience. One that should have been global and got sandboxed could
    // put a summer of money in a draft.
    assert.strictEqual(W.keyFor('someNewKeyAddedLater', 'second_half'), 'someNewKeyAddedLater');
    assert.strictEqual(W.isGlobal('someNewKeyAddedLater'), true);
    assert.strictEqual(W.isOperational('someNewKeyAddedLater'), false);
});

test('money and identity are in GLOBAL, explicitly', () => {
    ['campistryMe', 'campistryMeFinance', 'campistryMePayroll',
     'campistrySnacks', 'campistryShop'].forEach(k => {
        assert.ok(W.GLOBAL.indexOf(k) >= 0, k + ' must be listed global');
        assert.ok(W.OPERATIONAL.indexOf(k) < 0, k + ' must not be operational');
    });
});

test('rotation history IS sandboxed, because generating writes to it', () => {
    // A trial schedule in a sandbox would otherwise burn the live camp's
    // rotation fairness — generating writes counts as a side effect.
    ['rotationHistory', 'rotationEpoch', 'historicalCounts', 'historicalCountedDates',
     'activityHistory', 'leagueHistory', 'swimRotationHistory'].forEach(k =>
        assert.ok(W.OPERATIONAL.indexOf(k) >= 0, k + ' must be sandboxed'));
});

test('a workspace can never be called "live"', () => {
    // 'live' is the ABSENCE of a prefix, so a workspace of that name would be a
    // second, different thing wearing the same name.
    assert.notStrictEqual(W.idFor('live'), 'live');
    assert.notStrictEqual(W.idFor('LIVE'), 'live');
    assert.notStrictEqual(W.idFor(''), 'live');
    assert.match(SQL, /CONSTRAINT camp_workspaces_id_not_live CHECK \(id <> 'live'\)/);
});

test('ids are safe to put in a key', () => {
    assert.strictEqual(W.idFor('2nd Half'), '2nd_half');
    assert.strictEqual(W.idFor('Second Half!!'), 'second_half');
    assert.ok(W.idFor('x'.repeat(200)).length <= 43);
    assert.ok(!/[^a-z0-9_]/.test(W.idFor('Ünïcode / slashes: yes')));
});

test('parseKey is the inverse, and a malformed prefix reads as live', () => {
    assert.deepStrictEqual(W.parseKey('app1'), { workspace: 'live', key: 'app1' });
    assert.deepStrictEqual(W.parseKey('ws:h2/app1'), { workspace: 'h2', key: 'app1' });
    // No slash: not a workspace key. Reading it as live is the safe answer.
    assert.deepStrictEqual(W.parseKey('ws:broken'), { workspace: 'live', key: 'ws:broken' });
    W.OPERATIONAL.forEach(k => {
        const stored = W.keyFor(k, 'h2');
        assert.deepStrictEqual(W.parseKey(stored), { workspace: 'h2', key: k }, k);
    });
});

// ── writes a sandbox may not make ──────────────────────────────────────────

test('live may write anything', () => {
    W.OPERATIONAL.concat(W.GLOBAL).forEach(k =>
        assert.strictEqual(W.canWrite(k, 'live').ok, true, k));
});

test('a sandbox may write its own operational keys and nothing else', () => {
    W.OPERATIONAL.forEach(k => assert.strictEqual(W.canWrite(k, 'h2').ok, true, k));
    W.GLOBAL.forEach(k => {
        const r = W.canWrite(k, 'h2');
        assert.strictEqual(r.ok, false, k);
        assert.strictEqual(r.reason, 'live_only');
        assert.match(r.message, /always live/);
    });
});

test('the sync layer DROPS a refused write and says so, never redirects it', () => {
    // Silently routing a sandbox edit to live is correct behaviour that is
    // indistinguishable from a bug. Refusing is not.
    assert.match(HOOKS, /const ok = _R\.canWrite\(k, _wsCurrent\);/);
    assert.match(HOOKS, /if \(!ok\.ok\) \{ _refused\.push\(k\); return null; \}/);
    assert.match(HOOKS, /\.filter\(Boolean\)/);
    assert.match(HOOKS, /logError\('Not saved — these are live-only/);
    assert.match(HOOKS, /campistryWorkspaceRefused/);
});

// ── the client routes reads and writes the same way ────────────────────────

test('the write path routes through the workspace', () => {
    assert.match(HOOKS, /key:\s+wsKey\(k\),/);
});

test('the fetch-merge read uses the SAME routed key the write will use', () => {
    // Merging live's app1 into a sandbox's app1 would drag live placement back
    // over planned placement on every single save.
    assert.match(HOOKS, /\.eq\('key', wsKey\(mergeKey\)\)/);
    assert.ok(!/\.eq\('key', mergeKey\)/.test(HOOKS),
        'a bare mergeKey read is left somewhere');
});

test('with no rule module loaded, wsKey is the identity function', () => {
    // A page that never loads campistry_workspace.js must behave exactly as it
    // did before this feature existed.
    const fn = HOOKS.slice(HOOKS.indexOf('function wsKey(key)'));
    assert.match(fn.slice(0, 320), /if \(!R\) return key;/);
});

test('the bootstrap fetches routed keys and maps them back', () => {
    assert.match(BOOT, /_fetchKeys = FETCH_KEYS\.map\(function \(k\) \{ return _wsR\.keyFor\(k, _ws\); \}\)/);
    assert.match(BOOT, /_wsR\.parseKey\(r\.key\)\.key/);
    // And in live it does neither.
    assert.match(BOOT, /if \(_wsR && !_wsR\.isLive\(_ws\)\)/);
});

test('the selected workspace lives in sessionStorage, not localStorage', () => {
    // A sandbox that survives closing the browser is one somebody comes back to
    // next week and mistakes for live.
    assert.match(HOOKS, /sessionStorage\.getItem\('campistry_workspace'\)/);
    assert.match(HOOKS, /sessionStorage\.setItem\('campistry_workspace'/);
    const block = HOOKS.slice(HOOKS.indexOf('var _wsCurrent'), HOOKS.indexOf('window.loadGlobalSettings'));
    assert.ok(!/localStorage\.(get|set)Item\('campistry_workspace'/.test(block),
        'the workspace choice must not persist across browser sessions');
});

// ── the server ────────────────────────────────────────────────────────────

test('the SQL key list matches the module exactly', () => {
    // Two lists that disagree would route a read to one key and a write to
    // another, which is a silent data loss rather than a visible failure.
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.workspace_operational_keys'));
    const arr = fn.slice(fn.indexOf('ARRAY['), fn.indexOf('];'));
    const sqlKeys = [...arr.matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(sqlKeys.slice().sort(), W.OPERATIONAL.slice().sort());
});

test('the SQL key function agrees with the module on every case', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.workspace_key'));
    // live → bare
    assert.match(fn, /= 'live'\s*\n\s*THEN p_key/);
    // global → bare
    assert.match(fn, /NOT \(p_key = ANY \(public\.workspace_operational_keys\(\)\)\)\s*\n\s*THEN p_key/);
    // otherwise prefixed, with the same separator the module uses
    assert.match(fn, /ELSE 'ws:' \|\| p_workspace \|\| '\/' \|\| p_key/);
    assert.strictEqual(W.PREFIX, 'ws:');
});

test('camp_state_kv itself is not altered — a sandbox is just more rows', () => {
    // No new column, no new primary key, no RLS rewrite. That is what keeps
    // every existing reader working.
    assert.ok(!/ALTER TABLE (public\.)?camp_state_kv/.test(SQL));
    assert.ok(!/DROP CONSTRAINT/.test(SQL));
});

test('creating a sandbox SEEDS it from live in one statement', () => {
    // A read-through fallback would let the first write copy one key while every
    // other key silently still showed live — a half-copy the office cannot see.
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.create_workspace'));
    assert.match(fn, /INSERT INTO camp_state_kv[\s\S]{0,500}SELECT kv\.camp_id, public\.workspace_key\(kv\.key, v_id\)/);
    assert.match(fn, /AND kv\.key = ANY \(public\.workspace_operational_keys\(\)\)/,
        'seeding must copy operational keys only');
    assert.match(fn, /ON CONFLICT \(camp_id, key\) DO NOTHING/,
        'a re-run must top up, not clobber work already done in the sandbox');
});

test('the seed cannot copy a global key', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.create_workspace'),
                         SQL.indexOf('FUNCTION public.parse_workspace_key'));
    W.GLOBAL.forEach(k => assert.ok(!fn.includes("'" + k + "'"), fn && k + ' is named in the seed'));
});

test('promotion archives AND promotes, in that order, under a lock', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.promote_workspace'));
    const lock = fn.indexOf('pg_advisory_xact_lock');
    const archive = fn.indexOf('SET key = public.workspace_key(kv.key, v_out_id)');
    const promote = fn.indexOf('SET key = public.parse_workspace_key(kv.key)');
    assert.ok(lock > 0, 'no lock');
    assert.ok(archive > lock, 'the archive must happen after the lock is taken');
    assert.ok(promote > archive,
        'promoting before archiving would collide with the live keys still in place');
});

test('the archive id is generated, so it can never overwrite an existing one', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.promote_workspace'));
    assert.match(fn, /v_out_id\s*:=\s*'archive_' \|\| to_char\(now\(\)/);
    assert.match(fn, /WHILE EXISTS \(SELECT 1 FROM camp_workspaces[\s\S]{0,140}v_out_id := v_out_id \|\| '_x'/);
    assert.ok(!/p_archive_id/.test(fn), 'the caller must not be able to name the archive id');
});

test('a promoted workspace stops existing as a sandbox', () => {
    // It IS live now, and live is the absence of a prefix — a leftover registry
    // row would offer to promote a workspace whose keys have all moved.
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.promote_workspace'));
    assert.match(fn, /DELETE FROM camp_workspaces w WHERE w\.camp_id = p_camp_id AND w\.id = p_id;/);
    assert.match(fn, /UPDATE camp_workspace_selection s\s*\n\s*SET workspace = 'live'/,
        'anybody sitting in it must be moved to live');
});

test('create, promote and delete are owner-only; listing is staff', () => {
    ['create_workspace', 'promote_workspace', 'delete_workspace'].forEach(fn => {
        const body = SQL.slice(SQL.indexOf('FUNCTION public.' + fn));
        assert.match(body.slice(0, 1400), /_workspace_is_owner\(p_camp_id\)/, fn);
        assert.match(body.slice(0, 1400), /'not_owner'/, fn);
    });
    // Reading the list has to work for a scheduler: they need to know where they are.
    ['list_workspaces', 'select_workspace'].forEach(fn => {
        const body = SQL.slice(SQL.indexOf('FUNCTION public.' + fn));
        assert.match(body.slice(0, 900), /camp_staff_member\(p_camp_id\)/, fn);
    });
});

test('the client is told whether it may manage, and hides the buttons if not', () => {
    // Reading the list is staff-level; creating, promoting and deleting are
    // owner-only. A button that comes back "not_owner" teaches people to
    // distrust the screen.
    assert.match(SQL, /'is_owner', public\._workspace_is_owner\(p_camp_id\),/);
    assert.match(ADMIN, /var canManage = \(d\.is_owner === true\);/);
    assert.match(ADMIN, /if \(addBtn\) addBtn\.style\.display = canManage \? '' : 'none';/);
    // The per-row Make official / Delete pair is behind the same flag.
    assert.match(ADMIN, /\(canManage\s*\n?\s*\? '<button[^']*promote\(/);
    assert.match(ADMIN, /: ''\)\s*\n\s*\+ '<\/div>';/);
});

test('a non-owner still sees which session they are in', () => {
    // The list itself is not hidden — that is the one thing a scheduler needs.
    const fn = ADMIN.slice(ADMIN.indexOf('var canManage'));
    assert.match(fn.slice(0, 260), /card\.style\.display = '';/,
        'the card must still show for staff');
});

test('live can never be deleted', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.delete_workspace'));
    assert.match(fn, /IF p_id IS NULL OR p_id = 'live' THEN[\s\S]{0,400}'cannot_delete_live'/);
    assert.match(fn, /AND kv\.key = ANY \(SELECT 'ws:' \|\| p_id \|\| '\/' \|\| k/,
        'delete must only ever remove PREFIXED rows');
});

test('a selection pointing at a workspace that is gone resolves to live', () => {
    // It gets promoted or deleted under an open tab; that tab must not carry on
    // writing to keys nothing owns.
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.list_workspaces'));
    assert.match(fn, /WHEN EXISTS \(SELECT 1 FROM camp_workspaces[\s\S]{0,120}THEN v_sel\s*\n\s*ELSE 'live'/);
});

test('neither registry table is reachable directly', () => {
    ['camp_workspaces', 'camp_workspace_selection'].forEach(t => {
        assert.match(SQL, new RegExp('ALTER TABLE public\\.' + t + ' ENABLE ROW LEVEL SECURITY;'));
        assert.match(SQL, new RegExp('REVOKE ALL ON TABLE public\\.' + t + ' FROM anon, authenticated;'));
    });
    assert.ok(!/CREATE POLICY/.test(SQL), 'RLS on with no policy is the point');
});

// ── the bar ───────────────────────────────────────────────────────────────

test('live renders no bar at all, and takes the spacer with it', () => {
    // A camp that never uses this must not be able to tell it exists.
    assert.match(UI, /if \(!R \|\| R\.isLive\(ws\)\) \{\s*\n\s*if \(existing\) existing\.remove\(\);/);
    assert.match(UI, /removeProperty\('padding-top'\)/);
});

test('the bar mounts itself, so no page can forget it', () => {
    assert.match(UI, /doc\.addEventListener\('DOMContentLoaded', boot\)/);
    assert.match(UI, /function boot\(\) \{\s*\n\s*render\(\);/);
});

test('the bar measures its own height rather than guessing', () => {
    // It wraps on a phone, and a fixed guess would cover the header.
    assert.match(UI, /var h = bar\.offsetHeight \|\| 38;/);
    assert.match(UI, /doc\.body\.style\.paddingTop = h \+ 'px';/);
});


test('switching reloads, because a half-hydrated page is the whole problem', () => {
    assert.match(UI, /root\.location\.reload\(\)/);
    assert.match(UI, /flushPendingSettingsSync/, 'queued writes must go before the keys move');
});

test('promotion needs the words typed, in the same dialog as the warning', () => {
    // One dialog rather than three, so the thing being confirmed is still on
    // screen while the words are typed.
    assert.match(ADMIN, /confirmWord: 'MAKE OFFICIAL'/);
    assert.match(ADMIN, /danger: true/);
    const dlg = ADMIN.slice(ADMIN.indexOf('function _dialog'));

    // EXACT, case-sensitive. This used to upper-case the input before comparing,
    // so "make official" sailed through — and a typed confirmation exists
    // precisely so it cannot be got past without reading it.
    assert.match(dlg, /String\(word && word\.value \|\| ''\)\.trim\(\) === o\.confirmWord/);
    assert.ok(!/toUpperCase\(\) !== o\.confirmWord/.test(dlg),
        'upper-casing the input lets the lower-case spelling through');

    assert.match(dlg, /needsTyping \? ' disabled' : ''/, 'and it starts disabled');
    assert.match(dlg, /if \(ok\.disabled \|\| !wordOk\(\)\) return;/,
        'and is re-checked on click, so a stray .click() cannot promote a plan');

    // It has to LOOK disabled as well as be disabled. The danger button had no
    // disabled style at all, so it sat there as a live red button refusing clicks
    // in silence — which is what got reported as the button working too early.
    assert.match(ADMIN, /\.ws-ft \.ws-danger\[disabled\]\{/,
        'the danger button needs a disabled style of its own');
    assert.match(dlg, /aria-disabled/, 'and it should say so in the accessibility tree');
});

test('no native browser dialogs anywhere in the workspace UI', () => {
    // The dashboard has no shared modal — confirmDialog/showModal live inside
    // campistry_me.js — so this file carries its own, styled to match the
    // dashboard's overlays.
    const strip = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    [['campistry_workspace_admin.js', ADMIN], ['campistry_workspace_ui.js', UI]].forEach(pair => {
        const code_ = strip(pair[1]);
        ['root.prompt(', 'root.confirm(', 'window.prompt(', 'window.confirm('].forEach(bad =>
            assert.ok(!code_.includes(bad), pair[0] + ' still uses ' + bad));
        assert.ok(!/(^|[^.\w])alert\(/.test(code_), pair[0] + ' still uses alert()');
    });
});

test('the dialog cancels on the backdrop and on Escape, like every other overlay', () => {
    const dlg = ADMIN.slice(ADMIN.indexOf('function _dialog'));
    assert.match(dlg, /if \(e\.target === ovl\) done\(null\)/);
    assert.match(dlg, /if \(e\.key === 'Escape'\)/);
    assert.match(dlg, /resolve\(val\)/, 'cancel must resolve, not reject');
});

test('the bar reports trouble without a blocking dialog', () => {
    // A modal thrown up by a status bar is out of place, and on a phone it is
    // hard to dismiss. Toast if the page has one, otherwise a line on the bar.
    assert.match(UI, /function trouble\(msg\)/);
    assert.match(UI, /if \(typeof root\.toast === 'function'\) \{ root\.toast\(msg, 'error'\); return; \}/);
    assert.match(UI, /BAR_ID \+ '-note'/);
    assert.match(UI, /trouble\('Could not switch/);
});

test('an un-run migration explains itself instead of hiding the card', () => {
    // Migrations here are pasted by hand, so "shipped but not applied" is a real
    // state — and a card that just hides gives an owner nothing to act on.
    assert.match(ADMIN, /err\.code === 'PGRST202'/);
    assert.match(ADMIN, /Could not find the function\|does not exist\|schema cache/);

    // The failure must be CARRIED OUT of the try, not swallowed by a catch that
    // hides the card — that is the bug this replaced.
    assert.match(ADMIN, /catch \(e\) \{ err = e; \}/,
        'a failed list_workspaces must set err, not hide the card');

    // And the notice must actually be gated on that flag. Asserting only that
    // the words exist passes just as happily when the branch is dead code, which
    // is exactly how a mutation of the condition slipped through.
    const flag = ADMIN.indexOf('var missing =');
    assert.ok(flag > 0, 'the un-run migration must be detected into a named flag');
    const branch = ADMIN.slice(flag);
    assert.match(branch.slice(0, 900), /\bif \(missing\) \{/,
        'the notice must be reached because missing is true');
    const body = branch.slice(branch.indexOf('if (missing) {'));
    assert.match(body.slice(0, 1400), /Not switched on yet/,
        'the notice text must live inside that branch');
    assert.match(body.slice(0, 1400), /193_session_workspaces\.sql/);
    // Only the owner is told: a scheduler cannot act on it.
    assert.match(body.slice(0, 1400),
        /if \(!looksLikeOwner\(\)\) \{ card\.style\.display = 'none'; return; \}/);
});

test('the owner hint is a hint, never a permission', () => {
    const fn = ADMIN.slice(ADMIN.indexOf('function looksLikeOwner'));
    assert.match(fn.slice(0, 700), /campistry_rbac_cache/);
    assert.match(fn.slice(0, 700), /every real permission is checked server-side|ONLY to decide/);
});

test('an empty card has a real call to action, not a sentence about one', () => {
    // The header's "+ New Plan" was easy to miss next to a card full of
    // explanatory text, which is exactly what happened.
    assert.match(ADMIN, /Start planning a session<\/button>/);
    assert.match(ADMIN, /class="btn-primary"/, 'it should look like the dashboard\'s primary action');
    const empty = ADMIN.slice(ADMIN.indexOf('if (!rows.length)'));
    assert.match(empty.slice(0, 800), /canManage/, 'and not be offered to a non-owner');
});

test('the admin card and the bar both say money is never copied', () => {
    assert.match(read('dashboard.html'), /Campers, families and payments are never copied/);
    const R = W.banner({ workspace: 'h2', label: '2nd Half' });
    assert.match(R.detail, /Campers, families and payments\s*\n?\s*are always the live ones|always the live ones/);
    assert.strictEqual(W.banner({ workspace: 'live' }), null);
});

test('the planning pages load the rule before the sync layer that uses it', () => {
    ['dashboard.html', 'flow.html', 'campistry_me.html',
     'campistry_go.html', 'campistry_live.html'].forEach(page => {
        const s = read(page);
        const rule = s.indexOf('campistry_workspace.js');
        const hooks = s.indexOf('integration_hooks.js');
        const ui = s.indexOf('campistry_workspace_ui.js');
        assert.ok(rule > 0 && hooks > 0 && ui > 0, page + ' is missing a workspace script');
        assert.ok(rule < hooks, page + ': the rule must load before integration_hooks');
        assert.ok(hooks < ui, page + ': the bar needs campistrySetWorkspace to exist');
    });
});

test('parent-facing pages get NOTHING, so their keys are always bare', () => {
    // With no rule module loaded, wsKey is the identity function — the register
    // form and the post-accept flows are structurally incapable of writing into
    // a sandbox, which is what they must be.
    ['campistry_register.html', 'campistry_postaccept.html',
     'campistry_posthire.html'].forEach(page => {
        assert.ok(!read(page).includes('campistry_workspace.js'),
            page + ' must not load the workspace rule');
    });
});

test('the REGISTER gets nothing, but the shop admin page does', () => {
    // This used to cover campistry_snacks.html too, on the reasoning that a till
    // in a plan would be selling against planned placement. Live testing changed
    // the call: Snacks is also where the shop and wallets are administered, and in
    // a plan it was showing no bar and listing today's campers, so an office
    // setting up next half was looking at the wrong children with nothing saying
    // so. It is now plan-aware, and a sale inside a plan is refused rather than
    // silently banked — see the money test below.
    //
    // The REGISTER keeps the original reasoning. It is held by somebody serving a
    // queue, and there is no version of that where the right answer is next half.
    assert.ok(!read('campistry_snacks_pos.html').includes('campistry_workspace.js'),
        'the POS must stay live-only');
});

test('the migration parses as SQL', () => {
    const { execFileSync } = require('node:child_process');
    let out;
    try {
        out = execFileSync('python3', ['-c',
            'import pglast,sys;pglast.parse_sql(open(sys.argv[1]).read());print("ok")',
            path.join(ROOT, 'migrations/193_session_workspaces.sql')], { encoding: 'utf8' });
    } catch (e) {
        if (/ModuleNotFoundError/.test(String(e.stderr || ''))) return;
        throw e;
    }
    assert.match(out, /ok/);
});

// ───────────────────────────────────────────────────────────────────────────
// WHICH CAMPERS A PLAN SHOWS.
//
// A plan copies the operational state and deliberately does NOT copy the roster,
// because campers and money are facts about the world. That leaves one question
// the copy cannot answer by itself: a plan for 2nd Half reads the same live
// roster as live, so without help it shows whoever is at camp today — 1st Half's
// children — to an office building 2nd Half's bunks and buses.
//
// The answer is to move the DATE, not the data: a plan records the session it is
// for, and presence reads the live roster as of that session. Nothing is
// duplicated, so nothing can drift.
// ───────────────────────────────────────────────────────────────────────────

test('a plan records the session it is for, all the way to the client', () => {
    // The column and the argument already existed; what was missing was anything
    // reading them.
    assert.match(SQL, /session\s+text/, 'camp_workspaces needs the column');
    assert.match(SQL, /'session', w\.session/, 'list_workspaces must return it');

    // Carried in sessionStorage beside the plan id, because presence is asked
    // synchronously during a render that may beat the server round trip.
    assert.match(HOOKS, /window\.campistryWorkspaceSession = function/);
    assert.match(HOOKS, /window\.campistrySetWorkspace = function \(ws, session\)/);

    // Both HALVES of that, separately. Switching plans works by reloading the
    // page, so a session that is read at boot but never written is a session that
    // is gone by the time anything asks — and asserting the key name alone passes
    // on the read reference by itself.
    assert.match(HOOKS, /sessionStorage\.getItem\('campistry_workspace_session'\)/,
        'the session must be read back at boot');
    assert.match(HOOKS, /sessionStorage\.setItem\('campistry_workspace_session', _wsSession\)/,
        'and written, or it cannot survive the reload that switching does');
    assert.match(HOOKS, /sessionStorage\.removeItem\('campistry_workspace_session'\)/,
        'and cleared, or live inherits the last plan’s session');
});

test('live never carries a session — live means now', () => {
    const fn = HOOKS.slice(HOOKS.indexOf('window.campistrySetWorkspace = function'));
    assert.match(fn.slice(0, 700), /_wsCurrent === 'live'\) \? '' :/,
        'switching to live must clear the session, not keep the last one');
    const getter = HOOKS.slice(HOOKS.indexOf('window.campistryWorkspaceSession = function'));
    assert.match(getter.slice(0, 300), /_wsCurrent === 'live'\) \? '' : _wsSession/,
        'and reading it in live must answer empty whatever is stored');
});

test('the bar names whose campers you are looking at', () => {
    // The roster is the one thing a plan does NOT copy, so the bar has to say
    // which half's children it is showing or the copy is misleading.
    assert.match(UI, /Campers: '\s*\n?\s*\+ esc\(_state\.session\)/);
    assert.match(UI, /_state\.session = \(found && found\.session\) \|\| ''/);
});

test('switching plans carries the new plan’s session across the reload', () => {
    const fn = UI.slice(UI.indexOf('U.switchTo = async function'));
    assert.match(fn.slice(0, 1600), /campistrySetWorkspace\(target, \(tgt && tgt\.session\) \|\| ''\)/,
        'otherwise the page comes back showing the wrong half on its first render');
});


test('creating a plan ASKS which session, it does not guess from the name', () => {
    // It used to infer this from the plan's label: call it exactly what you call
    // the session and it was linked, call it "2nd Half Draft" and it silently was
    // not. That guess decided which children the plan showed.
    assert.match(ADMIN, /p_session: forSession \|\| null/);
    assert.doesNotMatch(ADMIN, /p_session: suggest\.indexOf\(label\)/,
        'the naming-coincidence guess must be gone');
    assert.match(ADMIN, /label: 'This plan is for'/);
    assert.match(ADMIN, /Not tied to a session/, 'not tying it to one must stay possible');
});

test('an undated session cannot be picked, and says why', () => {
    // Pointing a plan at a session with no dates would silently do nothing, since
    // there is no date to read the roster as of.
    assert.match(ADMIN, /dated: !!win\.from/);
    assert.match(ADMIN, /disabled: !x\.dated/);
    assert.match(ADMIN, /give[^]{0,80}them start and end dates/,
        'and it must say how to fix it');
});

test('every plan row says whose campers it shows', () => {
    const rows = ADMIN.slice(ADMIN.indexOf('rows.forEach'));
    assert.match(rows.slice(0, 2500), /w\.session/);
    assert.match(rows.slice(0, 2500), /today\\u2019s campers|today’s campers/,
        'including the plans not tied to a session');
});

test('the roster picker stops vanishing without explanation', () => {
    // It is drawn only when a session has dates, which is correct — but a camp
    // that wants "just this half's kids" was given no way to discover that the
    // answer is two dates.
    const ME = read('campistry_me.js');
    const at = ME.indexOf('THE SESSION PICKER');
    assert.ok(at > 0);
    const block = ME.slice(at, at + 2600);
    assert.match(block, /else if\(\(sessions\|\|\[\]\)\.length>1\)/,
        'a camp with sessions but no dates must be told');
    assert.match(block, /start and end dates/);
});

test('the Me roster opens on the plan’s session, and still lets you change it', () => {
    const ME = read('campistry_me.js');
    assert.match(ME, /function _rosterWhenDefault\(\)/);
    assert.match(ME, /if\(_rosterWhenTouched\)return _rosterWhen/,
        'an explicit choice must win over the plan');
    assert.match(ME, /_rosterWhenTouched=true/);
    assert.match(ME, /info\.reason==='sandbox_session'/);
    // Every READ goes through the resolver, or the picker and the list disagree.
    const reads = ME.match(/_rosterWhen(?!Touched|Default|=)/g) || [];
    assert.ok(reads.length <= 4,
        'unrouted _rosterWhen reads left: ' + reads.length + ' (expected only the resolver\'s own)');
});

test('Go loads the presence modules it now depends on, in order', () => {
    const GO = read('campistry_go.html');
    assert.match(GO, /campistry_enrollment_window\.js/);
    assert.match(GO, /campistry_presence\.js/);
    assert.ok(GO.indexOf('integration_hooks.js') < GO.indexOf('campistry_presence.js'),
        'presence asks integration_hooks which plan this browser is in');
    assert.ok(GO.indexOf('campistry_enrollment_window.js') < GO.indexOf('campistry_presence.js'));
    assert.ok(GO.indexOf('campistry_presence.js') < GO.indexOf('campistry_go.js'));
});

test('the files this feature touches are loaded at ONE version everywhere', () => {
    // Browsers cache by URL. Changing a file without changing its ?v= means some
    // pages keep serving the old one, and the symptom is the feature working on
    // one page and not another — which reads exactly like a logic bug and is not.
    //
    // Deliberately scoped to the files this feature touches. Version drift is a
    // pre-existing, repo-wide condition across ~28 files; fixing all of it is a
    // separate job, and a test that failed on every one of them would be turned
    // off rather than fixed.
    const glob = require('node:fs').readdirSync(ROOT).filter(f => f.endsWith('.html'));
    const MINE = ['campistry_presence.js', 'campistry_enrollment_window.js',
                  'integration_hooks.js', 'campistry_me.js', 'campistry_go.js',
                  'campistry_workspace_ui.js', 'campistry_workspace_admin.js'];
    const seen = {};
    glob.forEach(page => {
        const src = read(page);
        MINE.forEach(f => {
            const re = new RegExp('src="' + f.replace(/\./g, '\\.') + '\\?v=([0-9a-z-]+)"', 'g');
            let m;
            while ((m = re.exec(src)) !== null) {
                (seen[f] = seen[f] || {})[m[1]] = (seen[f][m[1]] || []).concat(page);
            }
        });
    });
    Object.keys(seen).forEach(f => {
        const versions = Object.keys(seen[f]);
        assert.strictEqual(versions.length, 1,
            f + ' is loaded at ' + versions.length + ' different versions: '
            + versions.map(v => v + ' (' + seen[f][v].join(', ') + ')').join(' vs '));
    });
});



test('a plan called "live" is accepted under a different id, not refused', () => {
    // 'live' is the absence of a prefix, so the NAME is harmless but the id must
    // not collide. idFor renames it rather than rejecting it, which is why the
    // CHECK constraint is a backstop and not the mechanism.
    assert.strictEqual(W.idFor('live'), 'ws_live');
    assert.strictEqual(W.idFor('LIVE'), 'ws_live');
    assert.notStrictEqual(W.idFor('live'), 'live');
    // And the key built from it is a real sandbox key.
    assert.strictEqual(W.keyFor('app1', W.idFor('live')), 'ws:ws_live/app1');
});

test('the selection outlives the browser, and the bar is what prevents the mistake', () => {
    // Documented because the opposite is the intuitive guess, and the test plan
    // asserted the wrong thing until this was checked: select_workspace stores the
    // choice per user server-side, so reopening the app returns you to the plan.
    assert.match(SQL, /INSERT INTO camp_workspace_selection \(camp_id, user_id, workspace, updated_at\)/);
    assert.match(SQL, /ON CONFLICT \(camp_id, user_id\) DO UPDATE/);
    // Which is only safe because the bar is unmissable and on every page.
    assert.match(UI, /position:fixed/);
    assert.match(UI, /PLANNING: /);
});

// ── which plan a tab is in ─────────────────────────────────────────────────

test('a browser that was just opened is in LIVE, always', () => {
    // The one way this feature could damage a running camp with nobody doing
    // anything wrong: being quietly returned to a plan you were in last week and
    // editing it believing it was the camp. So the tab's workspace comes from
    // sessionStorage and NOWHERE else, and a fresh browser has none.
    const fn = HOOKS.slice(HOOKS.indexOf("var _wsCurrent = 'live';"));
    assert.match(fn.slice(0, 400), /sessionStorage\.getItem\('campistry_workspace'\)/);
    assert.ok(!/localStorage\.getItem\('campistry_workspace'\)/.test(HOOKS),
        'localStorage would survive closing the browser, which is the thing to avoid');

    // And refresh() must not put it back by reading the server's record.
    const r = UI.slice(UI.indexOf('U.refresh = async function'));
    const body = r.slice(0, 3000);
    assert.match(body, /var cur = current\(\);/,
        'the tab decides, from its own stored value');
    assert.doesNotMatch(body, /campistrySetWorkspace\(serverWs/,
        'adopting the server selection is what used to drag a fresh browser into a plan');
    assert.doesNotMatch(body, /var serverWs = d\.selected/,
        'the server record is a record, not an instruction');
});

test('the server is still authoritative about whether the plan EXISTS', () => {
    // Promoted or deleted from another tab and the plan is gone. Carrying on
    // would write to keys nothing owns any more.
    const fn = UI.slice(UI.indexOf('U.refresh = async function'));
    const body = fn.slice(0, 3000);
    assert.match(body, /if \(cur !== 'live' && !found\)/);
    assert.match(body, /campistrySetWorkspace\('live', ''\)/);
    assert.match(body, /root\.location\.reload\(\)/,
        'the page is still holding the vanished plan\u2019s data');
    assert.match(body, /_reloadedForWs/, 'and it must not be able to loop');
    assert.match(UI, /var _reloadedForWs = false;/);
});

test('the session is re-applied even when the plan id has not changed', () => {
    // A plan can be re-pointed at a different session. Presence reads the
    // session, not the id, so skipping this would keep answering for the old one.
    const fn = UI.slice(UI.indexOf('U.refresh = async function'));
    const body = fn.slice(0, fn.indexOf('U.switchTo'));
    assert.match(body, /campistrySetWorkspace\(cur, _state\.session\)/);
    // And presence memoizes its as-of date, so it has to be told.
    assert.match(body, /if \(wasSession !== _state\.session\)/);
    assert.match(body, /root\.CampistryPresence\.refresh\(\)/);
});

test('the REGISTER and the counsellor app are always live; the nurse and the shop are not', () => {
    // Health and Snacks were asked for explicitly after live testing: inside a
    // plan they showed no bar and listed today's campers, so an office planning
    // next half's medication sheet was reading the wrong children.
    ['campistry_health.html', 'campistry_snacks.html'].forEach(page => {
        const src = read(page);
        assert.match(src, /campistry_workspace\.js/, page + ' needs the rule');
        assert.match(src, /integration_hooks\.js/, page + ' needs the routing');
        assert.match(src, /campistry_workspace_ui\.js/, page + ' needs the bar');
        // Order is load-bearing on both counts.
        assert.ok(src.indexOf('campistry_workspace.js') < src.indexOf('campistry_cloud_bootstrap.js'),
            page + ': the bootstrap routes its fetch through the rule');
        assert.ok(src.indexOf('integration_hooks.js') < src.indexOf('campistry_presence.js'),
            page + ': presence asks integration_hooks which plan this browser is in');
    });

    // The POS and the counsellor app stay out of it deliberately. They are held by
    // somebody serving a queue or standing in front of a bunk, running the camp
    // that is happening now; there is no version of that where the right answer is
    // next half's data. Loading neither the rule nor integration_hooks keeps them
    // on bare keys (live) with presence answering for today.
    ['campistry_snacks_pos.html', 'campistry_lite.html'].forEach(page => {
        const src = read(page);
        assert.ok(!/campistry_workspace\.js/.test(src),
            page + ' must not become plan-aware');
        assert.ok(!/integration_hooks\.js/.test(src),
            page + ' must not load integration_hooks, or presence would filter by a '
                 + 'plan\u2019s session while the page still read live');
    });
});

test('a plan cannot take money, on the pages that now show a bar', () => {
    // Consequence of the above, stated so it is a decision and not a surprise:
    // canteen and shop balances are GLOBAL, so a till inside a plan refuses its
    // writes rather than banking into a draft. The bar is showing and the refusal
    // names live, which is the honest outcome — but it does mean the Snacks page
    // cannot sell while a plan is selected.
    ['campistrySnacks', 'campistryShop'].forEach(k => {
        assert.strictEqual(W.canWrite(k, 'second_half').ok, false, k);
        assert.match(W.canWrite(k, 'second_half').message, /always live/);
        assert.strictEqual(W.canWrite(k, 'live').ok, true, k + ' must work in live');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// THE LOCAL SNAPSHOT BELONGS TO ONE WORKSPACE.
//
// `campGlobalSettings_v1` and the IndexedDB snapshot beside it are ONE cache
// under ONE name, read raw in 163 places across 40-odd files. Nothing in them
// said which workspace they came from, so live's bunks and a plan's bunks took
// turns overwriting each other: open a plan and the cache fills with the plan's
// app1; go back to live and a page renders the PLAN's bunks until the cloud
// fetch lands — and the other way round, which is the one that loses work,
// because a save from that page writes what is on screen.
//
// Reported from live testing as "a plan shows live's bunks and divisions instead
// of its own; edits are saved to ws:<id>/… but don't show when you come back".
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run integration_hooks' BOOT-TIME stored-snapshot scrub against a fake
 * localStorage, and hand back what it left behind.
 *
 * The block is extracted and executed rather than pattern-matched, because what
 * matters is which keys survive — an assertion that the code merely mentions
 * OPERATIONAL would pass just as happily on a scrub that deleted nothing.
 */
function runBootScrub(storedWs, currentWs, state) {
    const start = HOOKS.indexOf('var _snapRaw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);');
    assert.ok(start > 0, 'the boot scrub block has moved or gone');
    const end = HOOKS.indexOf('} catch (_) {', start);
    const block = HOOKS.slice(start, end);

    const stored = Object.assign({}, state);
    if (storedWs !== null) stored.__ws = storedWs;
    const store = { campGlobalSettings_v1: JSON.stringify(stored) };

    const sandbox = {
        CONFIG: { LOCAL_STORAGE_KEY: 'campGlobalSettings_v1' },
        _WS_STAMP: '__ws',
        _wsCurrent: currentWs,
        _wsRule: () => W,
        log: () => {},
        JSON: JSON,
        localStorage: {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); }
        }
    };
    const vm = require('node:vm');
    vm.runInContext(block, vm.createContext(sandbox));
    return JSON.parse(store.campGlobalSettings_v1);
}

const SNAP = {
    app1: { camperRoster: { Eli: {} } },      // operational
    campStructure: { divisions: ['A'] },      // operational
    campistryGo: { savedRoutes: [1] },        // operational
    campistryMe: { families: { f1: {} } },    // GLOBAL — money and identity
    campistryMeFinance: { ledger: [1, 2] },   // GLOBAL
    campName: 'Camp Test'                     // GLOBAL
};

test('a live snapshot is scrubbed of operational keys when a plan is selected', () => {
    const out = runBootScrub('live', 'second_half', SNAP);
    ['app1', 'campStructure', 'campistryGo'].forEach(k =>
        assert.ok(!(k in out), k + " is live's and must not be shown inside a plan"));
    assert.strictEqual(out.__ws, 'second_half', 'and the snapshot is re-stamped');
});

test("a plan's snapshot is scrubbed when you go back to live", () => {
    // This is the direction that loses work: a page rendering the plan's bunks
    // while labelled live, then saving them over live.
    const out = runBootScrub('second_half', 'live', SNAP);
    ['app1', 'campStructure', 'campistryGo'].forEach(k =>
        assert.ok(!(k in out), k + " is the plan's and must not be shown in live"));
    assert.strictEqual(out.__ws, 'live');
});

test('switching between two plans scrubs too', () => {
    const out = runBootScrub('first_half', 'second_half', SNAP);
    assert.ok(!('campStructure' in out));
    assert.strictEqual(out.__ws, 'second_half');
});

test('money and identity SURVIVE the scrub, in every direction', () => {
    // They are identical in every workspace. Dropping them would cold-start the
    // roster and briefly degrade presence to "everyone is here" for no reason.
    [['live', 'second_half'], ['second_half', 'live'], ['a', 'b']].forEach(([from, to]) => {
        const out = runBootScrub(from, to, SNAP);
        assert.deepStrictEqual(out.campistryMe, SNAP.campistryMe, from + '->' + to);
        assert.deepStrictEqual(out.campistryMeFinance, SNAP.campistryMeFinance, from + '->' + to);
        assert.strictEqual(out.campName, 'Camp Test', from + '->' + to);
    });
});

test('a matching snapshot is left completely alone', () => {
    const same = runBootScrub('second_half', 'second_half', SNAP);
    assert.deepStrictEqual(same.app1, SNAP.app1, 'no needless cold start');
    assert.deepStrictEqual(same.campStructure, SNAP.campStructure);

    const live = runBootScrub('live', 'live', SNAP);
    assert.deepStrictEqual(live.app1, SNAP.app1);
    assert.deepStrictEqual(live.campStructure, SNAP.campStructure);
});

test('an UNSTAMPED snapshot counts as live, because that is what it was', () => {
    // Every snapshot written before this shipped has no stamp, and every one of
    // them is live's — this feature did not exist.
    const out = runBootScrub(null, 'second_half', SNAP);
    assert.ok(!('app1' in out), 'an unstamped snapshot in a plan must be scrubbed');
    const stays = runBootScrub(null, 'live', SNAP);
    assert.deepStrictEqual(stays.app1, SNAP.app1, 'and left alone in live');
});

test('the snapshot is stamped on the way out, on copies only', () => {
    // Both storage paths, or the next boot cannot tell whose data it has.
    assert.match(HOOKS, /lite\[_WS_STAMP\] = _wsNow\(\);/, 'the localStorage snapshot');
    assert.match(HOOKS, /stamped\[_WS_STAMP\] = _wsNow\(\);/, 'and the IndexedDB one');
    // On a COPY: `snapshot` is the live state object, and the cloud sync walks its
    // keys — a stamp written onto it would become a camp_state_kv row of its own.
    assert.match(HOOKS, /const stamped = Object\.assign\(\{\}, snapshot\);/);
    assert.match(HOOKS, /if \(k === _WS_STAMP\) return null;/,
        'and the sync must refuse to make a row of it even so');
});

test('the in-memory read paths are scrubbed as well as the stored one', () => {
    // getLocalSettings for the localStorage fallback, preloadFromIdb for the full
    // state that replaces it a moment later. Miss either and the cache is clean on
    // disk and dirty in memory.
    assert.match(HOOKS, /_localCache = _scrubForeignWorkspace\(\s*\n?\s*_migrateAccessRestrictionsKey\(raw \? JSON\.parse\(raw\) : \{\}\)\)/);
    assert.match(HOOKS, /_localCache = _scrubForeignWorkspace\(\s*\n?\s*_migrateAccessRestrictionsKey\(snap\.state\)\)/);
});

test('the workspace is readable before its own initialiser runs', () => {
    // _wsCurrent is assigned ~1300 lines below the scrub that reads it, and var
    // hoisting means an early caller sees undefined — which would default to live
    // and scrub a plan's snapshot on the grounds that live is selected.
    assert.match(HOOKS, /function _wsNow\(\)/);
    const fn = HOOKS.slice(HOOKS.indexOf('function _wsNow()'));
    assert.match(fn.slice(0, 420), /typeof _wsCurrent === 'string' && _wsCurrent/);
    assert.match(fn.slice(0, 420), /sessionStorage\.getItem\('campistry_workspace'\)/,
        'the fallback must be the same source the initialiser uses, not a guess');
});

test('the files that talk to camp_state_kv DIRECTLY route their operational keys', () => {
    // Most of the app reaches the table through saveGlobalSettings and the
    // bootstrap, both routed. These three went straight to it with a bare key, so
    // a plan's luggage was saved to live, a plan's league history burned live's,
    // and the subdivisions picker showed live's divisions inside a plan.
    assert.match(HOOKS, /window\.campistryWsKey = function \(key\) \{ return wsKey\(key\); \};/,
        'one exported answer to "what is this key called right now"');

    const cases = [
        ['campistry_go_luggage.js', /key: _wsK\('campistryLuggage'\)/, 'campistryLuggage'],
        ['scheduler_core_leagues.js', /key: _wsK\('leagueHistory'\)/, 'leagueHistory'],
        ['team_subdivisions_ui.js', /_wsK\('campStructure'\)/, 'campStructure']
    ];
    cases.forEach(([file, re, key]) => {
        const src = code(file);
        assert.match(src, re, file + ' must route ' + key);
        assert.match(src, /function _wsK\(key\)/, file + ' needs the helper');
        // And a page without the workspace layer must behave as it always did.
        const fn = src.slice(src.indexOf('function _wsK(key)'));
        assert.match(fn.slice(0, 400), /return key;/,
            file + ': no workspace layer must mean the bare key');
        // No bare access to that key left behind.
        assert.ok(!new RegExp("key', '" + key + "'").test(src),
            file + ' still has a bare ' + key + ' access');
        assert.ok(!new RegExp("key: '" + key + "'").test(src),
            file + ' still writes a bare ' + key);
    });

    // leagueHistory is read AND written — both sides, or a plan reads live's
    // history and writes its own, which is the worst of both.
    const lg = code('scheduler_core_leagues.js');
    assert.ok((lg.match(/_wsK\('leagueHistory'\)/g) || []).length >= 3,
        'every leagueHistory access must be routed, reads included');
});
