// node --test tests/public_submission_clobber.test.js
//
// THE BUG: a family submits an application and the office's next save deletes it.
//
// `campistryMe` is one camp_state_kv row that the browser rewrites WHOLE from state
// it read when the page loaded. submit_public_application (migrations 083/184/190)
// is an anon RPC that merges a new enrollment into that same row, atomically,
// server-side — so the two writers do not conflict with each other, but the office's
// blob-replace erases anything that arrived after its page load.
//
//   10:00  a parent submits. The server merges it in. The parent sees "Success!".
//   09:55  the office tab loaded, without it.
//   10:05  the office renames a bunk. save() sends the whole blob from memory.
//          The application is gone and nobody finds out.
//
// campistry_finance_merge.js already solved this shape for money — payments,
// installment status, card fields — and stopped there. This is the same hole for
// applications, and it needs one thing money did not: a payment is never un-made,
// but an application IS deleted. So a blind restore would resurrect every deleted
// application and make deletion impossible. Deletes record themselves instead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const M = require(path.join(ROOT, 'campistry_finance_merge.js'));
const ME = read('campistry_me.js');
const HOOKS = read('integration_hooks.js');

/** An application as submit_public_application writes it. */
function app(name, status) {
    return { camperName: name, session: '1st Half', status: status || 'applied',
             appliedDate: '2026-03-01' };
}

// ── the merge ─────────────────────────────────────────────────────────────

test('an application the cloud has and we do not is PUT BACK', () => {
    // The whole bug, in one assertion.
    const local = { enrollments: { e1: app('Ari') } };
    const cloud = { enrollments: { e1: app('Ari'), e2: app('Malky') } };
    const rep = M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(rep.restored, 1);
    assert.strictEqual(local.enrollments.e2.camperName, 'Malky');
});

test('LOCAL wins on an application we also hold', () => {
    // The office legitimately accepts, declines and edits applications it can see.
    // Restoring the cloud's copy over a just-made decision would undo the office's
    // work instead of the parent's.
    const local = { enrollments: { e1: app('Ari', 'accepted') } };
    const cloud = { enrollments: { e1: app('Ari', 'applied') } };
    M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(local.enrollments.e1.status, 'accepted');
});

test('a DELETED application stays deleted', () => {
    // Without the tombstone a blind restore puts it straight back and deletion
    // becomes impossible — the save undoes itself.
    const local = { enrollments: { e1: app('Ari') } };
    M.tombstone(local, 'enrollments', 'e2', '2026-03-02');
    const cloud = { enrollments: { e1: app('Ari'), e2: app('Malky') } };
    const rep = M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(rep.restored, 0);
    assert.strictEqual(local.enrollments.e2, undefined);
});

test('a delete and a never-seen application are told apart in the SAME merge', () => {
    // This is the case a status guess or a timestamp comparison gets wrong.
    const local = { enrollments: {} };
    M.tombstone(local, 'enrollments', 'gone');
    const cloud = { enrollments: { gone: app('Deleted'), fresh: app('New') } };
    M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(local.enrollments.gone, undefined, 'the delete must be honoured');
    assert.strictEqual(local.enrollments.fresh.camperName, 'New', 'the new one must survive');
});

test('a brand-new application is restored whatever its status', () => {
    // It could be 'waitlisted' (migration 190 queues one when a session is full) or
    // already accepted by another tab. Only the tombstone decides, never the status.
    const cloud = { enrollments: { a: app('A', 'applied'), b: app('B', 'waitlisted'),
                                   c: app('C', 'accepted'), d: app('D', 'declined') } };
    const local = { enrollments: {} };
    assert.strictEqual(M.mergePublicSubmissions(local, cloud).restored, 4);
});

test('staff applications get the same protection', () => {
    const local = { staffApplications: {} };
    const cloud = { staffApplications: { s1: { name: 'Counsellor' } } };
    assert.strictEqual(M.mergePublicSubmissions(local, cloud).restored, 1);
    assert.strictEqual(local.staffApplications.s1.name, 'Counsellor');
    // And only the two branches the public RPC can write.
    assert.strictEqual(M.PUBLIC_KINDS.join(','), 'enrollments,staffApplications');
});

test('a branch nothing has submitted into is left alone', () => {
    const local = { enrollments: { e1: app('Ari') } };
    const cloud = { enrollments: { e1: app('Ari') } };
    const rep = M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(rep.restored, 0);
    assert.strictEqual(Object.keys(local).join(','), 'enrollments',
        'no empty branch should be conjured into existence');
});

test('a local branch that is missing entirely still receives the cloud’s', () => {
    // A tab that has never loaded enrollments must not be the reason they vanish.
    const local = {};
    const cloud = { enrollments: { e1: app('Ari') } };
    assert.strictEqual(M.mergePublicSubmissions(local, cloud).restored, 1);
    assert.strictEqual(local.enrollments.e1.camperName, 'Ari');
});

test('a tombstone is PRUNED once the delete has reached the cloud', () => {
    // Otherwise the list grows for ever, and a family handed the same id by a retry
    // could never re-apply.
    const local = { enrollments: {} };
    M.tombstone(local, 'enrollments', 'e9');
    const cloud = { enrollments: {} };          // the delete landed
    const rep = M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(rep.pruned, 1);
    assert.deepStrictEqual(M.tombstonesOf(local, 'enrollments'), {});
});

test('a tombstone for a delete still in flight is KEPT', () => {
    const local = { enrollments: {} };
    M.tombstone(local, 'enrollments', 'e9');
    const cloud = { enrollments: { e9: app('Still there') } };
    const rep = M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(rep.pruned, 0);
    assert.ok(M.tombstonesOf(local, 'enrollments').e9, 'the delete has not landed yet');
});

test('a tombstone records WHEN, so a stuck one can be found later', () => {
    const blob = {};
    M.tombstone(blob, 'enrollments', 'e1', '2026-03-02T10:00:00Z');
    assert.strictEqual(blob.deletedIds.enrollments.e1, '2026-03-02T10:00:00Z');
    M.tombstone(blob, 'enrollments', 'e2');
    assert.match(blob.deletedIds.enrollments.e2, /^\d{4}-\d{2}-\d{2}T/);
});

test('untombstone lets Undo work', () => {
    // Without it the restored application is deleted again by the very next save.
    const local = { enrollments: {} };
    M.tombstone(local, 'enrollments', 'e2');
    M.untombstone(local, 'enrollments', 'e2');
    local.enrollments.e2 = app('Restored');
    const cloud = { enrollments: { e2: app('Restored') } };
    M.mergePublicSubmissions(local, cloud);
    assert.ok(local.enrollments.e2, 'the restore must survive the merge');
});

test('a tombstone cannot be written for a branch outside the closed list', () => {
    // The same reasoning as p_kind in the RPC: this must never become a way to
    // suppress families, payments or anything else from a merge.
    const blob = {};
    M.tombstone(blob, 'families', 'f1');
    M.tombstone(blob, 'finance', 'x');
    assert.strictEqual(blob.deletedIds, undefined);
});

test('garbage in does not throw and does not invent anything', () => {
    assert.deepStrictEqual(M.mergePublicSubmissions(null, {}), { restored: 0, pruned: 0 });
    assert.deepStrictEqual(M.mergePublicSubmissions({}, null), { restored: 0, pruned: 0 });
    assert.deepStrictEqual(M.tombstonesOf(null, 'enrollments'), {});
    assert.deepStrictEqual(M.tombstonesOf({ deletedIds: 'nope' }, 'enrollments'), {});
    assert.deepStrictEqual(M.tombstone(null, 'enrollments', 'e1'), null);
    assert.deepStrictEqual(M.tombstone({}, 'enrollments', ''), {});
});

test('the whole-blob merge runs it and reports it', () => {
    const local = { finance: { payments: [] }, families: {}, enrollments: {} };
    const cloud = { finance: { payments: [] }, families: {},
                    enrollments: { e1: app('Ari') } };
    M.mergeCampistryMe(local, cloud);
    assert.strictEqual(local.enrollments.e1.camperName, 'Ari');
    assert.strictEqual(local._financeMergeReport.restored, 1);
    assert.ok('pruned' in local._financeMergeReport);
});

// ── the wiring ────────────────────────────────────────────────────────────

test('deletes record themselves BEFORE the save', () => {
    // After the save is too late: the merge inside that save would have already put
    // the application back from the cloud.
    const a = ME.indexOf('\nasync function deleteApplication(');
    const body = a > 0 ? ME.slice(a, a + 1600)
        : ME.slice(ME.indexOf('Delete Application?') - 600,
                   ME.indexOf('Delete Application?') + 1400);
    const tomb = body.indexOf("_tombstoneSubmission('enrollments',id)");
    const saved = body.indexOf('\n    save();', tomb > 0 ? tomb - 200 : 0);
    assert.ok(tomb > 0, 'deleteApplication does not record the delete');
    assert.ok(saved > tomb, 'the tombstone must be written before the save');
});

test('both Undo paths remove the tombstone', () => {
    // A restore that leaves the tombstone is undone again by the next save.
    assert.match(ME, /enrollments\[id\]=captured;\s*\n\s*_untombstoneSubmission\('enrollments',id\);/);
    assert.match(ME, /enrollments\[eid\]=capturedEnrollments\[eid\];\s*\n[\s\S]{0,180}_untombstoneSubmission\('enrollments',eid\);/);
});

test('the cascade delete records each enrollment it removes', () => {
    // ANCHORED TO THE FUNCTION, not to the loop shape. A bare
    // `Object.keys(enrollments).forEach` matches an unrelated camper-merge loop
    // earlier in the file, and indexOf takes the first — so this asserted against
    // the wrong 400 characters.
    const a = ME.indexOf('function cascadeCamperDelete');
    assert.ok(a > 0, 'cascadeCamperDelete is gone — re-anchor this test');
    const body = ME.slice(a, ME.indexOf('async function deleteCamper(n)', a));
    assert.ok(body.length > 0, 'empty slice — the anchors moved');
    assert.match(body, /delete enrollments\[eid\];\s*\n\s*_tombstoneSubmission\('enrollments',eid\);/);
});

test('deleteCamper’s Undo actually restores its enrollments', () => {
    // PRE-EXISTING BUG, found next door: the restore was guarded on the enrollment
    // still existing, but cascadeCamperDelete deletes those very keys — so the guard
    // was false for exactly the enrollments the snapshot was taken for, and Undo
    // silently restored none of them.
    assert.ok(!/if\(enrollments\[eid\]\)enrollments\[eid\]=capturedEnrollments\[eid\]/.test(ME),
        'the guard is back, and Undo restores nothing again');
    assert.match(ME, /\n            enrollments\[eid\]=capturedEnrollments\[eid\];/);
});

test('the tombstone list is loaded and saved, or it protects nothing', () => {
    // The recurring defect in this project is something recorded in one place and
    // read by nobody. A tombstone that does not survive a reload lets the next save
    // resurrect every application the office deleted.
    assert.match(ME, /\nvar deletedIds=\{\};/);
    assert.match(ME,
        /deletedIds=\(me\.deletedIds&&typeof me\.deletedIds==='object'\)\?me\.deletedIds:\{\};/);
    assert.match(ME, /\n            deletedIds:deletedIds,/);
});

test('the helpers degrade to a no-op without the merge module', () => {
    // campistry_me.js is loaded by pages that do not all carry the merge. No merge
    // means nothing can be resurrected, so there is nothing for a tombstone to stop.
    const a = ME.indexOf('function _tombstoneSubmission(');
    const body = ME.slice(a, ME.indexOf('/** The bulk rule', a));
    assert.match(body, /if\(!M\|\|typeof M\.tombstone!=='function'\)return;/);
    assert.match(body, /if\(!M\|\|typeof M\.untombstone!=='function'\)return;/);
});

test('the sync log reports restored submissions, not just money', () => {
    // It is the only signal that this is working at all.
    // The CONDITION, not just the argument list: a save whose only rescue was an
    // application would otherwise log nothing at all, which is the case that most
    // needs a line in the console.
    assert.match(HOOKS, /\|\| rep\.restored\)\) \{/);
    assert.match(HOOKS, /rep\.restored, 'public submission\(s\)'/);
});

test('campistry_me.html loads the merge module', () => {
    const html = read('campistry_me.html');
    const merge = html.indexOf('src="campistry_finance_merge.js');
    const me = html.indexOf('src="campistry_me.js');
    assert.ok(merge > 0, 'the merge is not loaded — every save would clobber');
    assert.ok(merge < me, 'it must load before the page that calls it');
});

test('a tombstone for something we HOLD is pruned, whoever forgot to clear it', () => {
    // rescindEnrollment deletes through the cascade and then RE-INSERTS the
    // withdrawn record for the audit trail. Without this the tombstone survived,
    // harmless while that tab held the record and a landmine for any later tab that
    // did not — it would suppress the restore for good.
    //
    // Self-healing on purpose: correctness must not depend on every present and
    // future restore path remembering to clear one.
    const local = { enrollments: { e1: app('Malky', 'withdrawn') } };
    M.tombstone(local, 'enrollments', 'e1');
    const cloud = { enrollments: { e1: app('Malky', 'enrolled') } };
    const rep = M.mergePublicSubmissions(local, cloud);
    assert.strictEqual(rep.pruned, 1);
    assert.deepStrictEqual(M.tombstonesOf(local, 'enrollments'), {});
    assert.strictEqual(local.enrollments.e1.status, 'withdrawn', 'local still wins');
});

test('rescind survives a save: the record stays and the tombstone goes', () => {
    // End to end, in the order the page does it: cascade (delete + tombstone),
    // status flip, re-insert, save (merge).
    const enrollments = { e1: { camperName: 'Malky', status: 'enrolled' } };
    const blob = { enrollments: enrollments };
    const e = enrollments.e1;
    delete enrollments.e1;
    M.tombstone(blob, 'enrollments', 'e1');
    e.status = 'withdrawn';
    if (!enrollments.e1) enrollments.e1 = e;
    M.mergePublicSubmissions(blob, { enrollments: { e1: { camperName: 'Malky', status: 'enrolled' } } });
    assert.strictEqual(blob.enrollments.e1.status, 'withdrawn',
        'the audit record the dialog promises must survive the merge');
    assert.deepStrictEqual(M.tombstonesOf(blob, 'enrollments'), {},
        'and must not leave a tombstone behind to bite a later tab');
});

// ── the register page must not push the whole blob ────────────────────────

const REG = read('campistry_register.html');

test('the register page does NOT push the whole campistryMe row', () => {
    // It used to, as "belt-and-suspenders" beside the real RPC, and it was a loaded
    // gun. The lite localStorage snapshot DELETES campistryMe.enrollments (it grows
    // without bound), the page then creates an empty one and puts this single
    // application in it, and saveGlobalSettings replaces the row with only a shallow
    // top-level merge. The pushed `enrollments` was one entry, replacing every real
    // one.
    //
    // It never fired for a parent only because _canWriteCampState() reads
    // localStorage.campistry_role and a visitor has none. A camp OWNER opening their
    // own registration link to see what parents see has role=owner in that same
    // browser — so testing the form wiped the camp's applications.
    assert.ok(REG.indexOf("saveGlobalSettings('campistryMe'") < 0,
        'the whole-blob nudge is back');
    assert.ok(REG.indexOf('_isAuthoritativeHandler') < 0,
        'something on this page is pushing state again');
    // The atomic, per-entry RPC is still the path.
    assert.match(REG, /client\.rpc\('submit_public_application'/);
});

test('the snapshot really does strip enrollments, which is why that mattered', () => {
    // The whole argument above rests on this one line. If the strip ever goes away
    // the reasoning changes, so it is asserted rather than assumed.
    assert.match(HOOKS, /delete lite\.campistryMe\.enrollments;/);
});

test('the register page loads no merge, because it pushes no shared state', () => {
    // 130fac6 took the merge module off this page on the grounds that it "has no job
    // on a page that writes only a localStorage draft and submits through an RPC",
    // and deposit_policy.test.js keeps it off — including keeping its filename out of
    // the file entirely, which is why the comment there names no name.
    //
    // That premise was not quite true at the time: the whole-blob nudge was still
    // there, and the nudge is exactly what the merge defends against. Removing the
    // nudge is what makes the rollback's reasoning hold — so the right end state is
    // both gone, not one propping up the other.
    assert.ok(REG.indexOf('campistry_finance_merge.js') < 0,
        'the merge is back on a public page that has nothing for it to protect');
    assert.ok(REG.indexOf("saveGlobalSettings('campistryMe'") < 0,
        'and the thing it would have protected against is back too');
});

test('no other public form pushes the whole blob either', () => {
    ['campistry_staff_apply.html', 'campistry_postaccept.html',
     'campistry_posthire.html'].forEach(f => {
        let src;
        try { src = read(f); } catch (e) { return; }   // not every page exists
        assert.ok(src.indexOf("saveGlobalSettings('campistryMe'") < 0,
            f + ' pushes the whole campistryMe row from a public page');
    });
});

test('the strip list is exactly the five branches the reasoning above assumes', () => {
    // Whether a public form's whole-row push WIPES a branch or merely re-pushes it
    // depends entirely on which keys this snapshot deletes. That made posthire safe
    // and postaccept destructive from otherwise identical code. If a sixth key joins
    // the list, every "this one is harmless" judgement has to be re-made — so the
    // list is pinned here rather than assumed.
    ['families', 'enrollments', 'payments', 'finance', 'bunkAssignments'].forEach(k => {
        assert.ok(HOOKS.indexOf('delete lite.campistryMe.' + k + ';') > 0,
            k + ' is no longer stripped — re-read the public-form comments');
    });
    const stripped = (HOOKS.match(/delete lite\.campistryMe\.\w+;/g) || []);
    assert.strictEqual(stripped.length, 5,
        'the strip list changed: ' + stripped.join(' '));
});
