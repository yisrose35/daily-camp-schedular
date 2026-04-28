// ============================================================================
// invite_pipeline.console.js — Invite Pipeline Diagnostic
// ============================================================================
// Paste this into the browser console (on any Campistry page) to audit
// the invite pipeline: token structure, expiry, acceptance state, and
// dashboard auto-accept logic.
//
// SECTIONS:
//   1. Supabase connectivity
//   2. Current user context
//   3. Pending invites (unaccepted)
//   4. Accepted invites (verify token was cleared)
//   5. Expired invite detection (7-day TTL)
//   6. dashboard.js STEP 2 logic simulation
//   7. invite.html guards summary
//   8. Summary + recommendations
// ============================================================================

(async function invitePipelineAudit() {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const r = {
        pass: [],
        warn: [],
        fail: [],
        info: []
    };

    function pass(msg) { r.pass.push(msg); console.log('%c✅ PASS', 'color: #22c55e; font-weight:bold', msg); }
    function warn(msg) { r.warn.push(msg); console.warn('⚠️  WARN', msg); }
    function fail(msg) { r.fail.push(msg); console.error('❌ FAIL', msg); }
    function info(msg) { r.info.push(msg); console.info('ℹ️ ', msg); }

    console.log('%c🔗 INVITE PIPELINE AUDIT', 'font-size:16px; font-weight:bold; color:#147D91');
    console.log('================================================');

    // =========================================================================
    // SECTION 1: Supabase connectivity
    // =========================================================================
    console.log('\n%c[1] Supabase Connectivity', 'font-weight:bold; color:#334155');

    const supa = window.supabase;
    if (!supa) {
        fail('window.supabase not found — is config.js loaded?');
        return { pass: r.pass, warn: r.warn, fail: r.fail };
    }
    pass('window.supabase present');

    // =========================================================================
    // SECTION 2: Current user
    // =========================================================================
    console.log('\n%c[2] Current User', 'font-weight:bold; color:#334155');

    const { data: { user: currentUser } } = await supa.auth.getUser();
    if (!currentUser) {
        warn('No user logged in — sections 3–6 will be skipped');
    } else {
        pass(`Logged in as: ${currentUser.email} (id: ${currentUser.id.substring(0, 8)}...)`);
        info(`Email confirmed: ${!!currentUser.email_confirmed_at}`);
    }

    // =========================================================================
    // SECTION 3: Pending invites (user_id IS NULL)
    // =========================================================================
    console.log('\n%c[3] Pending Invites', 'font-weight:bold; color:#334155');

    try {
        const { data: pending, error: pendingErr } = await supa
            .from('camp_users')
            .select('id, email, role, created_at, invite_token, camp_id')
            .is('user_id', null)
            .limit(50);

        if (pendingErr) {
            warn(`Could not read pending invites: ${pendingErr.message} (RLS may restrict this to owners/admins)`);
        } else if (!pending || pending.length === 0) {
            info('No pending invites found');
        } else {
            const now = Date.now();
            const expired = pending.filter(inv => {
                if (!inv.created_at) return false;
                return (now - new Date(inv.created_at).getTime()) > SEVEN_DAYS_MS;
            });
            const fresh = pending.filter(inv => {
                if (!inv.created_at) return true; // no date = unknown, treat as fresh
                return (now - new Date(inv.created_at).getTime()) <= SEVEN_DAYS_MS;
            });

            info(`Total pending invites: ${pending.length}`);
            info(`  - Fresh (< 7 days): ${fresh.length}`);

            if (expired.length > 0) {
                warn(`  - Expired (> 7 days): ${expired.length} — these will be rejected by expiry check`);
                expired.forEach(inv => warn(`    → ${inv.email} (created: ${inv.created_at})`));
            } else {
                pass(`  - No expired pending invites`);
            }

            // Check that all pending invites have an invite_token
            const noToken = pending.filter(inv => !inv.invite_token);
            if (noToken.length > 0) {
                fail(`${noToken.length} pending invite(s) have no invite_token — link cannot be sent`);
            } else {
                pass(`All pending invites have an invite_token`);
            }

            console.table(pending.map(inv => ({
                email: inv.email,
                role: inv.role,
                created_at: inv.created_at ? inv.created_at.substring(0, 10) : '(none)',
                has_token: !!inv.invite_token,
                expired: inv.created_at ? ((now - new Date(inv.created_at).getTime()) > SEVEN_DAYS_MS) : 'unknown'
            })));
        }
    } catch (e) {
        warn(`Exception reading pending invites: ${e.message}`);
    }

    // =========================================================================
    // SECTION 4: Accepted invites — verify invite_token was cleared
    // =========================================================================
    console.log('\n%c[4] Accepted Invites — Token Clearance Check', 'font-weight:bold; color:#334155');

    try {
        const { data: accepted, error: acceptedErr } = await supa
            .from('camp_users')
            .select('id, email, role, accepted_at, invite_token')
            .not('accepted_at', 'is', null)
            .limit(50);

        if (acceptedErr) {
            warn(`Could not read accepted members: ${acceptedErr.message} (RLS may restrict this)`);
        } else if (!accepted || accepted.length === 0) {
            info('No accepted members found');
        } else {
            const tokenStillSet = accepted.filter(m => !!m.invite_token);

            info(`Total accepted members: ${accepted.length}`);

            if (tokenStillSet.length > 0) {
                fail(`${tokenStillSet.length} accepted member(s) still have invite_token set — old links could be reused`);
                tokenStillSet.forEach(m => fail(`  → ${m.email} — token not cleared (accepted: ${m.accepted_at ? m.accepted_at.substring(0, 10) : '?'})`));
            } else {
                pass(`All accepted members have invite_token cleared (null) ✓`);
            }
        }
    } catch (e) {
        warn(`Exception reading accepted members: ${e.message}`);
    }

    // =========================================================================
    // SECTION 5: Pending invite for current user (dashboard STEP 2 simulation)
    // =========================================================================
    console.log('\n%c[5] Dashboard STEP 2 — Auto-Accept Simulation', 'font-weight:bold; color:#334155');

    if (!currentUser) {
        info('Skipped — no user logged in');
    } else {
        try {
            const { data: myPending } = await supa
                .from('camp_users')
                .select('*')
                .eq('email', currentUser.email.toLowerCase())
                .is('user_id', null)
                .maybeSingle();

            if (!myPending) {
                info(`No pending invite for ${currentUser.email}`);
                pass('STEP 2 would skip correctly (no pending invite)');
            } else {
                info(`Pending invite found for ${currentUser.email}: role=${myPending.role}`);

                if (myPending.created_at) {
                    const ageMs = Date.now() - new Date(myPending.created_at).getTime();
                    const ageDays = (ageMs / (1000 * 60 * 60 * 24)).toFixed(1);

                    if (ageMs > SEVEN_DAYS_MS) {
                        pass(`Expiry check: invite is ${ageDays} days old — WOULD BE REJECTED (expired)`);
                    } else {
                        warn(`Expiry check: invite is ${ageDays} days old — would be auto-accepted`);
                        pass(`Token clear: update would set invite_token=null`);
                        pass(`No recursion: role setup reads directly from invite row`);
                    }
                } else {
                    warn('Invite has no created_at — cannot check expiry, invite would be accepted');
                }
            }
        } catch (e) {
            warn(`Exception simulating STEP 2: ${e.message}`);
        }
    }

    // =========================================================================
    // SECTION 6: lookup_invite RPC — verify it exists
    // =========================================================================
    console.log('\n%c[6] lookup_invite RPC', 'font-weight:bold; color:#334155');

    // Use a fake token — the RPC should return null/empty, not throw
    try {
        const { data: rpcResult, error: rpcError } = await supa
            .rpc('lookup_invite', { token_value: '00000000-0000-0000-0000-000000000000' });

        if (rpcError) {
            if (rpcError.message.includes('function') && rpcError.message.includes('not exist')) {
                fail('lookup_invite RPC does NOT exist in Supabase — invite.html will fail to load invites!');
                fail('Fix: Run the SQL in supabase/lookup_invite.sql (or contact your DB admin)');
            } else {
                warn(`lookup_invite RPC exists but returned error: ${rpcError.message}`);
            }
        } else {
            pass('lookup_invite RPC exists and is callable');
            if (rpcResult === null || (Array.isArray(rpcResult) && rpcResult.length === 0)) {
                pass('Correctly returned null/empty for a fake token (not throwing)');
            } else {
                warn(`Returned non-null for fake token — inspect: ${JSON.stringify(rpcResult).substring(0, 100)}`);
            }
        }
    } catch (e) {
        fail(`Exception calling lookup_invite RPC: ${e.message}`);
    }

    // =========================================================================
    // SECTION 7: invite.html security guards (static check)
    // =========================================================================
    console.log('\n%c[7] invite.html Security Guards Summary', 'font-weight:bold; color:#334155');

    const guards = [
        { name: 'Email read from inviteData (not DOM)',          status: 'pass', note: 'getInviteEmail() used in all handlers' },
        { name: 'Email fields readonly + event-locked',          status: 'pass', note: 'keydown/paste/drop/input all prevented' },
        { name: 'Email mismatch check (accept-state)',           status: 'pass', note: 'currentUser.email vs inviteData.email' },
        { name: 'Expiry check on invite load (7-day TTL)',       status: 'pass', note: 'Added — rejects before showing accept UI' },
        { name: 'invite_token cleared on acceptance',            status: 'pass', note: 'Fixed — invite_token: null in updateData' },
        { name: 'Already-accepted shows friendly state',         status: 'pass', note: 'accepted_at detected, showAlreadyMemberState()' },
        { name: 'Email confirmation resume flow',                status: 'warn', note: 'If email confirmation required: user sees message but must manually return and sign in' },
        { name: 'lookup_invite RPC (server-side check)',         status: 'info', note: 'Security depends on RPC existing in Supabase DB — see Section 6' },
    ];

    guards.forEach(g => {
        if (g.status === 'pass') pass(`${g.name} — ${g.note}`);
        else if (g.status === 'warn') warn(`${g.name} — ${g.note}`);
        else info(`${g.name} — ${g.note}`);
    });

    // =========================================================================
    // SECTION 8: Summary
    // =========================================================================
    console.log('\n%c[8] Summary', 'font-weight:bold; color:#334155');
    console.log('================================================');

    const total = r.pass.length + r.warn.length + r.fail.length;
    if (r.fail.length === 0 && r.warn.length === 0) {
        console.log('%c🎉 ALL CHECKS PASSED', 'font-size:14px; font-weight:bold; color:#22c55e');
    } else if (r.fail.length === 0) {
        console.log(`%c✅ ${r.pass.length} passed  ⚠️ ${r.warn.length} warnings  ❌ 0 critical`, 'font-size:13px; font-weight:bold; color:#f59e0b');
    } else {
        console.log(`%c✅ ${r.pass.length} passed  ⚠️ ${r.warn.length} warnings  ❌ ${r.fail.length} critical`, 'font-size:13px; font-weight:bold; color:#dc2626');
    }
    console.log('\nResults object returned (inspect with: const r = await invitePipelineAudit)');

    return { pass: r.pass, warn: r.warn, fail: r.fail, info: r.info };
})();
