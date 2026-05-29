// =============================================================================
// supabase_data_layer.js — CAMPISTRY UNIFIED DATA LAYER v1.0
// =============================================================================
//
// Wraps every Campistry app's data access in a single module.
// Each method works via localStorage today and switches to Supabase
// by changing the USE_SUPABASE flag to true (or setting it per-table).
//
// Pattern:
//   1. All reads go through get*(). All writes go through save*()/add*()/delete*()
//   2. localStorage keys match the existing convention (campistry_*_v1)
//   3. When USE_SUPABASE is true, the same call goes to Supabase instead
//   4. Errors fall back to localStorage so the app never breaks offline
//
// Depends on: supabase_client.js (window.CampistryDB)
//
// Included by: campistry_live.html, campistry_health.html,
//              campistry_snacks.html, campistry_notes.html,
//              campistry_link_parent.html, campistry_link_admin.html
// =============================================================================

(function () {
    'use strict';

    // =========================================================================
    // CONFIG
    // =========================================================================

    var USE_SUPABASE = false; // flip to true once schema is deployed

    var LS = {
        // Live
        LIVE_DATA:          'campistry_live_v1',
        PARENT_REQUESTS:    'campistry_parent_requests_v1',
        // Health
        HEALTH_DATA:        'campistry_health_v1',
        HEALTH_SUBMISSIONS: 'campistry_health_submissions_v1',
        // Notes
        NOTES:              'campistry_notes_v1',
        // Snacks
        SNACKS:             'campistry_snacks_v1',
        // Messages
        MESSAGES:           'campistry_messages_v1',
        MESSAGE_THREADS:    'campistry_message_threads_v1'
    };

    // =========================================================================
    // INTERNAL HELPERS
    // =========================================================================

    function lsGet(key) {
        try { return JSON.parse(localStorage.getItem(key)) || null; }
        catch (_) { return null; }
    }

    function lsSet(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); }
        catch (_) {}
    }

    function camp() {
        if (window.CampistryDB && window.CampistryDB.getCampId) {
            return window.CampistryDB.getCampId();
        }
        return localStorage.getItem('campistry_camp_id') || null;
    }

    function userId() {
        if (window.CampistryDB && window.CampistryDB.getUserId) {
            return window.CampistryDB.getUserId();
        }
        return null;
    }

    function sbClient() {
        return window.CampistryDB && window.CampistryDB.getClient ? window.CampistryDB.getClient() : null;
    }

    function nowIso() { return new Date().toISOString(); }

    function todayDate() {
        var d = new Date();
        return d.toISOString().slice(0, 10);
    }

    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // Supabase error logger — keeps app working even if DB call fails
    async function sbCall(fn, fallback) {
        try {
            var result = await fn();
            if (result && result.error) {
                console.warn('[CampistryData] Supabase error, falling back:', result.error.message);
                return fallback;
            }
            return result && result.data !== undefined ? result.data : result;
        } catch (e) {
            console.warn('[CampistryData] Supabase exception, falling back:', e.message);
            return fallback;
        }
    }


    // =========================================================================
    // ══════════════════════════════════════════════════════════════════════════
    //  LIVE APP
    // ══════════════════════════════════════════════════════════════════════════
    // =========================================================================

    // ─── Attendance Records ───────────────────────────────────────────────────

    async function getAttendance(date) {
        date = date || todayDate();
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('attendance_records')
                        .select('*')
                        .eq('camp_id', camp())
                        .eq('record_date', date);
                }, []);
            }
        }
        var all = lsGet(LS.LIVE_DATA) || {};
        return (all[date] && all[date].attendance) || [];
    }

    async function saveAttendance(date, bunkId, bunkName, campers) {
        date = date || todayDate();
        var record = {
            camp_id: camp(),
            record_date: date,
            bunk_id: bunkId,
            bunk_name: bunkName,
            campers: campers,
            updated_at: nowIso()
        };
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('attendance_records')
                        .upsert(record, { onConflict: 'camp_id,record_date,bunk_id' });
                }, null);
            }
        }
        var all = lsGet(LS.LIVE_DATA) || {};
        if (!all[date]) all[date] = {};
        if (!all[date].attendance) all[date].attendance = [];
        var idx = all[date].attendance.findIndex(function (r) { return r.bunk_id === bunkId; });
        if (idx >= 0) { all[date].attendance[idx] = record; }
        else { all[date].attendance.push(record); }
        lsSet(LS.LIVE_DATA, all);
    }

    // ─── Early Pickups ────────────────────────────────────────────────────────

    async function getEarlyPickups(date) {
        date = date || todayDate();
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('early_pickups')
                        .select('*')
                        .eq('camp_id', camp())
                        .eq('pickup_date', date)
                        .order('created_at');
                }, []);
            }
        }
        var all = lsGet(LS.LIVE_DATA) || {};
        return (all[date] && all[date].earlyPickups) || [];
    }

    async function addEarlyPickup(pickup) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            pickup_date: pickup.date || todayDate(),
            status: 'pending',
            created_at: nowIso()
        }, pickup);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('early_pickups').insert(record);
                }, null);
            }
        }
        var all = lsGet(LS.LIVE_DATA) || {};
        var date = record.pickup_date;
        if (!all[date]) all[date] = {};
        if (!all[date].earlyPickups) all[date].earlyPickups = [];
        all[date].earlyPickups.unshift(record);
        lsSet(LS.LIVE_DATA, all);
        return record;
    }

    async function updateEarlyPickup(id, changes) {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('early_pickups').update(changes).eq('id', id);
                }, null);
            }
        }
        var all = lsGet(LS.LIVE_DATA) || {};
        Object.keys(all).forEach(function (date) {
            if (all[date].earlyPickups) {
                all[date].earlyPickups = all[date].earlyPickups.map(function (p) {
                    return p.id === id ? Object.assign({}, p, changes) : p;
                });
            }
        });
        lsSet(LS.LIVE_DATA, all);
    }

    // ─── Parent Pickup Requests ───────────────────────────────────────────────

    async function getParentPickupRequests(date) {
        date = date || todayDate();
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('parent_pickup_requests')
                        .select('*')
                        .eq('camp_id', camp())
                        .eq('request_date', date)
                        .order('created_at', { ascending: false });
                }, []);
            }
        }
        return lsGet(LS.PARENT_REQUESTS) || [];
    }

    async function submitParentPickupRequest(request) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            request_date: request.request_date || todayDate(),
            status: 'pending',
            created_at: nowIso()
        }, request);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('parent_pickup_requests').insert(record);
                }, null);
            }
        }
        var store = lsGet(LS.PARENT_REQUESTS) || [];
        store.unshift(record);
        lsSet(LS.PARENT_REQUESTS, store);
        return record;
    }

    async function reviewParentPickupRequest(id, status) {
        var changes = { status: status, reviewed_at: nowIso(), reviewed_by: userId() };
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('parent_pickup_requests').update(changes).eq('id', id);
                }, null);
            }
        }
        var store = lsGet(LS.PARENT_REQUESTS) || [];
        store = store.map(function (r) { return r.id === id ? Object.assign({}, r, changes) : r; });
        lsSet(LS.PARENT_REQUESTS, store);
    }


    // =========================================================================
    // ══════════════════════════════════════════════════════════════════════════
    //  HEALTH APP
    // ══════════════════════════════════════════════════════════════════════════
    // =========================================================================

    // ─── Sick Visits ──────────────────────────────────────────────────────────

    async function getSickVisits(date) {
        date = date || todayDate();
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('sick_visits')
                        .select('*')
                        .eq('camp_id', camp())
                        .eq('visit_date', date)
                        .order('logged_at', { ascending: false });
                }, []);
            }
        }
        var all = lsGet(LS.HEALTH_DATA) || {};
        return (all[date] && all[date].sickVisits) || [];
    }

    async function addSickVisit(visit) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            visit_date: visit.visit_date || todayDate(),
            logged_at: nowIso()
        }, visit);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('sick_visits').insert(record);
                }, null);
            }
        }
        var all = lsGet(LS.HEALTH_DATA) || {};
        var date = record.visit_date;
        if (!all[date]) all[date] = {};
        if (!all[date].sickVisits) all[date].sickVisits = [];
        all[date].sickVisits.unshift(record);
        lsSet(LS.HEALTH_DATA, all);
        return record;
    }

    async function updateSickVisit(id, changes) {
        changes.updated_at = nowIso();
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('sick_visits').update(changes).eq('id', id);
                }, null);
            }
        }
        var all = lsGet(LS.HEALTH_DATA) || {};
        Object.keys(all).forEach(function (date) {
            if (all[date].sickVisits) {
                all[date].sickVisits = all[date].sickVisits.map(function (v) {
                    return v.id === id ? Object.assign({}, v, changes) : v;
                });
            }
        });
        lsSet(LS.HEALTH_DATA, all);
    }

    // ─── Medication Dispensing ────────────────────────────────────────────────

    async function getMedications(date) {
        date = date || todayDate();
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('medication_dispensing')
                        .select('*')
                        .eq('camp_id', camp())
                        .eq('dispense_date', date)
                        .order('dispensed_at');
                }, []);
            }
        }
        var all = lsGet(LS.HEALTH_DATA) || {};
        return (all[date] && all[date].medications) || [];
    }

    async function addMedication(med) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            dispense_date: med.dispense_date || todayDate(),
            dispensed_at: nowIso()
        }, med);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('medication_dispensing').insert(record);
                }, null);
            }
        }
        var all = lsGet(LS.HEALTH_DATA) || {};
        var date = record.dispense_date;
        if (!all[date]) all[date] = {};
        if (!all[date].medications) all[date].medications = [];
        all[date].medications.unshift(record);
        lsSet(LS.HEALTH_DATA, all);
        return record;
    }

    // ─── Health Submissions (parent-uploaded docs) ────────────────────────────

    async function getHealthSubmissions(status) {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                var q = db.from('health_submissions')
                    .select('*')
                    .eq('camp_id', camp())
                    .order('submitted_at', { ascending: false });
                if (status) q = q.eq('status', status);
                return await sbCall(function () { return q; }, []);
            }
        }
        var store = lsGet(LS.HEALTH_SUBMISSIONS) || [];
        if (status) store = store.filter(function (s) { return s.status === status; });
        return store;
    }

    async function submitHealthDocument(doc) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            status: 'pending',
            submitted_at: nowIso()
        }, doc);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('health_submissions').insert(record);
                }, null);
            }
        }
        var store = lsGet(LS.HEALTH_SUBMISSIONS) || [];
        store.unshift(record);
        lsSet(LS.HEALTH_SUBMISSIONS, store);
        return record;
    }

    async function reviewHealthSubmission(id, status, reviewNotes) {
        var changes = {
            status: status,
            review_notes: reviewNotes || '',
            reviewed_at: nowIso(),
            reviewed_by: userId()
        };
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('health_submissions').update(changes).eq('id', id);
                }, null);
            }
        }
        var store = lsGet(LS.HEALTH_SUBMISSIONS) || [];
        store = store.map(function (s) { return s.id === id ? Object.assign({}, s, changes) : s; });
        lsSet(LS.HEALTH_SUBMISSIONS, store);
    }

    // ─── Medical Forms ────────────────────────────────────────────────────────

    async function getMedicalForm(camperName) {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('medical_forms')
                        .select('*')
                        .eq('camp_id', camp())
                        .eq('camper_name', camperName)
                        .maybeSingle();
                }, null);
            }
        }
        var store = lsGet('campistry_medical_forms_v1') || [];
        return store.find(function (f) { return f.camper_name === camperName; }) || null;
    }

    async function saveMedicalForm(form) {
        form = Object.assign({ camp_id: camp(), updated_at: nowIso() }, form);
        if (!form.created_at) form.created_at = form.updated_at;
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('medical_forms')
                        .upsert(form, { onConflict: 'camp_id,camper_name' });
                }, null);
            }
        }
        var store = lsGet('campistry_medical_forms_v1') || [];
        var idx = store.findIndex(function (f) { return f.camper_name === form.camper_name; });
        if (idx >= 0) { store[idx] = form; }
        else { store.push(form); }
        lsSet('campistry_medical_forms_v1', store);
        return form;
    }


    // =========================================================================
    // ══════════════════════════════════════════════════════════════════════════
    //  NOTES APP
    // ══════════════════════════════════════════════════════════════════════════
    // =========================================================================

    async function getNotes(filter) {
        // filter: 'all' | 'pinned' | 'shared' | 'archived' | 'trashed' | tag
        filter = filter || 'all';
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                var q = db.from('notes')
                    .select('*')
                    .eq('camp_id', camp())
                    .order('updated_at', { ascending: false });
                if (filter === 'pinned')   q = q.eq('is_pinned', true).eq('is_archived', false).eq('is_trashed', false);
                else if (filter === 'archived') q = q.eq('is_archived', true).eq('is_trashed', false);
                else if (filter === 'trashed')  q = q.eq('is_trashed', true);
                else if (filter === 'shared')   q = q.eq('visibility', 'team').eq('is_trashed', false);
                else if (filter !== 'all')      q = q.contains('tags', [filter]).eq('is_trashed', false);
                else                            q = q.eq('is_archived', false).eq('is_trashed', false);
                return await sbCall(function () { return q; }, []);
            }
        }
        var store = lsGet(LS.NOTES) || [];
        if (filter === 'trashed')       return store.filter(function (n) { return n.is_trashed; });
        if (filter === 'archived')      return store.filter(function (n) { return n.is_archived && !n.is_trashed; });
        if (filter === 'pinned')        return store.filter(function (n) { return n.is_pinned && !n.is_archived && !n.is_trashed; });
        if (filter === 'shared')        return store.filter(function (n) { return n.visibility === 'team' && !n.is_trashed; });
        if (filter !== 'all')           return store.filter(function (n) { return !n.is_trashed && Array.isArray(n.tags) && n.tags.indexOf(filter) >= 0; });
        return store.filter(function (n) { return !n.is_archived && !n.is_trashed; });
    }

    async function saveNote(note) {
        note = Object.assign({
            id: note.id || genId(),
            camp_id: camp(),
            author_id: userId(),
            created_at: nowIso()
        }, note, { updated_at: nowIso() });
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('notes').upsert(note);
                }, null);
            }
        }
        var store = lsGet(LS.NOTES) || [];
        var idx = store.findIndex(function (n) { return n.id === note.id; });
        if (idx >= 0) { store[idx] = note; }
        else { store.unshift(note); }
        lsSet(LS.NOTES, store);
        return note;
    }

    async function deleteNote(id) {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('notes').delete().eq('id', id);
                }, null);
            }
        }
        var store = lsGet(LS.NOTES) || [];
        lsSet(LS.NOTES, store.filter(function (n) { return n.id !== id; }));
    }

    async function trashNote(id) {
        return saveNote({ id: id, is_trashed: true, is_pinned: false });
    }

    async function restoreNote(id) {
        return saveNote({ id: id, is_trashed: false });
    }


    // =========================================================================
    // ══════════════════════════════════════════════════════════════════════════
    //  SNACKS / CANTEEN APP
    // ══════════════════════════════════════════════════════════════════════════
    // =========================================================================

    async function getCanteenAccounts() {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('canteen_accounts')
                        .select('*')
                        .eq('camp_id', camp())
                        .order('camper_name');
                }, []);
            }
        }
        var all = lsGet(LS.SNACKS) || {};
        return all.accounts || [];
    }

    async function getCanteenAccount(camperName) {
        var accounts = await getCanteenAccounts();
        return accounts.find(function (a) { return a.camper_name === camperName; }) || null;
    }

    async function upsertCanteenAccount(account) {
        account = Object.assign({
            id: account.id || genId(),
            camp_id: camp(),
            balance_cents: 0,
            created_at: nowIso()
        }, account, { updated_at: nowIso() });
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('canteen_accounts')
                        .upsert(account, { onConflict: 'camp_id,camper_name' });
                }, null);
            }
        }
        var all = lsGet(LS.SNACKS) || {};
        if (!all.accounts) all.accounts = [];
        var idx = all.accounts.findIndex(function (a) { return a.camper_name === account.camper_name; });
        if (idx >= 0) { all.accounts[idx] = account; }
        else { all.accounts.push(account); }
        lsSet(LS.SNACKS, all);
        return account;
    }

    async function addCanteenTransaction(txn) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            transaction_date: txn.transaction_date || todayDate(),
            created_at: nowIso()
        }, txn);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(async function () {
                    var res = await db.from('canteen_transactions').insert(record);
                    // Update the account balance
                    if (!res.error) {
                        await db.rpc('increment_canteen_balance', {
                            p_camp_id: camp(),
                            p_camper_name: record.camper_name,
                            p_amount_cents: record.amount_cents
                        });
                    }
                    return res;
                }, null);
            }
        }
        var all = lsGet(LS.SNACKS) || {};
        if (!all.transactions) all.transactions = [];
        all.transactions.unshift(record);
        // Update in-memory balance
        if (all.accounts) {
            var acc = all.accounts.find(function (a) { return a.camper_name === record.camper_name; });
            if (acc) {
                acc.balance_cents = (acc.balance_cents || 0) + record.amount_cents;
                acc.updated_at = nowIso();
            }
        }
        lsSet(LS.SNACKS, all);
        return record;
    }

    async function getCanteenTransactions(camperName) {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                var q = db.from('canteen_transactions')
                    .select('*')
                    .eq('camp_id', camp())
                    .order('created_at', { ascending: false });
                if (camperName) q = q.eq('camper_name', camperName);
                return await sbCall(function () { return q; }, []);
            }
        }
        var all = lsGet(LS.SNACKS) || {};
        var txns = all.transactions || [];
        if (camperName) txns = txns.filter(function (t) { return t.camper_name === camperName; });
        return txns;
    }


    // =========================================================================
    // ══════════════════════════════════════════════════════════════════════════
    //  LINK / MESSAGING
    // ══════════════════════════════════════════════════════════════════════════
    // =========================================================================

    async function getThreads() {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('message_threads')
                        .select('*')
                        .eq('camp_id', camp())
                        .eq('archived', false)
                        .order('last_message_at', { ascending: false });
                }, []);
            }
        }
        return lsGet(LS.MESSAGE_THREADS) || [];
    }

    async function createThread(thread) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            created_by: userId(),
            created_at: nowIso(),
            archived: false
        }, thread);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('message_threads').insert(record);
                }, null);
            }
        }
        var store = lsGet(LS.MESSAGE_THREADS) || [];
        store.unshift(record);
        lsSet(LS.MESSAGE_THREADS, store);
        return record;
    }

    async function getMessages(threadId) {
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(function () {
                    return db.from('messages')
                        .select('*')
                        .eq('thread_id', threadId)
                        .is('deleted_at', null)
                        .order('sent_at');
                }, []);
            }
        }
        var store = lsGet(LS.MESSAGES) || {};
        return (store[threadId] || []).filter(function (m) { return !m.deleted_at; });
    }

    async function sendMessage(msg) {
        var record = Object.assign({
            id: genId(),
            camp_id: camp(),
            sender_id: userId(),
            sent_at: nowIso()
        }, msg);
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                return await sbCall(async function () {
                    var res = await db.from('messages').insert(record);
                    if (!res.error) {
                        // Update thread's last_message_at
                        await db.from('message_threads').update({
                            last_message_at: record.sent_at,
                            last_message_preview: record.body.slice(0, 100)
                        }).eq('id', record.thread_id);
                    }
                    return res;
                }, null);
            }
        }
        var store = lsGet(LS.MESSAGES) || {};
        if (!store[record.thread_id]) store[record.thread_id] = [];
        store[record.thread_id].push(record);
        lsSet(LS.MESSAGES, store);
        // Update thread preview in localStorage
        var threads = lsGet(LS.MESSAGE_THREADS) || [];
        var t = threads.find(function (th) { return th.id === record.thread_id; });
        if (t) {
            t.last_message_at = record.sent_at;
            t.last_message_preview = record.body.slice(0, 100);
            lsSet(LS.MESSAGE_THREADS, threads);
        }
        return record;
    }

    async function markMessagesRead(threadId) {
        var uid = userId();
        if (!uid) return;
        if (USE_SUPABASE) {
            var db = sbClient();
            if (db) {
                // Append uid to read_by array (Supabase doesn't support array append
                // natively in postgrest — use rpc or raw update with union)
                return await sbCall(function () {
                    return db.rpc('mark_messages_read', { p_thread_id: threadId, p_user_id: uid });
                }, null);
            }
        }
        var store = lsGet(LS.MESSAGES) || {};
        if (store[threadId]) {
            store[threadId] = store[threadId].map(function (m) {
                if (!m.read_by) m.read_by = [];
                if (m.read_by.indexOf(uid) < 0) m.read_by.push(uid);
                return m;
            });
            lsSet(LS.MESSAGES, store);
        }
    }


    // =========================================================================
    // REALTIME SUBSCRIPTIONS (Supabase only)
    // =========================================================================

    var _subs = {};

    function subscribeParentRequests(campId, onInsert) {
        if (!USE_SUPABASE) return function () {};
        var db = sbClient();
        if (!db) return function () {};
        var key = 'parent-requests-' + campId;
        if (_subs[key]) return _subs[key];
        var sub = db.channel('parent-requests-' + campId)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'parent_pickup_requests',
                filter: 'camp_id=eq.' + campId
            }, function (payload) {
                if (typeof onInsert === 'function') onInsert(payload.new);
            })
            .subscribe();
        _subs[key] = function () { db.removeChannel(sub); delete _subs[key]; };
        return _subs[key];
    }

    function subscribeHealthSubmissions(campId, onInsert) {
        if (!USE_SUPABASE) return function () {};
        var db = sbClient();
        if (!db) return function () {};
        var key = 'health-subs-' + campId;
        if (_subs[key]) return _subs[key];
        var sub = db.channel('health-subs-' + campId)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'health_submissions',
                filter: 'camp_id=eq.' + campId
            }, function (payload) {
                if (typeof onInsert === 'function') onInsert(payload.new);
            })
            .subscribe();
        _subs[key] = function () { db.removeChannel(sub); delete _subs[key]; };
        return _subs[key];
    }

    function subscribeMessages(threadId, onInsert) {
        if (!USE_SUPABASE) return function () {};
        var db = sbClient();
        if (!db) return function () {};
        var key = 'messages-' + threadId;
        if (_subs[key]) return _subs[key];
        var sub = db.channel('messages-' + threadId)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'messages',
                filter: 'thread_id=eq.' + threadId
            }, function (payload) {
                if (typeof onInsert === 'function') onInsert(payload.new);
            })
            .subscribe();
        _subs[key] = function () { db.removeChannel(sub); delete _subs[key]; };
        return _subs[key];
    }


    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.CampistryData = {
        // Config
        useSupabase: function (flag) { USE_SUPABASE = !!flag; },
        isSupabaseMode: function () { return USE_SUPABASE; },

        // Live — Attendance
        getAttendance:              getAttendance,
        saveAttendance:             saveAttendance,

        // Live — Pickups
        getEarlyPickups:            getEarlyPickups,
        addEarlyPickup:             addEarlyPickup,
        updateEarlyPickup:          updateEarlyPickup,

        // Live — Parent Requests
        getParentPickupRequests:    getParentPickupRequests,
        submitParentPickupRequest:  submitParentPickupRequest,
        reviewParentPickupRequest:  reviewParentPickupRequest,

        // Health — Sick Visits
        getSickVisits:              getSickVisits,
        addSickVisit:               addSickVisit,
        updateSickVisit:            updateSickVisit,

        // Health — Medications
        getMedications:             getMedications,
        addMedication:              addMedication,

        // Health — Parent Docs
        getHealthSubmissions:       getHealthSubmissions,
        submitHealthDocument:       submitHealthDocument,
        reviewHealthSubmission:     reviewHealthSubmission,

        // Health — Medical Forms
        getMedicalForm:             getMedicalForm,
        saveMedicalForm:            saveMedicalForm,

        // Notes
        getNotes:                   getNotes,
        saveNote:                   saveNote,
        deleteNote:                 deleteNote,
        trashNote:                  trashNote,
        restoreNote:                restoreNote,

        // Snacks / Canteen
        getCanteenAccounts:         getCanteenAccounts,
        getCanteenAccount:          getCanteenAccount,
        upsertCanteenAccount:       upsertCanteenAccount,
        addCanteenTransaction:      addCanteenTransaction,
        getCanteenTransactions:     getCanteenTransactions,

        // Messages
        getThreads:                 getThreads,
        createThread:               createThread,
        getMessages:                getMessages,
        sendMessage:                sendMessage,
        markMessagesRead:           markMessagesRead,

        // Realtime
        subscribeParentRequests:    subscribeParentRequests,
        subscribeHealthSubmissions: subscribeHealthSubmissions,
        subscribeMessages:          subscribeMessages
    };

    console.log('📦 CampistryData layer loaded (mode: ' + (USE_SUPABASE ? 'Supabase' : 'localStorage') + ')');

})();
