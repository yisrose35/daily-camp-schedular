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
            // Also sync to cloud if available
            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('campistryLink', _store);
            }
        } catch(e) { console.warn('[Link] Store save error:', e); }
    }

    // =========================================================================
    // DATA READERS — Pull live from Me + Go
    // =========================================================================
    var data = {};

    /** Get unified state from campGlobalSettings_v1 */
    data.getGlobalState = function() {
        try {
            return JSON.parse(localStorage.getItem(GLOBAL_STORE) || '{}');
        } catch(e) { return {}; }
    };

    /** Get Me sub-state */
    data.getMe = function() {
        var g = data.getGlobalState();
        return g.campistryMe || {};
    };

    /** Get camper roster: { "Full Name": { camperId, division, grade, bunk, parent1Name, parent1Email, ... } } */
    data.getRoster = function() {
        return data.getMe().roster || data.getMe().camperRoster || {};
    };

    /** Get families: { famId: { name, households, camperIds, ... } } */
    data.getFamilies = function() {
        return data.getMe().families || {};
    };

    /** Get camp structure: { "Juniors": { color, grades: { "1st Grade": { bunks: [...] } } } } */
    data.getStructure = function() {
        return data.getGlobalState().campStructure || data.getMe().structure || {};
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

    /** Get generated bus routes from Go */
    data.getBusRoutes = function() {
        var go = data.getGoState();
        return go.savedRoutes || go.dismissal || go.arrival || null;
    };

    /** Get Go addresses: { "Camper Name": { address, lat, lng } } */
    data.getGoAddresses = function() {
        return data.getGoState().addresses || {};
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

        // Second pass: roster entries not in any family
        Object.entries(roster).forEach(function(entry) {
            var name = entry[0], c = entry[1];
            if (!c.parent1Name) return;
            var key = (c.parent1Email || c.parent1Name || '').toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            directory.push({
                parentName: c.parent1Name,
                parentEmail: c.parent1Email || '',
                parentPhone: c.parent1Phone || '',
                parent2Name: '',
                parent2Phone: '',
                children: [{ name: name, division: c.division, grade: c.grade, bunk: c.bunk, camperId: c.camperId }],
                familyId: null,
                familyName: name.split(' ').pop() + ' Family',
                address: [c.street, c.city, c.state, c.zip].filter(Boolean).join(', ')
            });
        });

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
                familyName: ''
            });
        });

        return map;
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
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
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
        return m;
    };

    msg.broadcast = function(opts) {
        var b = {
            id: 'bc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            subject: opts.subject || '',
            body: opts.body || '',
            channels: opts.channels || ['app'],
            recipientFilter: opts.recipientFilter || {},  // { type: 'all' | 'division' | 'grade' | 'bunk' | 'family', values: [...] }
            recipientCount: opts.recipientCount || 0,
            date: new Date().toISOString(),
            readRate: 0,
            metadata: opts.metadata || {}
        };
        _store.broadcasts.push(b);
        saveStore();
        return b;
    };

    msg.markRead = function(msgId) {
        var m = _store.messages.find(function(x) { return x.id === msgId; });
        if (m) { m.read = true; saveStore(); }
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
        var campName = data.getGoState().setup?.campName || 'Camp';
        var notifications = [];

        Object.entries(camperMap).forEach(function(entry) {
            var camperName = entry[0], info = entry[1];
            if (!info.parentEmail && !info.parentPhone && !info.parentName) return;
            
            var busInfo = busStops[camperName];
            if (!busInfo) return;

            var subject = _resolveTemplate(customSubject, camperName, info, busInfo, campName);
            var body = _resolveTemplate(customBody, camperName, info, busInfo, campName);

            notifications.push({
                camperName: camperName, parentName: info.parentName,
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
        var campName = data.getGoState().setup?.campName || 'Camp';
        var notifications = [];

        Object.entries(camperMap).forEach(function(entry) {
            var name = entry[0], info = entry[1];
            if (!info.parentName && !info.parentEmail) return;
            if (!info.division && !info.bunk) return; // skip unassigned
            notifications.push({
                camperName: name, parentName: info.parentName,
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
     * Reads the current day's schedule from Flow's daily data
     */
    notify.generateScheduleNotifications = function(opts) {
        opts = opts || {};
        var subject = opts.subject || '{camperFirstName}\'s Schedule for Today';

        var camperMap = data.getCamperParentMap();
        var campName = data.getGoState().setup?.campName || 'Camp';
        var notifications = [];

        // Try to read schedule from daily data
        var dateKey = opts.date || new Date().toISOString().split('T')[0];
        var dailyRaw = null;
        try { dailyRaw = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}'); } catch(e) {}
        var dayData = dailyRaw && dailyRaw[dateKey] ? dailyRaw[dateKey] : null;

        // Read skeleton (the day's structure)
        var skeleton = [];
        if (dayData && dayData.manualSkeleton) skeleton = dayData.manualSkeleton;
        
        // Read assignments 
        var assignments = {};
        if (dayData && dayData.scheduleAssignments) assignments = dayData.scheduleAssignments;

        Object.entries(camperMap).forEach(function(entry) {
            var name = entry[0], info = entry[1];
            if (!info.parentName && !info.parentEmail) return;
            var bunk = info.bunk;
            if (!bunk) return;

            // Build schedule string for this bunk
            var schedLines = [];
            var bunkSchedule = assignments[bunk];
            if (bunkSchedule && Array.isArray(bunkSchedule)) {
                // Match skeleton slots to assignments
                var divSlots = skeleton.filter(function(s) { return s.division === info.grade || s.division === info.division; });
                bunkSchedule.forEach(function(assignment, i) {
                    var slot = divSlots[i];
                    var time = slot ? (slot.startTime || '') : '';
                    var activity = '';
                    if (typeof assignment === 'string') activity = assignment;
                    else if (assignment && assignment.field) activity = assignment.field;
                    else if (assignment && assignment.event) activity = assignment.event;
                    if (activity) schedLines.push(time + ' — ' + activity);
                });
            }

            // Also include pinned events from skeleton
            skeleton.forEach(function(sk) {
                if ((sk.division === info.grade || sk.division === info.division) && sk.type === 'pinned') {
                    schedLines.push((sk.startTime || '') + ' — ' + (sk.event || sk.type));
                }
            });

            if (!schedLines.length) schedLines.push('Schedule not yet generated for today.');

            var scheduleText = schedLines.join('\n');

            var bodyTemplate = opts.body ||
                'Dear {parentName},\n\n' +
                'Here is {camperFirstName}\'s schedule for today:\n\n' +
                '{scheduleText}\n\n' +
                'Have a great day!\n{campName}';

            var resolvedBody = _resolveTemplate(bodyTemplate, name, info, null, campName)
                .replace(/{scheduleText}/g, scheduleText);

            notifications.push({
                camperName: name, parentName: info.parentName,
                parentEmail: info.parentEmail, parentPhone: info.parentPhone,
                familyId: info.familyId,
                subject: _resolveTemplate(subject, name, info, null, campName),
                body: resolvedBody,
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
     * Send any batch of notifications through the delivery pipeline
     */
    notify.sendBatch = function(notifications, channels, templateType) {
        channels = channels || ['app'];
        if (!notifications.length) {
            return { success: false, error: 'No notifications to send.', sent: 0 };
        }
        var sent = 0;
        notifications.forEach(function(n) {
            var record = {
                id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                camperName: n.camperName, parentName: n.parentName,
                parentEmail: n.parentEmail, parentPhone: n.parentPhone,
                type: n.templateType || templateType || 'custom',
                subject: n.subject, body: n.body,
                channels: channels, date: new Date().toISOString(), status: 'queued'
            };
            _store.notifications.push(record);
            _dispatchMessage(record, channels);
            sent++;
        });
        msg.broadcast({
            subject: (templateType || 'Custom') + ' Notifications',
            body: 'Personalized ' + (templateType || '') + ' sent to ' + sent + ' parents',
            channels: channels,
            recipientFilter: { type: templateType || 'custom' },
            recipientCount: sent,
            metadata: { type: templateType || 'custom' }
        });
        saveStore();
        return { success: true, sent: sent, notifications: notifications };
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
        save: saveStore
    };

    console.log('[Link] Data Bridge ready. Parents:', data.getParentDirectory().length, '| Campers:', Object.keys(data.getRoster()).length);

})();
