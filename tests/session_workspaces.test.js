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

test('the server decides which workspace a tab is in, not the tab', () => {
    assert.match(UI, /var serverWs = d\.selected \|\| 'live';/);
    assert.match(UI, /if \(serverWs !== current\(\)[\s\S]{0,120}campistrySetWorkspace\(serverWs\)/);
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
    assert.match(dlg, /ok\.disabled = String\(this\.value \|\| ''\)\.trim\(\)\.toUpperCase\(\) !== o\.confirmWord/,
        'the confirm button must stay disabled until the words match');
    assert.match(dlg, /needsTyping \? ' disabled' : ''/, 'and start disabled');
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

test('the tills get nothing either', () => {
    // A canteen POS in a sandbox would be a till selling against planned
    // placement. Money keys are global anyway, but the roster it reads is not.
    ['campistry_snacks.html', 'campistry_snacks_pos.html'].forEach(page => {
        assert.ok(!read(page).includes('campistry_workspace.js'), page);
    });
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
