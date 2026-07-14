// =============================================================================
// campistry_link_photos.js — Photo Recognition & Distribution Engine v2.0
//
// ARCHITECTURE:
//   1. FACE INDEX: cloud descriptors (parents opt in + upload up to 3 pose-
//      diverse reference photos per child) → per-camper mean templates
//      (AWS Rekognition "user vector" prior art), per model
//   2. BATCH SCAN: staff upload camp photos → tiled (SAHI-style) detection at
//      full working resolution via CampistryFace → quality gate → one-to-one
//      assignment (a camper appears at most once per photo, a face gets at
//      most one name) → strong matches auto-tag, gray-zone matches queue for
//      human review and are INVISIBLE to parents until approved
//   3. REVIEW: staff approve/reject queued suggestions; approvals feed the
//      confirmed descriptor back into the camper's gallery (capped), so
//      recognition improves as the summer progresses
//   4. DISTRIBUTION: admin sends "Photo Roundup" → each parent gets only the
//      photos their child was confirmed in, personalized via Link messaging
//
// DEPENDENCIES:
//   - face_match_core.js    (FaceMatchCore — pure matching math, unit-tested)
//   - campistry_face_shared.js (CampistryFace — models + tiled detection)
//   - campistry_link_data.js (data bridge for roster + parent lookup)
//   - campistry_face_engine_v2.js (optional — adds 512-D arc embeddings)
//
// DATA STORE:
//   campistry_link_photos_v1 → { photos: [...], faceIndex: {...}, settings: {...} }
// =============================================================================
(function() {
    'use strict';
    console.log('[LinkPhotos] Photo Recognition Engine v2.0 loading...');

    const PHOTO_STORE = 'campistry_link_photos_v1';

    // =========================================================================
    // STATE
    // =========================================================================
    // Owner-facing confidence dials operate on the FaceMatchCore confidence
    // scale (1.0 perfect · 0.5 edge of the engine's auto zone · 0 edge of
    // consideration). Review-band suggestions at/above acceptPct auto-accept;
    // below rejectPct they're silently dropped; the middle goes to the human
    // queue. Self-tuning (learn log of human decisions) moves these dials.
    const SETTINGS_DEFAULTS = {
        sendFrequency: 'weekly',    // 'daily' | 'twice_weekly' | 'weekly'
        sendDay: 'friday',          // day of week for weekly sends
        autoTag: true,              // auto-scan on upload
        maxPhotosPerEmail: 20,      // limit photos per parent email
        tiledDetection: true,       // SAHI-style tiling for large photos
        minFacePx: 48,              // quality gate: reject below this box size
        reviewQueue: true,          // keep a human queue for the unresolved middle band
        acceptPct: 0.35,            // auto-accept review-band suggestions at/above this confidence
        rejectPct: 0.08,            // auto-reject below this confidence
        selfTune: true,             // learn the dials from human review decisions
        burstClustering: true,      // propagate confirmed IDs across rapid photo sequences
        useWorker: true,            // scan in a background Web Worker when supported
        strictDivisions: [],        // youngest divisions: stricter auto-tagging (NIST: child false-match risk)
        strictDelta: 0.12,          // extra confidence required to auto-accept a strict camper
        staleDays: 300              // parent enrollment photos older than this = flag for re-enrollment
    };

    function _defaultStore() {
        return {
            photos: [],         // { id, dataUrl, uploadDate, tags: [...], pendingTags: [...], week, sent }
            faceIndex: {},      // { camperName: { descriptors: [{descriptor, model, pose, source}], updatedAt } }
            settings: Object.assign({}, SETTINGS_DEFAULTS),
            learn: [],          // human review decisions: {c: confidence, a: approved, m: model, t: ts} — ~50B each, capped
            learnMeta: { lastTuneN: 0, tunedAt: null },
            unknownClusters: [],// unresolved "who is this?" groups (capped at 12)
            staleCampers: [],   // campers whose enrollment photos predate this season
            faceIndexVersion: null, // cloud fingerprint the cached index was built from
            stats: {
                totalUploaded: 0,
                totalTagged: 0,
                totalSent: 0,
                totalPendingResolved: 0,
                autoAccepted: 0,
                autoRejected: 0,
                burstTagged: 0,
                lastScanDate: null,
                lastSendDate: null
            }
        };
    }
    let _store = _defaultStore();
    const LEARN_CAP = 500;   // plenty for calibration, negligible storage

    // ── per-camp store isolation ─────────────────────────────────────────────
    // Everything above is cached per CAMP (an owner managing several camps in
    // one browser must never see camp A's photos/queue/index inside camp B).
    // Cloud scoping was always correct (RPCs filter by camp_id + RLS); this
    // makes the LOCAL cache match. Legacy un-scoped data is left untouched.
    let _storeCampId;   // undefined = not yet resolved

    function _currentCampId() {
        try { return (window.CampistryDB && CampistryDB.getCampId && CampistryDB.getCampId()) || null; }
        catch(e) { return null; }
    }

    function _storeKey() {
        return _storeCampId ? (PHOTO_STORE + '::' + _storeCampId) : PHOTO_STORE;
    }

    // Called at the top of every public API entry: if the active camp changed
    // (login switch, multi-camp owner), swap to that camp's store and drop the
    // in-memory matcher so it rebuilds from the right camp's data.
    function _ensureStoreForCamp() {
        var cid = _currentCampId();
        if (cid === _storeCampId) return;
        _storeCampId = cid;
        _store = _defaultStore();
        loadStore();
        _indexBuilt = false;
        _camperTemplates = [];
    }

    let _modelsLoaded = false;
    let _indexBuilt = false;
    let _camperTemplates = [];  // [{ name, templates: {model: {mean, all}} }] — FaceMatchCore shape

    const Core = function() { return window.FaceMatchCore || null; };
    const Face = function() { return window.CampistryFace || null; };

    // Cloud access — the admin console authenticates as owner/staff via CampistryDB.
    function _db() {
        if (!window.CampistryDB) return null;
        try {
            var client = CampistryDB.getClient();
            var campId = CampistryDB.getCampId();
            if (!client || !campId) return null;
            return { client: client, campId: campId };
        } catch (e) { return null; }
    }

    // =========================================================================
    // PERSISTENCE
    // =========================================================================
    function loadStore() {
        try {
            var raw = localStorage.getItem(_storeKey());
            if (raw) {
                var parsed = JSON.parse(raw);
                _store = Object.assign({}, _store, parsed);
                _store.settings = Object.assign({}, SETTINGS_DEFAULTS, parsed.settings || {});
                _store.learn = Array.isArray(parsed.learn) ? parsed.learn : [];
                _store.learnMeta = Object.assign({ lastTuneN: 0, tunedAt: null }, parsed.learnMeta || {});
                _store.unknownClusters = Array.isArray(parsed.unknownClusters) ? parsed.unknownClusters : [];
                _store.staleCampers = Array.isArray(parsed.staleCampers) ? parsed.staleCampers : [];
                _store.faceIndexVersion = parsed.faceIndexVersion || null;
                _store.stats = Object.assign({
                    totalUploaded: 0, totalTagged: 0, totalSent: 0, totalPendingResolved: 0,
                    autoAccepted: 0, autoRejected: 0, burstTagged: 0,
                    lastScanDate: null, lastSendDate: null
                }, parsed.stats || {});
                _store.photos.forEach(function(p) {
                    if (!p.pendingTags) p.pendingTags = [];
                    if (!p.manualTags) p.manualTags = [];
                });
            }
        } catch(e) { console.warn('[LinkPhotos] Store load error:', e); }
    }

    function saveStore() {
        try {
            localStorage.setItem(_storeKey(), JSON.stringify(_store));
        } catch(e) {
            console.warn('[LinkPhotos] Store save error (likely size):', e);
            // Photos can be large — if we exceed quota, keep metadata but drop oldest photo data
            _trimPhotoStorage();
        }
    }

    function _trimPhotoStorage() {
        // Remove oldest photo dataUrls but keep metadata+tags
        var sorted = _store.photos.slice().sort(function(a,b) { return new Date(a.uploadDate) - new Date(b.uploadDate); });
        var trimmed = 0;
        while (sorted.length > 0) {
            var oldest = sorted.shift();
            var idx = _store.photos.findIndex(function(p) { return p.id === oldest.id; });
            if (idx >= 0 && _store.photos[idx].dataUrl) {
                _store.photos[idx].dataUrl = null; // keep tags, remove image data
                _store.photos[idx].trimmed = true;
                trimmed++;
            }
            try {
                localStorage.setItem(_storeKey(), JSON.stringify(_store));
                console.log('[LinkPhotos] Trimmed ' + trimmed + ' old photos to fit storage');
                return;
            } catch(e) { continue; }
        }
    }

    // =========================================================================
    // MODEL LOADING — delegated to the shared engine
    // =========================================================================
    async function loadModels() {
        if (_modelsLoaded) return true;
        var face = Face();
        if (!face) { console.error('[LinkPhotos] campistry_face_shared.js not loaded'); return false; }
        try {
            await face.ensureModels();
            _modelsLoaded = true;
            console.log('[LinkPhotos] ✅ Face models loaded');
            // kick off the optional modern engine in the background — scanning
            // works without it and picks it up when ready
            if (window.CampistryFaceEngineV2 && window.CampistryFaceEngineV2.init) {
                window.CampistryFaceEngineV2.init().catch(function(e) {
                    console.log('[LinkPhotos] arc-512 engine unavailable (fallback to faceapi-128):', e && e.message);
                });
            }
            return true;
        } catch(e) {
            console.error('[LinkPhotos] Model load error:', e);
            return false;
        }
    }

    // =========================================================================
    // FACE INDEX — cloud descriptors → per-camper multi-model templates
    // =========================================================================

    // Cheap cloud fingerprint of the enrollment state (migration 031).
    // Same fingerprint as when the cached index was built → provably fresh.
    async function _getCloudIndexVersion() {
        var db = _db();
        if (!db) return null;
        try {
            var res = await db.client.rpc('get_face_index_version', { p_camp_id: db.campId });
            if (res && res.data && res.data.success) return res.data.version || null;
        } catch(e) { /* RPC missing (pre-031) or offline — treat as unknown */ }
        return null;
    }

    /**
     * Make sure the matcher is built AND matches the cloud, rebuilding ONLY
     * when enrollment actually changed (new camper, new/updated photos,
     * revoked consent, promoted descriptors from another device). Called
     * automatically before every batch scan and at page load — staff never
     * need to run "Build Index" by hand anymore.
     */
    async function ensureFreshIndex(progressCallback) {
        if (!_indexBuilt) restoreIndexFromStore();

        var v = await _getCloudIndexVersion();
        if (v && _indexBuilt && _store.faceIndexVersion === v) {
            return { fresh: true, indexed: _camperTemplates.length, rebuilt: false };
        }
        if (!v && _indexBuilt) {
            // offline or pre-031 backend: cached index is the best we have
            return { fresh: false, indexed: _camperTemplates.length, rebuilt: false, offline: true };
        }
        var r = await buildFaceIndex(progressCallback);
        if (r && r.indexed > 0 && v) {
            _store.faceIndexVersion = v;
            saveStore();
        }
        r.rebuilt = true;
        return r;
    }

    // Build the matcher from the CLOUD face index: descriptors that parents
    // computed in-browser for their consented children (migrations 028/029).
    // Each camper may have several descriptors (front/left/right poses +
    // staff-confirmed matches) across one or more models. We build a mean
    // template per model plus keep the individuals (FaceMatchCore.matchDistance
    // takes the best of both).
    async function buildFaceIndex(progressCallback) {
        var core = Core();
        if (!core) return { indexed: 0, skipped: 0, errors: 0, error: 'face_match_core.js not loaded' };
        // templates are pure math — models load in the background for scanning
        loadModels();

        var db = _db();
        if (!db) {
            return { indexed: 0, skipped: 0, errors: 0, error: 'Not signed in — cannot reach the camp face index.' };
        }

        if (progressCallback) progressCallback({ current: 0, total: 0, name: 'Fetching consented faces…', phase: 'indexing' });

        var faces = [];
        try {
            var res = await db.client.rpc('get_camp_face_index', { p_camp_id: db.campId });
            if (res.error) throw res.error;
            if (!res.data || !res.data.success) throw new Error((res.data && res.data.error) || 'index_fetch_failed');
            faces = res.data.faces || [];
        } catch (e) {
            console.warn('[LinkPhotos] Cloud face index error:', e.message || e);
            return { indexed: 0, skipped: 0, errors: 0, error: 'Could not load face index: ' + (e.message || e) };
        }

        if (!faces.length) {
            return { indexed: 0, skipped: 0, errors: 0, total: 0,
                     error: 'No consented reference faces yet. Parents opt in and upload photos of each child in the Link parent app.' };
        }

        console.log('[LinkPhotos] Building matcher from ' + faces.length + ' campers...');
        var indexed = 0, skipped = 0, errors = 0;
        _camperTemplates = [];
        _store.faceIndex = {};
        _store.staleCampers = [];
        var staleCutoff = Date.now() - (_store.settings.staleDays || 300) * 86400000;

        // young/strict campers: divisions the owner flagged (NIST FRVT pt.3 —
        // elevated child-child false matches, worst in the youngest)
        var roster = {};
        try { roster = (window.CampistryLink && CampistryLink.data.getRoster) ? (CampistryLink.data.getRoster() || {}) : {}; } catch(e) {}
        var strictDivs = _store.settings.strictDivisions || [];

        // siblings: enrolled kids from the same family are each other's most
        // confusable impostors (shared genetics + same photos). When 2+ kids
        // of one family are enrolled, all of them get the strict treatment
        // automatically — sibling-grade matches go to review, not auto-tag.
        var siblingSet = _siblingEnrolledSet(faces.map(function(f) { return f.camper_name; }));

        for (var i = 0; i < faces.length; i++) {
            var name = faces[i].camper_name;
            // v2 shape: descriptors: [{descriptor, model, pose, source, created_at?}]
            // legacy shape (pre-029 RPC): descriptor: [128 floats]
            var descList = faces[i].descriptors;
            if (!Array.isArray(descList) && Array.isArray(faces[i].descriptor)) {
                descList = [{ descriptor: faces[i].descriptor, model: 'faceapi-128', pose: 'front', source: 'parent' }];
            }
            if (progressCallback) progressCallback({ current: i + 1, total: faces.length, name: name, phase: 'indexing' });

            try {
                // enrollment freshness: a parent descriptor from a past season is
                // excluded when a fresh one of the same model exists; a camper
                // with ONLY stale parent photos still matches but gets flagged.
                var parentRows = descList.filter(function(d) { return d && d.source !== 'confirmed'; });
                var hasFresh = {};
                parentRows.forEach(function(d) {
                    if (d.created_at && new Date(d.created_at).getTime() >= staleCutoff) hasFresh[d.model || 'faceapi-128'] = true;
                });
                var allParentStale = parentRows.length > 0 && parentRows.every(function(d) {
                    return d.created_at && new Date(d.created_at).getTime() < staleCutoff;
                });
                if (allParentStale) _store.staleCampers.push(name);

                var byModel = {};
                (descList || []).forEach(function(d) {
                    if (!d || !Array.isArray(d.descriptor)) return;
                    var model = d.model || 'faceapi-128';
                    var prof = core.MODEL_PROFILES[model];
                    if (!prof || d.descriptor.length !== prof.dims) return;
                    var isStaleParent = d.source !== 'confirmed' && d.created_at &&
                        new Date(d.created_at).getTime() < staleCutoff;
                    if (isStaleParent && hasFresh[model]) return;   // fresh replaces stale
                    (byModel[model] = byModel[model] || []).push(d.descriptor);
                });
                var templates = {};
                Object.keys(byModel).forEach(function(model) {
                    // pruning: dedupe + outlier ejection (NIST: weak fusion raises FPIR)
                    var tpl = core.buildTemplate(byModel[model], { metric: core.MODEL_PROFILES[model].metric });
                    if (tpl) templates[model] = tpl;
                });
                if (Object.keys(templates).length) {
                    var entry = { name: name, templates: templates };
                    var div = roster[name] && roster[name].division;
                    if (div && strictDivs.indexOf(div) >= 0) entry.strict = true;
                    if (siblingSet[name]) { entry.strict = true; entry.sibling = true; }
                    _camperTemplates.push(entry);
                    _store.faceIndex[name] = { descriptors: descList, updatedAt: new Date().toISOString() };
                    indexed++;
                } else {
                    skipped++;
                }
            } catch(e) {
                console.warn('[LinkPhotos] Descriptor error for:', name, e.message);
                errors++;
            }
        }

        _indexBuilt = indexed > 0;
        saveStore();
        // stamp the fingerprint this index was built from (fire-and-forget —
        // a manual rebuild should also silence future freshness checks)
        _getCloudIndexVersion().then(function(v) {
            if (v) { _store.faceIndexVersion = v; saveStore(); }
        }).catch(function() {});

        console.log('[LinkPhotos] ✅ Matcher built:', indexed, 'campers,', skipped, 'skipped,', errors, 'errors,',
                    _store.staleCampers.length, 'need fresh enrollment');
        return { indexed: indexed, skipped: skipped, errors: errors, total: faces.length,
                 staleCampers: _store.staleCampers.slice() };
    }

    // Family lookup: given the enrolled camper names, return {name: true} for
    // every camper who has an enrolled sibling (same family in the roster —
    // grouped by shared parent contact). Fail-open to empty on any data issue.
    function _siblingEnrolledSet(enrolledNames) {
        var out = {};
        try {
            if (!window.CampistryLink || !CampistryLink.data.getCamperParentMap) return out;
            var map = CampistryLink.data.getCamperParentMap() || {};
            var byFamily = {};
            enrolledNames.forEach(function(name) {
                var info = map[name];
                if (!info) return;
                var key = info.familyId || info.parentEmail || info.parentPhone;
                if (!key) return;
                (byFamily[key] = byFamily[key] || []).push(name);
            });
            Object.keys(byFamily).forEach(function(k) {
                if (byFamily[k].length >= 2) byFamily[k].forEach(function(n) { out[n] = true; });
            });
        } catch(e) {}
        return out;
    }

    /**
     * Rebuild index from persisted descriptors (fast, no cloud round trip)
     */
    function restoreIndexFromStore() {
        var core = Core();
        if (!core) return false;
        var entries = Object.entries(_store.faceIndex);
        if (!entries.length) return false;

        var roster = {};
        try { roster = (window.CampistryLink && CampistryLink.data.getRoster) ? (CampistryLink.data.getRoster() || {}) : {}; } catch(err) {}
        var strictDivs = _store.settings.strictDivisions || [];
        var siblingSet = _siblingEnrolledSet(entries.map(function(e) { return e[0]; }));

        _camperTemplates = [];
        entries.forEach(function(e) {
            var name = e[0], data = e[1];
            var descList = data.descriptors
                || (data.descriptor ? [{ descriptor: data.descriptor, model: 'faceapi-128' }] : []);
            var byModel = {};
            descList.forEach(function(d) {
                if (!d || !Array.isArray(d.descriptor)) return;
                (byModel[d.model || 'faceapi-128'] = byModel[d.model || 'faceapi-128'] || []).push(d.descriptor);
            });
            var templates = {};
            Object.keys(byModel).forEach(function(model) {
                var prof = core.MODEL_PROFILES[model];
                var tpl = core.buildTemplate(byModel[model], prof ? { metric: prof.metric } : undefined);
                if (tpl) templates[model] = tpl;
            });
            if (Object.keys(templates).length) {
                var entry = { name: name, templates: templates };
                var div = roster[name] && roster[name].division;
                if (div && strictDivs.indexOf(div) >= 0) entry.strict = true;
                if (siblingSet[name]) { entry.strict = true; entry.sibling = true; }
                _camperTemplates.push(entry);
            }
        });
        _indexBuilt = _camperTemplates.length > 0;
        console.log('[LinkPhotos] Restored ' + _camperTemplates.length + ' camper templates from store');
        return _indexBuilt;
    }

    // =========================================================================
    // SCAN WORKER — heavy ML off the main thread (UI stays responsive)
    // =========================================================================
    let _worker = null, _workerReady = null, _workerMsgId = 0;
    const _workerCallbacks = {};

    function _workerSupported() {
        return _store.settings.useWorker
            && typeof Worker !== 'undefined'
            && typeof OffscreenCanvas !== 'undefined'
            && typeof createImageBitmap !== 'undefined';
    }

    function _ensureWorker() {
        if (!_workerSupported()) return Promise.resolve(null);
        if (_workerReady) return _workerReady;
        _workerReady = new Promise(function(resolve) {
            try {
                var w = new Worker('campistry_face_worker.js');
                var settled = false;
                // first init downloads models — generous timeout, then inline fallback
                var timer = setTimeout(function() {
                    if (!settled) { settled = true; try { w.terminate(); } catch(e) {} resolve(null); }
                }, 90000);
                w.onmessage = function(ev) {
                    var msg = ev.data || {};
                    if (msg.type === 'ready') {
                        if (!settled) { settled = true; clearTimeout(timer); _worker = w; resolve(w); }
                        return;
                    }
                    if (msg.type === 'init_failed') {
                        console.warn('[LinkPhotos] scan worker init failed:', msg.error);
                        if (!settled) { settled = true; clearTimeout(timer); try { w.terminate(); } catch(e) {} resolve(null); }
                        return;
                    }
                    if (msg.id && _workerCallbacks[msg.id]) {
                        _workerCallbacks[msg.id](msg);
                        delete _workerCallbacks[msg.id];
                    }
                };
                w.onerror = function(e) {
                    console.warn('[LinkPhotos] scan worker error:', e && e.message);
                    if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
                };
                w.postMessage({ type: 'init', modelBase: window.CAMPISTRY_MODEL_BASE || undefined });
            } catch(e) { resolve(null); }
        });
        return _workerReady;
    }

    // Detect faces via the worker; null → caller falls back to inline.
    function _workerDetect(dataUrl, opts) {
        return _ensureWorker().then(function(w) {
            if (!w) return null;
            return new Promise(function(resolve) {
                var id = 'm' + (++_workerMsgId);
                var to = setTimeout(function() { delete _workerCallbacks[id]; resolve(null); }, 120000);
                _workerCallbacks[id] = function(msg) {
                    clearTimeout(to);
                    resolve(msg.ok ? msg.result : null);
                };
                w.postMessage({ type: 'scan', id: id, dataUrl: dataUrl, opts: opts });
            });
        });
    }

    // =========================================================================
    // PHOTO SCANNING — tiled detection + quality gate + 1:1 assignment +
    // owner auto-accept/auto-reject dials
    // =========================================================================

    function _scanOpts() {
        var o = { quality: { minFacePx: _store.settings.minFacePx } };
        if (!_store.settings.tiledDetection) o.tileThreshold = Infinity;
        return o;
    }

    // Match already-detected faces against the camper templates and route each
    // suggestion through the owner's dials. Returns the full routing picture;
    // `faces`/`routed` are kept in-memory only (burst pass), never persisted.
    function _matchDetected(faces) {
        var core = Core();
        var assignments = core.assignFaces(faces, _camperTemplates);
        var faceById = {};
        faces.forEach(function(f) { faceById[f.id] = f; });
        var strictByName = {};
        _camperTemplates.forEach(function(c) { if (c.strict) strictByName[c.name] = true; });

        var matches = [], pending = [], rejected = 0, routed = [];

        assignments.forEach(function(a) {
            var f = faceById[a.faceId];
            var prof = core.MODEL_PROFILES[a.model] || {};
            var confidence = Math.round(core.confidenceFor(a.dist, prof) * 100) / 100;
            var rec = {
                camperName: a.camperName,
                confidence: confidence,
                dist: a.dist,
                model: a.model,
                box: f ? f.box : null
            };
            if (a.status === 'auto') {
                matches.push(rec);
                routed.push({ faceId: a.faceId, camperName: a.camperName, status: 'auto' });
                return;
            }
            // review band → owner dials decide; strict (youngest) campers need
            // extra confidence to auto-accept — more of them reach a human
            var dials = {
                acceptPct: _store.settings.acceptPct + (strictByName[a.camperName] ? _store.settings.strictDelta : 0),
                rejectPct: _store.settings.rejectPct
            };
            var route = core.routeConfidence(confidence, dials);
            if (route === 'accept') {
                rec.autoAccepted = true;
                matches.push(rec);
                _store.stats.autoAccepted++;
                routed.push({ faceId: a.faceId, camperName: a.camperName, status: 'accept' });
            } else if (route === 'reject') {
                rejected++;
                _store.stats.autoRejected++;
            } else if (_store.settings.reviewQueue) {
                rec.faceThumb = f ? f.thumb : null;
                rec.descriptors = f ? f.descriptors : null;  // kept for promote-on-approve
                pending.push(rec);
                routed.push({ faceId: a.faceId, camperName: a.camperName, status: 'review' });
            }
        });

        return {
            matches: matches,
            pending: pending,
            rejected: rejected,
            facesFound: faces.length,
            facesRejected: faces.filter(function(f) { return f.tier === 'reject'; }).length,
            faces: faces,
            routed: routed
        };
    }

    /**
     * Scan a single photo and return matched campers.
     * @param {string} imageDataUrl - data URL of the photo (ORIGINAL resolution —
     *        do not pre-shrink; the pipeline manages its own working size)
     */
    async function scanPhoto(imageDataUrl) {
        if (!_indexBuilt || !_camperTemplates.length) {
            return { matches: [], pending: [], error: 'Face index not built. Run buildFaceIndex() first.' };
        }
        var core = Core(), face = Face();
        if (!core || !face) return { matches: [], pending: [], error: 'Face engine not loaded' };

        try {
            // worker first (keeps the UI thread free); inline fallback
            var det = await _workerDetect(imageDataUrl, _scanOpts());
            if (!det) {
                if (!await loadModels()) return { matches: [], pending: [], error: 'Models failed to load' };
                det = await face.detectFacesForMatching(imageDataUrl, _scanOpts());
            }
            var faces = det.faces || [];
            if (!faces.length) return { matches: [], pending: [], facesFound: 0, facesRejected: 0, faces: [], routed: [] };
            return _matchDetected(faces);
        } catch(e) {
            console.warn('[LinkPhotos] Scan error:', e.message);
            return { matches: [], pending: [], error: e.message };
        }
    }

    /**
     * Batch upload and scan multiple photos.
     * Scans at ORIGINAL resolution (tiled), stores a 1200px copy for display.
     * After scanning, burst clustering propagates confirmed identities across
     * photos shot seconds apart (in-memory only — descriptors are discarded
     * after routing except for pending review tags).
     */
    async function batchUploadAndScan(files, progressCallback) {
        // auto-sync the matcher with the cloud (rebuild ONLY if enrollment
        // changed since the cached index was built — otherwise instant)
        if (progressCallback) progressCallback({ current: 0, total: files.length, name: 'Checking recognition index…', phase: 'indexing' });
        await ensureFreshIndex(progressCallback);
        if (!_indexBuilt) {
            return { processed: 0, tagged: 0, untagged: 0, errors: 0,
                     error: 'No recognition index — no consented reference faces yet.' };
        }
        var core = Core();
        var weekKey = _getWeekKey();
        var processed = 0, tagged = 0, untagged = 0, needsReview = 0, errors = 0, burstExtra = 0;

        // ── phase 1: scan every photo ────────────────────────────────────────
        var scanned = [];
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!file.type.startsWith('image/')) { errors++; continue; }
            if (progressCallback) {
                progressCallback({ current: i + 1, total: files.length, name: file.name, phase: 'scanning' });
            }
            try {
                var originalDataUrl = await _fileToDataUrl(file);
                var result = await scanPhoto(originalDataUrl);
                var displayUrl = await _resizeImage(originalDataUrl, 1200);
                scanned.push({
                    idx: scanned.length,
                    fileName: file.name,
                    capturedAt: file.lastModified || null,   // camera files carry capture time here
                    displayUrl: displayUrl,
                    result: result
                });
            } catch(e) {
                console.warn('[LinkPhotos] Error processing file:', file.name, e.message);
                errors++;
            }
        }

        // ── phase 2: burst propagation across rapid sequences ────────────────
        if (_store.settings.burstClustering && scanned.length > 1) {
            try {
                var clusters = core.burstClusters(
                    scanned.map(function(s) { return { id: s.idx, capturedAt: s.capturedAt }; }));
                clusters.forEach(function(cluster) {
                    var photos = cluster.map(function(idx) {
                        var s = scanned[idx];
                        return { photoId: idx, faces: s.result.faces || [], assignments: s.result.routed || [] };
                    });
                    var extras = core.propagateBurstMatches(photos);
                    extras.forEach(function(x) {
                        var s = scanned[x.photoId];
                        var xf = (s.result.faces || []).find(function(f) { return f.id === x.faceId; });
                        if (x.via === 'torso') {
                            // same clothing, face inconclusive → human suggestion only
                            // (camp uniforms make clothing ambiguous between kids)
                            if (s.result.pending.some(function(p) { return p.camperName === x.camperName; })) return;
                            s.result.pending.push({
                                camperName: x.camperName,
                                confidence: x.torsoSim != null ? Math.round(x.torsoSim * 0.4 * 100) / 100 : 0.2,
                                model: null, via: 'torso',
                                faceThumb: xf ? xf.thumb : null,
                                descriptors: xf ? xf.descriptors : null
                            });
                            return;
                        }
                        var prof = core.MODEL_PROFILES[x.model] || {};
                        s.result.matches.push({
                            camperName: x.camperName,
                            confidence: Math.round(core.confidenceFor(x.dist, prof) * 100) / 100,
                            dist: x.dist, model: x.model,
                            autoAccepted: true, via: 'burst'
                        });
                        // a burst tag outranks a pending suggestion for the same camper
                        s.result.pending = s.result.pending.filter(function(p) { return p.camperName !== x.camperName; });
                        burstExtra++;
                        _store.stats.burstTagged++;
                    });
                });
            } catch(e) { console.warn('[LinkPhotos] burst propagation skipped:', e.message); }
        }

        // ── phase 2.5: collect unmatched faces for unknown-person clustering ─
        // (Apple's second-pass idea, batch-scoped: the same untagged kid in 6
        // photos becomes ONE "who is this?" review item instead of 6 misses)
        var unknownFaces = [];
        scanned.forEach(function(s) {
            var routedIds = {};
            (s.result.routed || []).forEach(function(r) { routedIds[r.faceId] = true; });
            (s.result.faces || []).forEach(function(f) {
                if (routedIds[f.id] || f.tier === 'reject') return;
                unknownFaces.push({ id: s.idx + ':' + f.id, photoId: s.idx, descriptors: f.descriptors, tier: f.tier, thumb: f.thumb });
            });
        });

        // ── phase 3: persist (descriptors dropped except pending tags) ───────
        var db = _db();
        var recordByIdx = {};
        for (var j = 0; j < scanned.length; j++) {
            var s = scanned[j];
            if (progressCallback) {
                progressCallback({ current: j + 1, total: scanned.length, name: s.fileName, phase: 'saving' });
            }
            var photoRecord = {
                id: 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                dataUrl: s.displayUrl,
                fileName: s.fileName,
                uploadDate: new Date().toISOString(),
                capturedAt: s.capturedAt,
                week: weekKey,
                tags: s.result.matches || [],
                pendingTags: s.result.pending || [],
                facesFound: s.result.facesFound || 0,
                facesRejected: s.result.facesRejected || 0,
                sent: false,
                manualTags: []
            };

            // Persist to cloud so parents see their child's photos. Pending
            // tags are stored with pending=true — parents can't see them until
            // staff approve (RPC filters them out). The RPC also only keeps
            // tags for consented campers (second line of defence).
            if (db) {
                try {
                    var cloudTags = photoRecord.tags.map(function(t) {
                        return { camper_name: t.camperName, confidence: t.confidence, manual: false, pending: false };
                    }).concat(photoRecord.pendingTags.map(function(t) {
                        return { camper_name: t.camperName, confidence: t.confidence, manual: false, pending: true };
                    }));
                    var saveRes = await db.client.rpc('save_scanned_photo', {
                        p_camp_id: db.campId,
                        p_image_data: s.displayUrl,
                        p_file_name: s.fileName,
                        p_week: weekKey,
                        p_tags: cloudTags
                    });
                    if (saveRes && saveRes.data && saveRes.data.photo_id) {
                        photoRecord.cloudId = saveRes.data.photo_id;
                        photoRecord.synced = true;
                    }
                } catch (ce) {
                    console.warn('[LinkPhotos] Cloud save failed for', s.fileName, ce.message || ce);
                }
            }

            _store.photos.push(photoRecord);
            recordByIdx[s.idx] = photoRecord;
            _store.stats.totalUploaded++;
            if (photoRecord.tags.length > 0) { tagged++; _store.stats.totalTagged++; }
            else untagged++;
            if (photoRecord.pendingTags.length > 0) needsReview++;
            processed++;
            // release scan memory (faces/descriptors) as we go
            s.result.faces = null; s.result.routed = null;
        }

        // ── phase 4: unknown-person clusters → review items ──────────────────
        var unknownClusters = 0;
        if (unknownFaces.length >= 3) {
            try {
                var clusters = core.clusterUnmatched(unknownFaces, { minSize: 3 });
                clusters.slice(0, 8).forEach(function(c) {
                    var photoIds = [], cloudIds = [];
                    c.photoIds.forEach(function(idx) {
                        var rec = recordByIdx[idx];
                        if (rec && photoIds.indexOf(rec.id) < 0) {
                            photoIds.push(rec.id);
                            if (rec.cloudId) cloudIds.push(rec.cloudId);
                        }
                    });
                    if (!photoIds.length) return;
                    _store.unknownClusters.push({
                        id: 'uc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                        createdAt: new Date().toISOString(),
                        count: c.count, thumb: c.thumb, model: c.model,
                        meanDescriptor: c.meanDescriptor,
                        photoIds: photoIds, cloudIds: cloudIds
                    });
                    unknownClusters++;
                });
                // cap total stored clusters (each carries one descriptor + thumb)
                if (_store.unknownClusters.length > 12) {
                    _store.unknownClusters = _store.unknownClusters.slice(-12);
                }
            } catch(e) { console.warn('[LinkPhotos] unknown clustering skipped:', e.message); }
        }

        _store.stats.lastScanDate = new Date().toISOString();
        saveStore();

        return { processed: processed, tagged: tagged, untagged: untagged,
                 needsReview: needsReview, burstTagged: burstExtra,
                 unknownClusters: unknownClusters, errors: errors };
    }

    // =========================================================================
    // UNKNOWN-PERSON CLUSTERS — "seen N times, who is this?"
    // =========================================================================

    function getUnknownClusters() {
        return (_store.unknownClusters || []).map(function(c) {
            return { id: c.id, count: c.count, thumb: c.thumb, photoIds: c.photoIds.slice(), createdAt: c.createdAt };
        });
    }

    // Staff put a name to an unknown cluster: tags every photo in it (local +
    // cloud) and promotes the cluster centroid into the camper's gallery so
    // the kid stops being unknown next batch. Consent is enforced server-side
    // by promote_confirmed_face and the RLS on link_photo_tags.
    async function assignUnknownCluster(clusterId, camperName) {
        var idx = (_store.unknownClusters || []).findIndex(function(c) { return c.id === clusterId; });
        if (idx < 0) return { success: false, error: 'cluster_not_found' };
        var cluster = _store.unknownClusters[idx];
        var db = _db();

        cluster.photoIds.forEach(function(pid) { manualTag(pid, camperName); });

        if (db) {
            for (var i = 0; i < cluster.cloudIds.length; i++) {
                try {
                    await db.client.from('link_photo_tags').insert({
                        photo_id: cluster.cloudIds[i], camp_id: db.campId,
                        camper_name: camperName, confidence: null, manual: true, pending: false
                    });
                } catch(e) { /* duplicate or consent-filtered — fine */ }
            }
            if (cluster.meanDescriptor && cluster.model) {
                try {
                    await db.client.rpc('promote_confirmed_face', {
                        p_camp_id: db.campId, p_camper_name: camperName,
                        p_descriptor: cluster.meanDescriptor, p_model: cluster.model
                    });
                    var descs = {}; descs[cluster.model] = cluster.meanDescriptor;
                    _appendLocalDescriptors(camperName, descs);
                } catch(e) { console.warn('[LinkPhotos] cluster promote failed:', e.message || e); }
            }
        }

        _store.unknownClusters.splice(idx, 1);
        saveStore();
        return { success: true, tagged: cluster.photoIds.length };
    }

    function dismissUnknownCluster(clusterId) {
        var before = (_store.unknownClusters || []).length;
        _store.unknownClusters = (_store.unknownClusters || []).filter(function(c) { return c.id !== clusterId; });
        saveStore();
        return _store.unknownClusters.length < before;
    }

    // =========================================================================
    // REVIEW QUEUE — approve/reject gray-zone suggestions
    // =========================================================================

    /**
     * All pending suggestions across photos (newest first).
     * [{ photoId, photoThumb, camperName, confidence, faceThumb }]
     */
    function getPendingReview() {
        var out = [];
        _store.photos.forEach(function(p) {
            (p.pendingTags || []).forEach(function(t) {
                out.push({
                    photoId: p.id,
                    photoThumb: p.dataUrl,
                    uploadDate: p.uploadDate,
                    camperName: t.camperName,
                    confidence: t.confidence,
                    model: t.model,
                    faceThumb: t.faceThumb || null
                });
            });
        });
        return out.sort(function(a, b) { return new Date(b.uploadDate) - new Date(a.uploadDate); });
    }

    // Every HUMAN review decision is a labeled calibration sample (~50 bytes).
    // Once there's enough evidence, the owner dials retune themselves so the
    // auto-accept/auto-reject bands match this camp's real photo conditions.
    function _recordDecision(tag, approved) {
        if (typeof tag.confidence !== 'number') return;
        _store.learn.push({ c: tag.confidence, a: !!approved, m: tag.model || null, t: Date.now() });
        if (_store.learn.length > LEARN_CAP) _store.learn = _store.learn.slice(-LEARN_CAP);
        _maybeSelfTune();
    }

    function _maybeSelfTune() {
        if (!_store.settings.selfTune) return;
        var core = Core(); if (!core) return;
        var learn = _store.learn || [];
        if (learn.length < 30) return;                                  // need real evidence
        if (learn.length - (_store.learnMeta.lastTuneN || 0) < 10) return;  // retune every ~10 decisions
        var r = core.calibrateFromDecisions(learn.map(function(s) { return { conf: s.c, approved: s.a }; }));
        if (!r) return;
        if (r.acceptPct != null) _store.settings.acceptPct = Math.round(r.acceptPct * 100) / 100;
        if (r.rejectPct != null) _store.settings.rejectPct = Math.round(r.rejectPct * 100) / 100;
        _store.learnMeta.lastTuneN = learn.length;
        _store.learnMeta.tunedAt = new Date().toISOString();
        console.log('[LinkPhotos] self-tuned dials from ' + learn.length + ' decisions → accept ≥' +
            Math.round(_store.settings.acceptPct * 100) + '%, reject <' + Math.round(_store.settings.rejectPct * 100) + '%');
    }

    /**
     * Approve or reject a pending suggestion.
     * Approve: tag becomes real (parents see the photo) AND the confirmed
     * descriptor joins the camper's gallery so future matching improves.
     * Every decision also feeds the self-tuning calibration.
     */
    async function resolvePendingTag(photoId, camperName, approve) {
        var photo = _store.photos.find(function(p) { return p.id === photoId; });
        if (!photo) return { success: false, error: 'photo_not_found' };
        var idx = (photo.pendingTags || []).findIndex(function(t) { return t.camperName === camperName; });
        if (idx < 0) return { success: false, error: 'tag_not_pending' };
        var tag = photo.pendingTags[idx];
        photo.pendingTags.splice(idx, 1);
        _recordDecision(tag, approve);

        var db = _db();
        if (approve) {
            photo.tags.push({
                camperName: tag.camperName, confidence: tag.confidence,
                dist: tag.dist, model: tag.model, box: tag.box, confirmed: true
            });
            // grow the camper's descriptor gallery from the confirmed face
            // (every model we captured for that face), then refresh templates
            if (db && photo.cloudId) {
                try { await db.client.rpc('resolve_photo_tag', { p_photo_id: photo.cloudId, p_camper_name: camperName, p_approve: true }); }
                catch(e) { console.warn('[LinkPhotos] resolve_photo_tag failed:', e.message || e); }
            }
            if (db && tag.descriptors) {
                for (var model in tag.descriptors) {
                    if (!tag.descriptors[model]) continue;
                    try {
                        await db.client.rpc('promote_confirmed_face', {
                            p_camp_id: db.campId, p_camper_name: camperName,
                            p_descriptor: Array.from(tag.descriptors[model]), p_model: model
                        });
                    } catch(e) { console.warn('[LinkPhotos] promote_confirmed_face failed:', e.message || e); }
                }
                _appendLocalDescriptors(camperName, tag.descriptors);
            }
        } else if (db && photo.cloudId) {
            try { await db.client.rpc('resolve_photo_tag', { p_photo_id: photo.cloudId, p_camper_name: camperName, p_approve: false }); }
            catch(e) { console.warn('[LinkPhotos] resolve_photo_tag failed:', e.message || e); }
        }

        _store.stats.totalPendingResolved++;
        saveStore();
        return { success: true, approved: !!approve };
    }

    /**
     * Re-route the EXISTING review queue through the current dials — for when
     * the owner tightens/loosens the accept/reject percentages and wants the
     * backlog cleared without clicking through each one. Auto-accepted items
     * become real tags (cloud pending flag cleared) but do NOT feed the
     * descriptor gallery or the learn log — only human decisions teach.
     */
    async function applyDialsToQueue() {
        var core = Core(); if (!core) return { success: false, error: 'core_not_loaded' };
        var dials = { acceptPct: _store.settings.acceptPct, rejectPct: _store.settings.rejectPct };
        var accepted = 0, rejectedN = 0, remaining = 0;
        var db = _db();

        for (var pi = 0; pi < _store.photos.length; pi++) {
            var photo = _store.photos[pi];
            if (!(photo.pendingTags || []).length) continue;
            var keep = [];
            for (var ti = 0; ti < photo.pendingTags.length; ti++) {
                var tag = photo.pendingTags[ti];
                var route = core.routeConfidence(tag.confidence, dials);
                if (route === 'accept') {
                    photo.tags.push({
                        camperName: tag.camperName, confidence: tag.confidence,
                        dist: tag.dist, model: tag.model, box: tag.box, autoAccepted: true
                    });
                    accepted++; _store.stats.autoAccepted++;
                    if (db && photo.cloudId) {
                        try { await db.client.rpc('resolve_photo_tag', { p_photo_id: photo.cloudId, p_camper_name: tag.camperName, p_approve: true }); }
                        catch(e) { console.warn('[LinkPhotos] bulk resolve failed:', e.message || e); }
                    }
                } else if (route === 'reject') {
                    rejectedN++; _store.stats.autoRejected++;
                    if (db && photo.cloudId) {
                        try { await db.client.rpc('resolve_photo_tag', { p_photo_id: photo.cloudId, p_camper_name: tag.camperName, p_approve: false }); }
                        catch(e) { console.warn('[LinkPhotos] bulk resolve failed:', e.message || e); }
                    }
                } else {
                    keep.push(tag); remaining++;
                }
            }
            photo.pendingTags = keep;
        }
        saveStore();
        return { success: true, accepted: accepted, rejected: rejectedN, remaining: remaining };
    }

    // Owner-facing snapshot of the triage system for the settings UI.
    function getReviewStats() {
        var core = Core();
        var evalR = core ? core.evalReport(
            (_store.learn || []).map(function(s) { return { conf: s.c, approved: s.a }; }),
            { acceptPct: _store.settings.acceptPct, rejectPct: _store.settings.rejectPct }
        ) : { n: 0 };
        return {
            acceptPct: _store.settings.acceptPct,
            rejectPct: _store.settings.rejectPct,
            selfTune: _store.settings.selfTune,
            decisions: (_store.learn || []).length,
            tunedAt: _store.learnMeta ? _store.learnMeta.tunedAt : null,
            autoAccepted: _store.stats.autoAccepted,
            autoRejected: _store.stats.autoRejected,
            burstTagged: _store.stats.burstTagged,
            workerActive: !!_worker,
            eval: evalR,                                       // measured precision at current dials
            staleCampers: (_store.staleCampers || []).slice(), // need fresh enrollment photos
            unknownClusters: (_store.unknownClusters || []).length,
            strictDivisions: (_store.settings.strictDivisions || []).slice(),
            siblingStrict: _camperTemplates.filter(function(c) { return c.sibling; }).length
        };
    }

    // Keep the local matcher in sync with a promoted descriptor without a full
    // cloud rebuild.
    function _appendLocalDescriptors(camperName, descriptors) {
        var core = Core(); if (!core) return;
        var entry = _store.faceIndex[camperName];
        if (!entry) return;
        if (!entry.descriptors) entry.descriptors = [];
        for (var model in descriptors) {
            if (!descriptors[model]) continue;
            entry.descriptors.push({ descriptor: Array.from(descriptors[model]), model: model, pose: 'confirmed', source: 'confirmed' });
        }
        var camper = _camperTemplates.find(function(c) { return c.name === camperName; });
        if (camper) {
            var byModel = {};
            entry.descriptors.forEach(function(d) {
                if (!Array.isArray(d.descriptor)) return;
                (byModel[d.model || 'faceapi-128'] = byModel[d.model || 'faceapi-128'] || []).push(d.descriptor);
            });
            Object.keys(byModel).forEach(function(model) {
                var tpl = core.buildTemplate(byModel[model]);
                if (tpl) camper.templates[model] = tpl;
            });
        }
    }

    // =========================================================================
    // MANUAL TAGGING
    // =========================================================================

    /**
     * Manually tag a camper on a photo (for corrections / unrecognized faces)
     */
    function manualTag(photoId, camperName) {
        var photo = _store.photos.find(function(p) { return p.id === photoId; });
        if (!photo) return false;
        // Avoid duplicates
        if (photo.tags.some(function(t) { return t.camperName === camperName; })) return false;
        if (photo.manualTags.some(function(t) { return t.camperName === camperName; })) return false;
        photo.manualTags.push({ camperName: camperName, confidence: 1.0, manual: true });
        saveStore();
        return true;
    }

    /**
     * Remove a tag from a photo (false positive correction)
     */
    function removeTag(photoId, camperName) {
        var photo = _store.photos.find(function(p) { return p.id === photoId; });
        if (!photo) return false;
        photo.tags = photo.tags.filter(function(t) { return t.camperName !== camperName; });
        photo.manualTags = photo.manualTags.filter(function(t) { return t.camperName !== camperName; });
        photo.pendingTags = (photo.pendingTags || []).filter(function(t) { return t.camperName !== camperName; });
        saveStore();
        return true;
    }

    // =========================================================================
    // PHOTO DISTRIBUTION — Send roundups to parents (confirmed tags only)
    // =========================================================================

    /**
     * Get all photos for a specific camper (auto + manual tags; NOT pending)
     */
    function getPhotosForCamper(camperName, weekKey) {
        return _store.photos.filter(function(p) {
            if (weekKey && p.week !== weekKey) return false;
            var allTags = (p.tags || []).concat(p.manualTags || []);
            return allTags.some(function(t) { return t.camperName === camperName; });
        });
    }

    /**
     * Get photo distribution summary — how many photos per camper
     */
    function getDistributionSummary(weekKey) {
        weekKey = weekKey || _getWeekKey();
        var weekPhotos = _store.photos.filter(function(p) { return p.week === weekKey; });
        var summary = {};
        var pendingCount = 0;

        weekPhotos.forEach(function(p) {
            var allTags = (p.tags || []).concat(p.manualTags || []);
            allTags.forEach(function(t) {
                if (!summary[t.camperName]) summary[t.camperName] = { count: 0, sent: false };
                summary[t.camperName].count++;
                if (p.sent) summary[t.camperName].sent = true;
            });
            pendingCount += (p.pendingTags || []).length;
        });

        return {
            week: weekKey,
            totalPhotos: weekPhotos.length,
            taggedPhotos: weekPhotos.filter(function(p) { return (p.tags||[]).length + (p.manualTags||[]).length > 0; }).length,
            untaggedPhotos: weekPhotos.filter(function(p) { return (p.tags||[]).length + (p.manualTags||[]).length === 0; }).length,
            pendingReview: pendingCount,
            camperCounts: summary,
            uniqueCampers: Object.keys(summary).length
        };
    }

    /**
     * Generate photo roundup notifications for all parents
     * Each parent gets a personalized message with count + thumbnail of their child's photos
     */
    function generatePhotoRoundup(weekKey, opts) {
        opts = opts || {};
        weekKey = weekKey || _getWeekKey();

        var camperMap = window.CampistryLink ? CampistryLink.data.getCamperParentMap() : {};
        var campName = '';
        try { campName = JSON.parse(localStorage.getItem('campistry_go_data') || '{}').setup?.campName || 'Camp'; } catch(e) {}

        var subject = opts.subject || 'Camp Photos: {camperFirstName}\'s Week in Pictures!';
        var bodyTemplate = opts.body ||
            'Dear {parentName},\n\n' +
            'We have {photoCount} new photos of {camperFirstName} from this week at camp!\n\n' +
            'Log in to the Campistry Link parent portal to view and download all photos.\n\n' +
            'Have a wonderful {dayOfWeek}!\n' +
            '{campName}';

        var notifications = [];
        var dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];

        Object.entries(camperMap).forEach(function(entry) {
            var camperName = entry[0], info = entry[1];
            if (!info.parentName && !info.parentEmail) return;

            var photos = getPhotosForCamper(camperName, weekKey);
            if (!photos.length) return;

            var firstName = camperName.split(' ')[0];
            var parentFirst = (info.parentName || '').split(' ')[0];

            var resolvedSubject = subject
                .replace(/{camperName}/g, camperName)
                .replace(/{camperFirstName}/g, firstName)
                .replace(/{parentName}/g, info.parentName || 'Parent');

            var resolvedBody = bodyTemplate
                .replace(/{camperName}/g, camperName)
                .replace(/{camperFirstName}/g, firstName)
                .replace(/{parentName}/g, info.parentName || 'Parent')
                .replace(/{parentFirstName}/g, parentFirst)
                .replace(/{photoCount}/g, photos.length)
                .replace(/{dayOfWeek}/g, dayOfWeek)
                .replace(/{campName}/g, campName);

            notifications.push({
                camperName: camperName,
                parentName: info.parentName,
                parentEmail: info.parentEmail,
                parentPhone: info.parentPhone,
                familyId: info.familyId,
                subject: resolvedSubject,
                body: resolvedBody,
                photoCount: photos.length,
                photoIds: photos.map(function(p) { return p.id; }),
                templateType: 'photo_roundup'
            });
        });

        return notifications;
    }

    /**
     * Send photo roundup to all parents
     */
    function sendPhotoRoundup(channels, weekKey, opts) {
        channels = channels || ['app'];
        var notifications = generatePhotoRoundup(weekKey, opts);

        if (!notifications.length) {
            return { success: false, error: 'No tagged photos found for this week.', sent: 0 };
        }

        // Mark photos as sent
        var weekPhotos = _store.photos.filter(function(p) { return p.week === (weekKey || _getWeekKey()); });
        weekPhotos.forEach(function(p) { p.sent = true; });

        // Use Link's notification batch sender if available
        if (window.CampistryLink && CampistryLink.notify.sendBatch) {
            var result = CampistryLink.notify.sendBatch(notifications, channels, 'photo_roundup');
            _store.stats.totalSent += result.sent;
            _store.stats.lastSendDate = new Date().toISOString();
            saveStore();
            return result;
        }

        _store.stats.totalSent += notifications.length;
        _store.stats.lastSendDate = new Date().toISOString();
        saveStore();
        return { success: true, sent: notifications.length, notifications: notifications };
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function _fileToDataUrl(file) {
        return new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onload = function(e) { resolve(e.target.result); };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function _resizeImage(dataUrl, maxDim) {
        return new Promise(function(resolve) {
            var img = new Image();
            img.onload = function() {
                if (img.width <= maxDim && img.height <= maxDim) {
                    resolve(dataUrl);
                    return;
                }
                var scale = Math.min(maxDim / img.width, maxDim / img.height);
                var canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.src = dataUrl;
        });
    }

    function _getWeekKey() {
        var now = new Date();
        var startOfYear = new Date(now.getFullYear(), 0, 1);
        var weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
        return now.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    _storeCampId = _currentCampId();   // may be null pre-auth; re-checked per call
    loadStore();

    var _api = {
        // Core pipeline
        loadModels: loadModels,
        buildFaceIndex: buildFaceIndex,
        ensureFreshIndex: ensureFreshIndex,
        restoreIndex: restoreIndexFromStore,
        scanPhoto: scanPhoto,
        batchUploadAndScan: batchUploadAndScan,

        // Review queue + auto-triage
        getPendingReview: getPendingReview,
        resolvePendingTag: resolvePendingTag,
        applyDialsToQueue: applyDialsToQueue,
        getReviewStats: getReviewStats,

        // Unknown-person clusters
        getUnknownClusters: getUnknownClusters,
        assignUnknownCluster: assignUnknownCluster,
        dismissUnknownCluster: dismissUnknownCluster,

        // Tagging
        manualTag: manualTag,
        removeTag: removeTag,
        getPhotosForCamper: getPhotosForCamper,

        // Distribution
        getDistributionSummary: getDistributionSummary,
        generatePhotoRoundup: generatePhotoRoundup,
        sendPhotoRoundup: sendPhotoRoundup,

        // Settings & state
        getSettings: function() { return _store.settings; },
        updateSettings: function(s) { Object.assign(_store.settings, s); saveStore(); },
        getStats: function() { return _store.stats; },
        getPhotos: function(weekKey) {
            if (weekKey) return _store.photos.filter(function(p) { return p.week === weekKey; });
            return _store.photos;
        },
        getCurrentWeek: _getWeekKey,

        // Status
        isModelsLoaded: function() { return _modelsLoaded; },
        isIndexBuilt: function() { return _indexBuilt; },
        getIndexSize: function() { return _camperTemplates.length; },
        getStore: function() { return _store; }
    };

    // Every public call first snaps the local store to the ACTIVE camp — an
    // owner switching between camps in one browser gets fully isolated
    // caches (photos, review queue, learn log, index) per camp.
    window.CampistryPhotos = {};
    Object.keys(_api).forEach(function(k) {
        window.CampistryPhotos[k] = (typeof _api[k] === 'function')
            ? function() { _ensureStoreForCamp(); return _api[k].apply(null, arguments); }
            : _api[k];
    });

    console.log('[LinkPhotos] Photo engine v2 ready. Stored photos:', _store.photos.length, '| Face index:', Object.keys(_store.faceIndex).length);

})();
