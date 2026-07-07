// =============================================================================
// campistry_link_data.js — Campistry Link Data Bridge v1.0
//
// PURPOSE:
//   Reads LIVE data from campGlobalSettings_v1 (Campistry Me) and
//   campistry_go_data (Campistry Go), maintains Link's own message/
//   broadcast store, and provides a smart notification engine that
//   cross-references camper → bus stop → parent for targeted sends.
//
// DATA SOURCES:
//   campGlobalSettings_v1.campistryMe.roster     → camper records
//   campGlobalSettings_v1.campistryMe.families   → family + parent info
//   campGlobalSettings_v1.campistryMe.structure   → division/grade/bunk tree
//   campGlobalSettings_v1.campistryMe.enrollments → enrollment data
//   campistry_go_data.savedRoutes                → generated bus routes
//   campistry_go_data.addresses                  → camper addresses
//
// OWN STORE:
//   campistry_link_v1  → messages, broadcasts, notifications, templates
//
// ARCHITECTURE:
//   CampistryLink.data   — read helpers
//   CampistryLink.msg    — message CRUD
//   CampistryLink.notify — smart notification engine
//   CampistryLink.send   — delivery dispatcher (app / email / sms hooks)
// =============================================================================
(function() {
    'use strict';
    console.log('[Link] Data Bridge v1.0 loading...');

    const LINK_STORE = 'campistry_link_v1';
    const GLOBAL_STORE = 'campGlobalSettings_v1';
    const GO_STORE = 'campistry_go_data';

    // =========================================================================
    // LINK INTERNAL STATE (persisted)
    // =========================================================================
    let _store = {
        messages: [],       // { id, from, to, toType, subject, body, channels, date, read, replied, threadId }
        broadcasts: [],     // { id, subject, body, channels, recipientFilter, recipientCount, date, readRate }
        notifications: [],  // { id, camperName, parentEmail, parentPhone, type, subject, body, channels, date, status }
        templates: [],      // { id, name, type, subject, bodyTemplate, dataFields }
        drafts: [],         // { id, subject, body, channels, recipients, savedAt }
        settings: {
            emailProvider: 'none',      // 'none' | 'sendgrid' | 'mailgun' | 'smtp'
            emailApiKey: '',
            smsProvider: 'none',        // 'none' | 'twilio' | 'vonage'
            smsApiKey: '',
            smsFromNumber: '',
            defaultChannels: ['app'],
            autoNotifyBusRoutes: false,
            autoNotifyScheduleChanges: false
        }
    };

    // =========================================================================
    // SUPABASE HELPERS
    // =========================================================================

    /** Returns { client, campId } or null if not ready */
    function _db() {
        var db = window.CampistryDB;
        if (!db) return null;
        var client = db.getClient ? db.getClient() : null;
        var campId = db.getCampId ? db.getCampId() : null;
        if (!client || !campId) return null;
        return { client: client, campId: campId };
    }

    // =========================================================================
    // PERSISTENCE
    // =========================================================================
    function loadStore() {
        try {
            var raw = localStorage.getItem(LINK_STORE);
            if (raw) {
                var parsed = JSON.parse(raw);
                // Merge with defaults (in case new keys were added)
                _store = Object.assign({}, _store, parsed);
                _store.settings = Object.assign({
                    emailProvider: 'none', emailApiKey: '', smsProvider: 'none',
                    smsApiKey: '', smsFromNumber: '', defaultChannels: ['app'],
                    autoNotifyBusRoutes: false, autoNotifyScheduleChanges: false
                }, parsed.settings || {});
            }
        } catch(e) { console.warn('[Link] Store load error:', e); }
    }

    function saveStore() {
        try {
            _store.updatedAt = new Date().toISOString();
            localStorage.setItem(LINK_STORE, JSON.stringify(_store));
            // Sync settings/templates/drafts to camp_state_kv — NOT the
            // notification history (that lives in link_outbox now).
            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('campistryLink', {
                    settings: _store.settings,
                    templates: _store.templates,
                    drafts: _store.drafts,
                    updatedAt: _store.updatedAt
                });
            }
        } catch(e) { console.warn('[Link] Store save error:', e); }
    }

    /**
     * Load recent notification history from link_outbox (cloud).
     * Called once after CampistryDB is ready. Merges into _store.notifications
     * without duplicating records already in localStorage.
     */
    function loadCloudHistory(limit) {
        var db = _db(); if (!db) return;
        limit = limit || 100;
        db.client
            .from('link_outbox')
            .select('id, type, camper_name, camper_id, parent_name, parent_email, parent_phone, subject, body, channels, status, created_at, sent_at')
            .eq('camp_id', db.campId)
            .order('created_at', { ascending: false })
            .limit(limit)
            .then(function(res) {
                if (res.error) { console.warn('[Link] loadCloudHistory error:', res.error.message); return; }
                var rows = res.data || [];
                var existingIds = new Set(_store.notifications.map(function(n) { return n.id; }));
                rows.forEach(function(row) {
                    if (existingIds.has(row.id)) return;
                    _store.notifications.push({
                        id: row.id,
                        camperName: row.camper_name,
                        camperId: row.camper_id,
                        parentName: row.parent_name,
                        parentEmail: row.parent_email,
                        parentPhone: row.parent_phone,
                        type: row.type,
                        subject: row.subject,
                        body: row.body,
                        channels: row.channels || ['app'],
                        date: row.created_at,
                        status: row.status,
                        _fromCloud: true
                    });
                });
                console.log('[Link] Cloud history loaded:', rows.length, 'records');
            });
    }

    /**
     * Insert a batch of notification records into link_outbox.
     * Non-blocking — failures log a warning but don't break the local flow.
     */
    function _insertOutboxRows(records) {
        var db = _db(); if (!db) return;
        var rows = records.map(function(r) {
            return {
                camp_id:      db.campId,
                type:         r.type || 'custom',
                camper_name:  r.camperName || null,
                camper_id:    r.camperId   || null,
                parent_name:  r.parentName || null,
                parent_email: r.parentEmail || null,
                parent_phone: r.parentPhone || null,
                subject:      r.subject || '',
                body:         r.body    || '',
                channels:     r.channels || ['app'],
                status:       r.status  || 'queued'
            };
        });
        db.client
            .from('link_outbox')
            .insert(rows)
            .then(function(res) {
                if (res.error) console.warn('[Link] link_outbox insert error:', res.error.message);
                else console.log('[Link] link_outbox: inserted', rows.length, 'rows');
            });
    }

    /**
     * Insert a broadcast record into link_broadcasts.
     */
    /**
     * Insert a direct admin->parent message into link_messages (migration 020).
     * Non-blocking — failures log a warning but don't break the local flow.
     * Without this, msg.send() only ever wrote to the admin's own browser
     * localStorage, so a message could never reach a parent on another device.
     */
    function _insertMessageRow(m) {
        var db = _db(); if (!db) return;
        db.client
            .from('link_messages')
            .insert({
                id:           m.id,
                camp_id:      db.campId,
                thread_id:    m.threadId || m.id,
                direction:    m.direction || 'out',
                parent_name:  m.to || '',
                parent_email: (m.metadata && m.metadata.parentEmail) || '',
                camper_name:  (m.metadata && m.metadata.camperName) || null,
                subject:      m.subject || '',
                body:         m.body    || '',
                channels:     m.channels || ['app'],
                read:         !!m.read
            })
            .then(function(res) {
                if (res.error) console.warn('[Link] link_messages insert error:', res.error.message);
            });
    }

    /**
     * Admin-side hard delete (admin owns the camp's data outright — this is a
     * real DELETE, not a hide). Scoped by the link_messages_delete RLS policy
     * (owner/admin only) so a scheduler session can't call this successfully
     * even if it tried.
     */
    function _deleteMessageRow(id) {
        var db = _db(); if (!db) return Promise.resolve({ error: 'no_db' });
        return db.client
            .from('link_messages')
            .delete()
            .eq('id', id)
            .eq('camp_id', db.campId)
            .then(function(res) {
                if (res.error) console.warn('[Link] link_messages delete error:', res.error.message);
                return res;
            });
    }

    /** Admin-only archived/important flags — plain column updates. */
    function _updateMessageFlag(id, field, value) {
        var db = _db(); if (!db) return Promise.resolve({ error: 'no_db' });
        var patch = {}; patch[field] = !!value;
        return db.client
            .from('link_messages')
            .update(patch)
            .eq('id', id)
            .eq('camp_id', db.campId)
            .then(function(res) {
                if (res.error) console.warn('[Link] link_messages ' + field + ' update error:', res.error.message);
                return res;
            });
    }

    /**
     * Load message history from link_messages (cloud) — both directions, so
     * the admin inbox picks up parent replies made via submit_message_reply,
     * not just messages sent from this same browser.
     */
    function loadCloudMessages(limit, cb) {
        var db = _db(); if (!db) return;
        limit = limit || 200;
        db.client
            .from('link_messages')
            .select('id, thread_id, direction, parent_name, parent_email, camper_name, subject, body, channels, read, archived, important, created_at')
            .eq('camp_id', db.campId)
            .order('created_at', { ascending: false })
            .limit(limit)
            .then(function(res) {
                if (res.error) { console.warn('[Link] loadCloudMessages error:', res.error.message); return; }
                var rows = res.data || [];
                var byId = {};
                _store.messages.forEach(function(m) { byId[m.id] = m; });
                var changed = false;
                rows.forEach(function(row) {
                    var existing = byId[row.id];
                    if (existing) {
                        // Row already known locally (e.g. just sent from this browser) —
                        // still refresh archived/important/read so multi-device edits show up.
                        if (existing.archived !== !!row.archived || existing.important !== !!row.important || existing.read !== row.read) changed = true;
                        existing.archived = !!row.archived;
                        existing.important = !!row.important;
                        existing.read = row.read;
                        return;
                    }
                    changed = true;
                    _store.messages.push({
                        id: row.id, direction: row.direction,
                        from: row.direction === 'in' ? (row.parent_name || 'Parent') : 'Camp Admin',
                        to:   row.direction === 'out' ? (row.parent_name || '') : 'Camp Office',
                        toType: 'individual',
                        subject: row.subject, body: row.body,
                        channels: row.channels || ['app'],
                        date: row.created_at, read: row.read, replied: false,
                        archived: !!row.archived, important: !!row.important,
                        threadId: row.thread_id,
                        metadata: { parentEmail: row.parent_email, camperName: row.camper_name }
                    });
                });
                saveStore();
                // Refresh whatever's currently on screen so a parent reply
                // doesn't require navigating away and back to appear — but only
                // when something actually changed, so a poll doesn't disrupt the
                // admin's current view/filter/scroll every cycle.
                if (changed) {
                    try {
                        var f = window._inboxReadFilter || 'all';
                        if (window.currentMsgTab === 'inbox' && typeof window.renderAdminMsgs === 'function') window.renderAdminMsgs(f);
                        if (window.currentMsgTab === 'outbox' && typeof window.renderSentList === 'function') window.renderSentList();
                    } catch (e) {}
                }
                if (typeof cb === 'function') try { cb(changed); } catch (e) {}
            });
    }

    function _insertBroadcastRow(b) {
        var db = _db(); if (!db) return;
        db.client
            .from('link_broadcasts')
            .insert({
                camp_id:          db.campId,
                subject:          b.subject || '',
                body:             b.body    || '',
                channels:         b.channels || ['app'],
                recipient_filter: b.recipientFilter || null,
                recipient_count:  b.recipientCount  || 0
            })
            .then(function(res) {
                if (res.error) console.warn('[Link] link_broadcasts insert error:', res.error.message);
            });
    }

    // =========================================================================
    // DATA READERS — Pull live from Me + Go
    // =========================================================================
    var data = {};

    /** Get unified state from campGlobalSettings_v1 with fallbacks */
    data.getGlobalState = function() {
        // integration_hooks provides _localCache (full state; camperRoster not stripped)
        if (typeof window.loadGlobalSettings === 'function') {
            try {
                var lgs = window.loadGlobalSettings();
                if (lgs && (lgs.app1 || lgs.campStructure || lgs.campistryMe)) return lgs;
            } catch (_) {}
        }
        // Fallback: localStorage keys (camperRoster may be stripped on big camps)
        var keys = [GLOBAL_STORE, 'CAMPISTRY_LOCAL_CACHE', 'CAMPISTRY_UNIFIED_STATE'];
        for (var i = 0; i < keys.length; i++) {
            try {
                var raw = localStorage.getItem(keys[i]);
                if (raw) {
                    var parsed = JSON.parse(raw);
                    // Validate it has real data (not empty shell)
                    if (parsed.app1 || parsed.campStructure || parsed.campistryMe) {
                        return parsed;
                    }
                }
            } catch(e) {}
        }
        return {};
    };

    /** Get Me sub-state */
    data.getMe = function() {
        var g = data.getGlobalState();
        return g.campistryMe || {};
    };

    /** 
     * Get camper roster: { "Full Name": { camperId, division, grade, bunk, parent1Name, ... } }
     * Me stores this at g.app1.camperRoster (NOT inside campistryMe)
     */
    data.getRoster = function() {
        var g = data.getGlobalState();
        // Primary path: app1.camperRoster (where Me actually stores it)
        var roster = (g.app1 && g.app1.camperRoster) ? g.app1.camperRoster : {};
        // Fallback: campistryMe.roster (shouldn't happen but just in case)
        if (!Object.keys(roster).length) {
            var me = g.campistryMe || {};
            roster = me.roster || me.camperRoster || {};
        }
        return roster;
    };

    /** 
     * Get families: { famId: { name, households: [{parents:[{name,phone,email}], address}], camperIds } }
     * Me stores this at g.campistryMe.families
     */
    data.getFamilies = function() {
        return data.getMe().families || {};
    };

    /** 
     * Get camp structure: { "Juniors": { color, grades: { "1st Grade": { bunks: [...] } } } }
     * Me stores this at g.campStructure (top level, NOT inside campistryMe)
     */
    data.getStructure = function() {
        var g = data.getGlobalState();
        return g.campStructure || {};
    };

    /** Get enrollments */
    data.getEnrollments = function() {
        return data.getMe().enrollments || {};
    };

    /** Get Go state */
    data.getGoState = function() {
        try {
            return JSON.parse(localStorage.getItem(GO_STORE) || '{}');
        } catch(e) { return {}; }
    };

    /** Get camp name — checks Go setup, then Me/app1 */
    data.getCampName = function() {
        var go = data.getGoState();
        if (go.setup && go.setup.campName) return go.setup.campName;
        var g = data.getGlobalState();
        if (g.app1 && g.app1.campName) return g.app1.campName;
        if (g.campistryMe && g.campistryMe.campName) return g.campistryMe.campName;
        return 'Camp';
    };

    /** Get generated bus routes from Go */
    data.getBusRoutes = function() {
        var go = data.getGoState();
        return go.savedRoutes || go.dismissal || go.arrival || null;
    };

    /** Get Go addresses — check both Go's own store and global state */
    data.getGoAddresses = function() {
        var go = data.getGoState();
        var addrs = go.addresses || {};
        // Also check campGlobalSettings_v1.campistryGo.addresses (Me syncs here)
        if (!Object.keys(addrs).length) {
            var g = data.getGlobalState();
            addrs = (g.campistryGo && g.campistryGo.addresses) ? g.campistryGo.addresses : {};
        }
        return addrs;
    };

    /** Get Go buses */
    data.getGoBuses = function() {
        return data.getGoState().buses || [];
    };

    // =========================================================================
    // DERIVED DATA — Cross-referenced lookups
    // =========================================================================

    /** Build master parent directory from roster + families */
    data.getParentDirectory = function() {
        var roster = data.getRoster();
        var families = data.getFamilies();
        var directory = []; // [{ parentName, parentEmail, parentPhone, children: [...], familyId, familyName }]
        var seen = {};

        // First pass: families
        Object.entries(families).forEach(function(entry) {
            var fid = entry[0], fam = entry[1];
            var parents = [];
            (fam.households || []).forEach(function(hh) {
                (hh.parents || []).forEach(function(p) {
                    if (p.name) parents.push(p);
                });
            });
            if (!parents.length) return;
            var children = (fam.camperIds || []).map(function(cid) {
                var c = roster[cid];
                return c ? { name: cid, division: c.division, grade: c.grade, bunk: c.bunk, camperId: c.camperId } : { name: cid };
            });
            var primary = parents[0];
            var key = (primary.email || primary.name || '').toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            directory.push({
                parentName: primary.name,
                parentEmail: primary.email || '',
                parentPhone: primary.phone || '',
                parent2Name: parents[1] ? parents[1].name : '',
                parent2Phone: parents[1] ? parents[1].phone : '',
                children: children,
                familyId: fid,
                familyName: fam.name || '',
                address: (fam.households && fam.households[0]) ? fam.households[0].address : ''
            });
        });

        // Second pass: group roster-only campers by parent email/name into implied families
        var impliedFamilies = {};
        Object.entries(roster).forEach(function(entry) {
            var name = entry[0], c = entry[1];
            if (!c.parent1Name) return;
            var key = (c.parent1Email || c.parent1Name || '').toLowerCase();
            if (seen[key]) return; // already captured by a proper family record
            if (!impliedFamilies[key]) {
                impliedFamilies[key] = {
                    parentName: c.parent1Name,
                    parentEmail: c.parent1Email || '',
                    parentPhone: c.parent1Phone || '',
                    parent2Name: '', parent2Phone: '',
                    children: [],
                    familyId: null,
                    familyName: (name.split(' ').pop() || '') + ' Family',
                    address: [c.street, c.city, c.state, c.zip].filter(Boolean).join(', ')
                };
            }
            impliedFamilies[key].children.push({ name: name, division: c.division, grade: c.grade, bunk: c.bunk, camperId: c.camperId });
        });
        Object.values(impliedFamilies).forEach(function(f) { directory.push(f); });

        return directory;
    };

    /** Get all campers with parent info attached */
    data.getCamperParentMap = function() {
        var roster = data.getRoster();
        var families = data.getFamilies();
        var map = {}; // { "CamperName": { ...camperData, parentName, parentEmail, parentPhone, familyId } }

        // Map from families
        Object.entries(families).forEach(function(entry) {
            var fid = entry[0], fam = entry[1];
            var p = fam.households && fam.households[0] && fam.households[0].parents && fam.households[0].parents[0];
            if (!p) return;
            (fam.camperIds || []).forEach(function(cid) {
                var c = roster[cid];
                if (!c) return;
                map[cid] = Object.assign({}, c, {
                    camperName: cid,
                    parentName: p.name,
                    parentEmail: p.email || '',
                    parentPhone: p.phone || '',
                    familyId: fid,
                    familyName: fam.name
                });
            });
        });

        // Fill in from roster for any not in families
        Object.entries(roster).forEach(function(entry) {
            var name = entry[0], c = entry[1];
            if (map[name]) return;
            map[name] = Object.assign({}, c, {
                camperName: name,
                parentName: c.parent1Name || '',
                parentEmail: c.parent1Email || '',
                parentPhone: c.parent1Phone || '',
                familyId: null,
                familyName: (name.split(' ').pop() || '') + ' Family'
            });
        });

        return map;
    };

    /**
     * Camper names that should NOT receive messages/forms: those whose
     * enrollment is withdrawn/declined with no active (accepted/enrolled)
     * enrollment. Campers with no enrollment record at all are treated as
     * active (manually-added roster campers).
     */
    data.getInactiveCamperNames = function() {
        var enr = (data.getMe().enrollments) || {};
        var seen = {}, active = {};
        Object.keys(enr).forEach(function(k) {
            var e = enr[k]; if (!e || !e.camperName) return;
            seen[e.camperName] = 1;
            if (e.status === 'accepted' || e.status === 'enrolled') active[e.camperName] = 1;
        });
        var inactive = {};
        Object.keys(seen).forEach(function(n) { if (!active[n]) inactive[n] = 1; });
        return inactive;
    };

    /**
     * SMART LOOKUP: Get bus stop info for a specific camper
     * Returns { busName, busColor, stopNum, stopAddress, estimatedTime, shiftLabel } or null
     */
    data.getCamperBusStop = function(camperName) {
        var routes = data.getBusRoutes();
        if (!routes) return null;

        // Routes can be an array of shift results
        var allShifts = Array.isArray(routes) ? routes : [routes];
        
        for (var si = 0; si < allShifts.length; si++) {
            var shift = allShifts[si];
            var shiftRoutes = shift.routes || shift;
            if (!Array.isArray(shiftRoutes)) continue;
            
            for (var ri = 0; ri < shiftRoutes.length; ri++) {
                var route = shiftRoutes[ri];
                var stops = route.stops || [];
                for (var sti = 0; sti < stops.length; sti++) {
                    var stop = stops[sti];
                    var campers = stop.campers || [];
                    for (var ci = 0; ci < campers.length; ci++) {
                        if (campers[ci].name === camperName || campers[ci] === camperName) {
                            return {
                                busName: route.busName || route.bus || 'Bus ' + (ri + 1),
                                busColor: route.busColor || '#3b82f6',
                                stopNum: stop.stopNum || (sti + 1),
                                stopAddress: stop.address || '',
                                estimatedTime: stop.estimatedTime || '',
                                shiftLabel: shift.shift ? shift.shift.label : '',
                                lat: stop.lat,
                                lng: stop.lng
                            };
                        }
                    }
                }
            }
        }
        return null;
    };

    /**
     * BULK: Get bus stops for ALL campers
     * Returns { "CamperName": { busName, stopNum, stopAddress, estimatedTime, ... } }
     */
    data.getAllCamperBusStops = function() {
        var roster = data.getRoster();
        var result = {};
        Object.keys(roster).forEach(function(name) {
            var stop = data.getCamperBusStop(name);
            if (stop) result[name] = stop;
        });
        return result;
    };

    // =========================================================================
    // RECIPIENT RESOLVERS — For mass messaging
    // =========================================================================

    /** Get parent contacts for ALL campers */
    data.getAllParentContacts = function() {
        return data.getParentDirectory();
    };

    /** Get parent contacts for a specific division */
    data.getParentsByDivision = function(divisionName) {
        var dir = data.getParentDirectory();
        return dir.filter(function(p) {
            return p.children.some(function(c) { return c.division === divisionName; });
        });
    };

    /** Get parent contacts for a specific grade */
    data.getParentsByGrade = function(gradeName) {
        var dir = data.getParentDirectory();
        return dir.filter(function(p) {
            return p.children.some(function(c) { return c.grade === gradeName; });
        });
    };

    /** Get parent contacts for a specific bunk */
    data.getParentsByBunk = function(bunkName) {
        var dir = data.getParentDirectory();
        return dir.filter(function(p) {
            return p.children.some(function(c) { return c.bunk === bunkName; });
        });
    };

    /** Get parent contacts for a specific family */
    data.getParentsByFamily = function(familyId) {
        var dir = data.getParentDirectory();
        return dir.filter(function(p) { return p.familyId === familyId; });
    };

    /** Get parent contact for a specific camper */
    data.getParentByCamper = function(camperName) {
        var map = data.getCamperParentMap();
        return map[camperName] || null;
    };

    // =========================================================================
    // MESSAGE CRUD
    // =========================================================================
    var msg = {};

    msg.getAll = function() { return _store.messages; };
    msg.getInbox = function() { return _store.messages.filter(function(m) { return m.direction === 'in'; }); };
    msg.getSent = function() { return _store.messages.filter(function(m) { return m.direction === 'out'; }); };
    msg.getUnread = function() { return _store.messages.filter(function(m) { return m.direction === 'in' && !m.read; }); };
    msg.getBroadcasts = function() { return _store.broadcasts; };

    msg.send = function(opts) {
        var m = {
            // Must be a real UUID, not the 'msg_...' style id used elsewhere —
            // this gets inserted straight into link_messages.id (uuid column)
            // by _insertMessageRow. A non-UUID string here made every single
            // cloud insert silently fail with a Postgres type error, while the
            // local echo (and the "message sent!" toast) succeeded regardless.
            id: (typeof crypto!=='undefined'&&crypto.randomUUID) ? crypto.randomUUID() : 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            direction: 'out',
            from: opts.from || 'Camp Admin',
            to: opts.to || '',
            toType: opts.toType || 'individual', // individual | family | group
            subject: opts.subject || '',
            body: opts.body || '',
            channels: opts.channels || ['app'],
            date: new Date().toISOString(),
            read: false,
            replied: false,
            threadId: opts.threadId || null,
            metadata: opts.metadata || {}
        };
        _store.messages.push(m);
        saveStore();
        _insertMessageRow(m);
        return m;
    };

    msg.broadcast = function(opts) {
        var b = {
            id: 'bc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            subject: opts.subject || '',
            body: opts.body || '',
            channels: opts.channels || ['app'],
            recipientFilter: opts.recipientFilter || {},
            recipientCount: opts.recipientCount || 0,
            date: new Date().toISOString(),
            readRate: 0,
            metadata: opts.metadata || {}
        };
        _store.broadcasts.push(b);
        // Persist to Supabase link_broadcasts (non-blocking)
        _insertBroadcastRow(b);
        saveStore();
        return b;
    };

    msg.markRead = function(msgId) {
        var m = _store.messages.find(function(x) { return x.id === msgId; });
        if (m) { m.read = true; saveStore(); }
    };

    /** Admin delete — real hard delete, removes the row for both parties. */
    msg.deleteMessage = function(msgId) {
        _store.messages = _store.messages.filter(function(m) { return m.id !== msgId; });
        saveStore();
        _deleteMessageRow(msgId);
    };

    msg.setArchived = function(msgId, archived) {
        var m = _store.messages.find(function(x) { return x.id === msgId; });
        if (m) { m.archived = !!archived; saveStore(); }
        _updateMessageFlag(msgId, 'archived', archived);
    };

    msg.setImportant = function(msgId, important) {
        var m = _store.messages.find(function(x) { return x.id === msgId; });
        if (m) { m.important = !!important; saveStore(); }
        _updateMessageFlag(msgId, 'important', important);
    };

    msg.reply = function(threadId, body, channels) {
        return msg.send({
            to: 'parent', // resolved from thread
            subject: 'RE: ' + (_store.messages.find(function(m) { return m.id === threadId; }) || {}).subject,
            body: body,
            channels: channels || ['app'],
            threadId: threadId
        });
    };

    msg.saveDraft = function(draft) {
        draft.id = draft.id || 'draft_' + Date.now();
        draft.savedAt = new Date().toISOString();
        var idx = _store.drafts.findIndex(function(d) { return d.id === draft.id; });
        if (idx >= 0) _store.drafts[idx] = draft;
        else _store.drafts.push(draft);
        saveStore();
        return draft;
    };

    msg.getDrafts = function() { return _store.drafts; };

    msg.deleteDraft = function(draftId) {
        _store.drafts = _store.drafts.filter(function(d) { return d.id !== draftId; });
        saveStore();
    };

    // =========================================================================
    // SMART NOTIFICATION ENGINE
    // =========================================================================
    var notify = {};

    /**
     * Generate bus stop notifications for ALL parents
     * Each parent gets a personalized message with THEIR child's specific stop info.
     * 
     * Returns array of { camperName, parentName, parentEmail, parentPhone, subject, body, busInfo }
     */
    notify.generateBusStopNotifications = function(opts) {
        opts = opts || {};
        var customSubject = opts.subject || 'Bus Stop Information for {camperFirstName}';
        var customBody = opts.body || 
            'Dear {parentName},\n\n' +
            'Here is the bus information for {camperName}:\n\n' +
            'Bus: {busName}\n' +
            'Stop #{stopNum}: {stopAddress}\n' +
            'Estimated Time: {estimatedTime}\n' +
            '{shiftInfo}\n\n' +
            'Please have your child at the stop 5 minutes before the scheduled time.\n\n' +
            'Best regards,\n{campName}';

        var camperMap = data.getCamperParentMap();
        var busStops = data.getAllCamperBusStops();
        var campName = data.getCampName();
        var notifications = [];

        Object.entries(camperMap).forEach(function(entry) {
            var camperName = entry[0], info = entry[1];
            if (!info.parentEmail && !info.parentPhone && !info.parentName) return;

            var busInfo = busStops[camperName];
            if (!busInfo) return;

            var subject = _resolveTemplate(customSubject, camperName, info, busInfo, campName);
            var body = _resolveTemplate(customBody, camperName, info, busInfo, campName);

            notifications.push({
                camperName: camperName, camperId: info.camperId || null,
                parentName: info.parentName,
                parentEmail: info.parentEmail, parentPhone: info.parentPhone,
                familyId: info.familyId, subject: subject, body: body, busInfo: busInfo,
                templateType: 'bus_stop'
            });
        });

        return notifications;
    };

    /**
     * Generate bunk & counselor assignment notifications
     */
    notify.generateBunkAssignmentNotifications = function(opts) {
        opts = opts || {};
        var subject = opts.subject || '{camperFirstName}\'s Bunk Assignment';
        var body = opts.body ||
            'Dear {parentName},\n\n' +
            'We\'re excited to share {camperFirstName}\'s camp assignment!\n\n' +
            'Division: {division}\n' +
            'Grade Group: {grade}\n' +
            'Bunk: {bunk}\n\n' +
            'We can\'t wait for a great summer!\n\n' +
            'Best regards,\n{campName}';

        var camperMap = data.getCamperParentMap();
        var campName = data.getCampName();
        var notifications = [];

        Object.entries(camperMap).forEach(function(entry) {
            var name = entry[0], info = entry[1];
            if (!info.parentName && !info.parentEmail) return;
            if (!info.division && !info.bunk) return; // skip unassigned
            notifications.push({
                camperName: name, camperId: info.camperId || null,
                parentName: info.parentName,
                parentEmail: info.parentEmail, parentPhone: info.parentPhone,
                familyId: info.familyId,
                subject: _resolveTemplate(subject, name, info, null, campName),
                body: _resolveTemplate(body, name, info, null, campName),
                templateType: 'bunk_assignment'
            });
        });
        return notifications;
    };

    /**
     * Generate daily schedule notifications
     * Reads from campDailyData_v1 — works for both manual builder (manualSkeleton)
     * and auto builder (scheduleAssignments with _startMin/_endMin or divisionTimes).
     */
    notify.generateScheduleNotifications = function(opts) {
        opts = opts || {};
        var subject = opts.subject || '{camperFirstName}\'s Schedule for Today';

        var camperMap = data.getCamperParentMap();
        var campName = data.getCampName();
        var notifications = [];

        var dateKey = opts.date || new Date().toISOString().split('T')[0];
        var dailyRaw = null;
        try { dailyRaw = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}'); } catch(e) {}
        var dayData = (dailyRaw && dailyRaw[dateKey]) ? dailyRaw[dateKey] : null;

        var assignments = (dayData && dayData.scheduleAssignments) ? dayData.scheduleAssignments : {};
        var skeleton    = (dayData && dayData.manualSkeleton)     ? dayData.manualSkeleton     : [];
        var divTimes    = (dayData && dayData.divisionTimes)       ? dayData.divisionTimes       : {};

        function fmtMin(min) {
            if (min == null) return '';
            var h = Math.floor(min / 60), m = min % 60;
            var ap = h < 12 ? 'AM' : 'PM';
            h = h % 12 || 12;
            return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
        }

        Object.entries(camperMap).forEach(function(entry) {
            var name = entry[0], info = entry[1];
            if (!info.parentName && !info.parentEmail) return;
            var bunk = info.bunk;
            if (!bunk) return;

            var bunkSchedule = assignments[bunk];
            if (!bunkSchedule || !Array.isArray(bunkSchedule) || !bunkSchedule.length) return;

            // Grade/division slots from divisionTimes (auto builder) or skeleton (manual)
            var grade = info.grade || info.division;
            var gradeSlots = null;
            var dtEntry = divTimes[grade] || divTimes[info.division] || divTimes[info.grade];
            if (dtEntry && dtEntry.slots) gradeSlots = dtEntry.slots;

            var schedLines = [];
            bunkSchedule.forEach(function(a, i) {
                if (!a) return;
                var activity = '';
                if (typeof a === 'string')         activity = a;
                else if (a._activity)              activity = a._activity;
                else if (a.field)                  activity = a.field;
                else if (a.sport)                  activity = a.sport;
                else if (a.event)                  activity = a.event;
                if (!activity || activity === 'Free') return;

                // Time: prefer _startMin (auto builder), then gradeSlots, then skeleton
                var time = '';
                if (a._startMin != null) {
                    time = fmtMin(a._startMin);
                } else if (gradeSlots && gradeSlots[i]) {
                    time = fmtMin(gradeSlots[i].startMin) || gradeSlots[i].startTime || '';
                } else {
                    var divSkel = skeleton.filter(function(s) { return s.division === grade; });
                    var sk = divSkel[i];
                    time = sk ? (sk.startTime || '') : '';
                }
                schedLines.push((time ? time + ' — ' : '') + activity);
            });

            // Pinned skeleton events (manual builder only)
            if (!gradeSlots) {
                skeleton.forEach(function(sk) {
                    if ((sk.division === info.grade || sk.division === info.division) && sk.type === 'pinned') {
                        schedLines.push((sk.startTime || '') + ' — ' + (sk.event || sk.type));
                    }
                });
            }

            if (!schedLines.length) schedLines.push('Schedule not yet generated for today.');
            var scheduleText = schedLines.join('\n');

            var bodyTemplate = opts.body ||
                'Dear {parentName},\n\n' +
                'Here is {camperFirstName}\'s schedule for today:\n\n' +
                '{scheduleText}\n\n' +
                'Have a great day!\n{campName}';

            notifications.push({
                camperName: name, camperId: info.camperId || null,
                parentName: info.parentName,
                parentEmail: info.parentEmail, parentPhone: info.parentPhone,
                familyId: info.familyId,
                subject: _resolveTemplate(subject, name, info, null, campName),
                body: _resolveTemplate(bodyTemplate, name, info, null, campName).replace(/{scheduleText}/g, scheduleText),
                scheduleLines: schedLines,
                templateType: 'daily_schedule'
            });
        });
        return notifications;
    };

    /**
     * Generate canteen balance alert notifications
     * Sends to parents whose children have low balances
     */
    notify.generateCanteenAlerts = function(opts) {
        opts = opts || {};
        var threshold = opts.threshold || 5; // alert when below $5
        var subject = opts.subject || 'Low Canteen Balance for {camperFirstName}';
        var body = opts.body ||
            'Dear {parentName},\n\n' +
            '{camperFirstName}\'s canteen account balance is getting low.\n\n' +
            'Current Balance: ${balance}\n\n' +
            'You can add funds through the Campistry Link parent portal at any time.\n\n' +
            'Best regards,\n{campName}';

        var camperMap = data.getCamperParentMap();
        var campName = data.getGoState().setup?.campName || 'Camp';
        var notifications = [];

        // Try reading Snacks data
        var snacksRaw = null;
        try { snacksRaw = JSON.parse(localStorage.getItem('campistry_snacks_v1') || '{}'); } catch(e) {}
        var accounts = (snacksRaw && snacksRaw.accounts) ? snacksRaw.accounts : {};

        Object.entries(camperMap).forEach(function(entry) {
            var name = entry[0], info = entry[1];
            if (!info.parentName && !info.parentEmail) return;
            
            // Find canteen balance for this camper
            var balance = null;
            Object.values(accounts).forEach(function(acct) {
                if (acct.camperName === name || acct.name === name) {
                    balance = acct.balance;
                }
            });
            
            if (balance === null || balance >= threshold) return; // skip if above threshold or not found

            var resolvedBody = _resolveTemplate(body, name, info, null, campName)
                .replace(/{balance}/g, balance.toFixed(2));

            notifications.push({
                camperName: name, parentName: info.parentName,
                parentEmail: info.parentEmail, parentPhone: info.parentPhone,
                familyId: info.familyId,
                subject: _resolveTemplate(subject, name, info, null, campName),
                body: resolvedBody,
                balance: balance,
                templateType: 'canteen_alert'
            });
        });
        return notifications;
    };

    /** Internal template resolver */
    function _resolveTemplate(template, camperName, info, busInfo, campName) {
        var firstName = camperName.split(' ')[0];
        var parentFirst = (info.parentName || '').split(' ')[0];
        var result = template
            .replace(/{camperName}/g, camperName)
            .replace(/{camperFirstName}/g, firstName)
            .replace(/{parentName}/g, info.parentName || 'Parent')
            .replace(/{parentFirstName}/g, parentFirst)
            .replace(/{division}/g, info.division || '')
            .replace(/{grade}/g, info.grade || '')
            .replace(/{bunk}/g, info.bunk || '')
            .replace(/{campName}/g, campName || 'Camp');
        
        if (busInfo) {
            result = result
                .replace(/{busName}/g, busInfo.busName || '')
                .replace(/{busColor}/g, busInfo.busColor || '')
                .replace(/{stopNum}/g, busInfo.stopNum || '')
                .replace(/{stopAddress}/g, busInfo.stopAddress || '')
                .replace(/{estimatedTime}/g, busInfo.estimatedTime || 'TBD')
                .replace(/{shiftInfo}/g, busInfo.shiftLabel ? 'Shift: ' + busInfo.shiftLabel : '');
        }
        return result;
    }

    /**
     * Send any batch of notifications through the delivery pipeline.
     * Persists to link_outbox (cloud) and localStorage mirror.
     */
    notify.sendBatch = function(notifications, channels, templateType) {
        channels = channels || ['app'];
        if (!notifications.length) {
            return { success: false, error: 'No notifications to send.', sent: 0 };
        }
        var now = new Date().toISOString();
        var records = [];
        notifications.forEach(function(n) {
            var record = {
                id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                camperName: n.camperName, camperId: n.camperId || null,
                parentName: n.parentName,
                parentEmail: n.parentEmail, parentPhone: n.parentPhone,
                type: n.templateType || templateType || 'custom',
                subject: n.subject, body: n.body,
                channels: channels, date: now, status: 'queued'
            };
            _store.notifications.push(record);
            _dispatchMessage(record, channels);
            records.push(record);
        });

        // Persist to Supabase link_outbox (non-blocking)
        _insertOutboxRows(records);

        msg.broadcast({
            subject: (templateType || 'Custom') + ' Notifications',
            body: 'Personalized ' + (templateType || '') + ' sent to ' + records.length + ' parents',
            channels: channels,
            recipientFilter: { type: templateType || 'custom' },
            recipientCount: records.length,
            metadata: { type: templateType || 'custom' }
        });
        saveStore();
        return { success: true, sent: records.length, notifications: notifications };
    };

    /**
     * CONVENIENCE: One-click send bus stop notifications
     */
    notify.sendBusStopNotifications = function(channels, opts) {
        var notifications = notify.generateBusStopNotifications(opts);
        return notify.sendBatch(notifications, channels, 'bus_stop');
    };

    /**
     * CONVENIENCE: One-click send bunk assignments
     */
    notify.sendBunkAssignments = function(channels, opts) {
        var notifications = notify.generateBunkAssignmentNotifications(opts);
        return notify.sendBatch(notifications, channels, 'bunk_assignment');
    };

    /**
     * CONVENIENCE: One-click send daily schedules
     */
    notify.sendDailySchedules = function(channels, opts) {
        var notifications = notify.generateScheduleNotifications(opts);
        return notify.sendBatch(notifications, channels, 'daily_schedule');
    };

    /**
     * CONVENIENCE: One-click send canteen alerts
     */
    notify.sendCanteenAlerts = function(channels, opts) {
        var notifications = notify.generateCanteenAlerts(opts);
        return notify.sendBatch(notifications, channels, 'canteen_alert');
    };

    // =========================================================================
    // DELIVERY DISPATCHER
    // =========================================================================
    var send = {};

    function _dispatchMessage(record, channels) {
        channels.forEach(function(ch) {
            if (ch === 'app') {
                // In-app: already stored in _store.notifications
                record.status = 'sent';
            }
            else if (ch === 'email') {
                _sendEmail(record);
            }
            else if (ch === 'sms') {
                _sendSMS(record);
            }
        });
    }

    function _sendEmail(record) {
        var provider = _store.settings.emailProvider;
        if (provider === 'none' || !_store.settings.emailApiKey) {
            console.log('[Link] Email dispatch — no provider configured. Would send to:', record.parentEmail);
            record.emailStatus = 'no_provider';
            // Emit event so UI can show the email content for manual send
            window.dispatchEvent(new CustomEvent('campistry-link-email-ready', { detail: record }));
            return;
        }

        // Integration point for SendGrid / Mailgun / SMTP
        // In production, this would POST to your backend API
        console.log('[Link] Email → ' + record.parentEmail + ': ' + record.subject);
        record.emailStatus = 'queued';

        // Placeholder: actual API call would go here
        // fetch('/api/send-email', { method: 'POST', body: JSON.stringify({ to: record.parentEmail, subject: record.subject, body: record.body, provider: provider }) })
        
        window.dispatchEvent(new CustomEvent('campistry-link-email-sent', { detail: record }));
    }

    function _sendSMS(record) {
        var provider = _store.settings.smsProvider;
        if (provider === 'none' || !_store.settings.smsApiKey) {
            console.log('[Link] SMS dispatch — no provider configured. Would send to:', record.parentPhone);
            record.smsStatus = 'no_provider';
            window.dispatchEvent(new CustomEvent('campistry-link-sms-ready', { detail: record }));
            return;
        }

        console.log('[Link] SMS → ' + record.parentPhone + ': ' + record.subject);
        record.smsStatus = 'queued';
        window.dispatchEvent(new CustomEvent('campistry-link-sms-sent', { detail: record }));
    }

    /** Get email-ready export (for copy/paste into external email tool) */
    send.getEmailExport = function(notifications) {
        return notifications.map(function(n) {
            return {
                to: n.parentEmail,
                subject: n.subject,
                body: n.body,
                camper: n.camperName
            };
        }).filter(function(n) { return n.to; });
    };

    /** Export as CSV for mass email import (Mailchimp, Constant Contact, etc.) */
    send.exportAsCSV = function(notifications) {
        var headers = ['Parent Email', 'Parent Name', 'Parent Phone', 'Camper Name', 'Subject', 'Message Body'];
        var rows = [headers.join(',')];
        notifications.forEach(function(n) {
            rows.push([
                '"' + (n.parentEmail || '') + '"',
                '"' + (n.parentName || '') + '"',
                '"' + (n.parentPhone || '') + '"',
                '"' + (n.camperName || '') + '"',
                '"' + (n.subject || '').replace(/"/g, '""') + '"',
                '"' + (n.body || '').replace(/"/g, '""').replace(/\n/g, ' ') + '"'
            ].join(','));
        });
        return rows.join('\n');
    };

    /** Trigger CSV download */
    send.downloadCSV = function(notifications, filename) {
        var csv = send.exportAsCSV(notifications);
        var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || 'campistry_link_notifications.csv';
        a.click();
        URL.revokeObjectURL(url);
    };

    // =========================================================================
    // SETTINGS
    // =========================================================================
    var settings = {};
    
    settings.get = function() { return _store.settings; };
    
    settings.update = function(key, value) {
        _store.settings[key] = value;
        saveStore();
    };

    settings.updateAll = function(newSettings) {
        Object.assign(_store.settings, newSettings);
        saveStore();
    };

    // =========================================================================
    // STATS
    // =========================================================================
    var stats = {};

    stats.getOverview = function() {
        var dir = data.getParentDirectory();
        var roster = data.getRoster();
        var structure = data.getStructure();
        var busRoutes = data.getBusRoutes();

        return {
            totalParents: dir.length,
            totalCampers: Object.keys(roster).length,
            totalFamilies: Object.keys(data.getFamilies()).length,
            totalDivisions: Object.keys(structure).length,
            totalMessages: _store.messages.length,
            unreadMessages: _store.messages.filter(function(m) { return m.direction === 'in' && !m.read; }).length,
            totalBroadcasts: _store.broadcasts.length,
            totalNotifications: _store.notifications.length,
            hasBusRoutes: !!busRoutes,
            busRouteCount: busRoutes ? (Array.isArray(busRoutes) ? busRoutes.length : 1) : 0
        };
    };

    // =========================================================================
    // INIT & PUBLIC API
    // =========================================================================
    loadStore();

    // Hydrate cloud history once CampistryDB is ready.
    // If it's already ready, call immediately; otherwise wait for the event.
    (function() {
        function tryLoadCloud() {
            if (_db()) {
                loadCloudHistory(100);
                loadCloudMessages(200);
            } else {
                // CampistryDB fires campistry-db-ready once campId is resolved
                window.addEventListener('campistry-db-ready', function onDbReady() {
                    window.removeEventListener('campistry-db-ready', onDbReady);
                    loadCloudHistory(100);
                    loadCloudMessages(200);
                }, { once: true });
            }
        }
        // Small delay so CampistryDB auth detection can complete first
        setTimeout(tryLoadCloud, 1500);
    })();

    // Debug: log what we actually found
    var _roster = data.getRoster();
    var _families = data.getFamilies();
    var _struct = data.getStructure();
    console.log('[Link] Data Bridge ready.');
    console.log('[Link]   Roster:', Object.keys(_roster).length, 'campers (from app1.camperRoster)');
    console.log('[Link]   Families:', Object.keys(_families).length, '(from campistryMe.families)');
    console.log('[Link]   Structure:', Object.keys(_struct).length, 'divisions (from campStructure)');
    console.log('[Link]   Parents:', data.getParentDirectory().length, '(derived)');
    if (!Object.keys(_roster).length) {
        console.warn('[Link]   ⚠ No roster data found. Make sure Campistry Me has been loaded at least once.');
        console.log('[Link]   Checked keys:', ['campGlobalSettings_v1', 'CAMPISTRY_LOCAL_CACHE', 'CAMPISTRY_UNIFIED_STATE'].join(', '));
    }

    window.CampistryLink = {
        data: data,
        msg: msg,
        notify: notify,
        send: send,
        settings: settings,
        stats: stats,

        // Convenience
        getStore: function() { return _store; },
        refresh: function() { loadStore(); },
        save: saveStore,
        loadCloudHistory: loadCloudHistory,
        loadCloudMessages: loadCloudMessages
    };

    console.log('[Link] Data Bridge ready. Parents:', data.getParentDirectory().length, '| Campers:', Object.keys(data.getRoster()).length);

})();
