// =============================================================================
// campistry_link_photos.js — Photo Recognition & Distribution Engine v1.0
//
// ARCHITECTURE:
//   1. FACE INDEX: Reads headshot photoUrl from Me roster → builds face
//      descriptor index using face-api.js (runs in-browser, no server)
//   2. BATCH SCAN: Staff upload camp photos → each photo scanned against
//      the face index → matched campers tagged on the photo record
//   3. DISTRIBUTION: Admin sends "Photo Roundup" → each parent gets only
//      the photos their child appears in, personalized via Link messaging
//
// DEPENDENCIES:
//   - face-api.js (loaded from CDN, ~6MB models)
//   - campistry_link_data.js (data bridge for roster + parent lookup)
//
// DATA STORE:
//   campistry_link_photos_v1 → { photos: [...], faceIndex: {...}, settings: {...} }
//
// face-api.js models used:
//   - tinyFaceDetector (fast face detection, ~190KB)
//   - faceLandmark68TinyNet (landmark points, ~80KB)  
//   - faceRecognitionNet (128-dim descriptor, ~6.2MB)
// =============================================================================
(function() {
    'use strict';
    console.log('[LinkPhotos] Photo Recognition Engine v1.0 loading...');

    const PHOTO_STORE = 'campistry_link_photos_v1';
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model';

    // =========================================================================
    // STATE
    // =========================================================================
    let _store = {
        photos: [],         // { id, dataUrl, uploadDate, uploadedBy, tags: [{camperName, confidence}], week, sent }
        faceIndex: {},      // { camperName: { descriptor: Float32Array serialized, updatedAt } }
        settings: {
            sendFrequency: 'weekly',    // 'daily' | 'twice_weekly' | 'weekly'
            sendDay: 'friday',          // day of week for weekly sends
            minConfidence: 0.5,         // minimum match confidence (0-1, lower = more permissive)
            autoTag: true,              // auto-scan on upload
            maxPhotosPerEmail: 20       // limit photos per parent email
        },
        stats: {
            totalUploaded: 0,
            totalTagged: 0,
            totalSent: 0,
            lastScanDate: null,
            lastSendDate: null
        }
    };

    let _modelsLoaded = false;
    let _indexBuilt = false;
    let _labeledDescriptors = []; // face-api.js LabeledFaceDescriptors array
    let _scanQueue = [];
    let _scanning = false;

    // =========================================================================
    // PERSISTENCE
    // =========================================================================
    function loadStore() {
        try {
            var raw = localStorage.getItem(PHOTO_STORE);
            if (raw) {
                var parsed = JSON.parse(raw);
                _store = Object.assign({}, _store, parsed);
                _store.settings = Object.assign({
                    sendFrequency: 'weekly', sendDay: 'friday',
                    minConfidence: 0.5, autoTag: true, maxPhotosPerEmail: 20
                }, parsed.settings || {});
                _store.stats = Object.assign({
                    totalUploaded: 0, totalTagged: 0, totalSent: 0,
                    lastScanDate: null, lastSendDate: null
                }, parsed.stats || {});
            }
        } catch(e) { console.warn('[LinkPhotos] Store load error:', e); }
    }

    function saveStore() {
        try {
            localStorage.setItem(PHOTO_STORE, JSON.stringify(_store));
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
                localStorage.setItem(PHOTO_STORE, JSON.stringify(_store));
                console.log('[LinkPhotos] Trimmed ' + trimmed + ' old photos to fit storage');
                return;
            } catch(e) { continue; }
        }
    }

    // =========================================================================
    // MODEL LOADING
    // =========================================================================

    /**
     * Load face-api.js models from CDN
     * Returns a promise that resolves when models are ready
     */
    async function loadModels() {
        if (_modelsLoaded) return true;

        // Check if face-api is available
        if (typeof faceapi === 'undefined') {
            console.log('[LinkPhotos] Loading face-api.js from CDN...');
            await _loadScript('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.min.js');
        }

        if (typeof faceapi === 'undefined') {
            console.error('[LinkPhotos] face-api.js failed to load');
            return false;
        }

        console.log('[LinkPhotos] Loading face detection models...');
        try {
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
                faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
                faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
            ]);
            _modelsLoaded = true;
            console.log('[LinkPhotos] ✅ All face models loaded');
            return true;
        } catch(e) {
            console.error('[LinkPhotos] Model load error:', e);
            return false;
        }
    }

    function _loadScript(src) {
        return new Promise(function(resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    // =========================================================================
    // FACE INDEX — Build from Me roster headshots
    // =========================================================================

    /**
     * Build face descriptor index from all campers who have photoUrl in roster
     * This is the "reference library" that camp photos are matched against.
     * 
     * Returns { indexed: number, skipped: number, errors: number }
     */
    async function buildFaceIndex(progressCallback) {
        if (!await loadModels()) {
            return { indexed: 0, skipped: 0, errors: 0, error: 'Models failed to load' };
        }

        var roster = {};
        if (window.CampistryLink) {
            roster = CampistryLink.data.getRoster();
        } else {
            try { roster = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}').campistryMe?.roster || {}; }
            catch(e) {}
        }

        var campers = Object.entries(roster).filter(function(e) { return e[1].photoUrl; });
        
        if (!campers.length) {
            return { indexed: 0, skipped: Object.keys(roster).length, errors: 0, error: 'No campers have headshot photos. Upload photos in Campistry Me first.' };
        }

        console.log('[LinkPhotos] Building face index from ' + campers.length + ' headshots...');
        var indexed = 0, skipped = 0, errors = 0;
        _labeledDescriptors = [];

        for (var i = 0; i < campers.length; i++) {
            var name = campers[i][0];
            var photoUrl = campers[i][1].photoUrl;

            if (progressCallback) {
                progressCallback({
                    current: i + 1,
                    total: campers.length,
                    name: name,
                    phase: 'indexing'
                });
            }

            try {
                var img = await _loadImage(photoUrl);
                var detection = await faceapi
                    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
                    .withFaceLandmarks(true)
                    .withFaceDescriptor();

                if (detection) {
                    _labeledDescriptors.push(
                        new faceapi.LabeledFaceDescriptors(name, [detection.descriptor])
                    );
                    // Store serialized descriptor for persistence
                    _store.faceIndex[name] = {
                        descriptor: Array.from(detection.descriptor),
                        updatedAt: new Date().toISOString()
                    };
                    indexed++;
                } else {
                    console.warn('[LinkPhotos] No face found in headshot for:', name);
                    skipped++;
                }
            } catch(e) {
                console.warn('[LinkPhotos] Error processing headshot for:', name, e.message);
                errors++;
            }
        }

        _indexBuilt = indexed > 0;
        saveStore();

        console.log('[LinkPhotos] ✅ Face index built:', indexed, 'indexed,', skipped, 'skipped,', errors, 'errors');
        return { indexed: indexed, skipped: skipped, errors: errors, total: campers.length };
    }

    /**
     * Rebuild index from persisted descriptors (fast, no image processing)
     */
    function restoreIndexFromStore() {
        if (!_modelsLoaded || typeof faceapi === 'undefined') return false;

        var entries = Object.entries(_store.faceIndex);
        if (!entries.length) return false;

        _labeledDescriptors = [];
        entries.forEach(function(e) {
            var name = e[0], data = e[1];
            if (data.descriptor) {
                var desc = new Float32Array(data.descriptor);
                _labeledDescriptors.push(
                    new faceapi.LabeledFaceDescriptors(name, [desc])
                );
            }
        });
        _indexBuilt = _labeledDescriptors.length > 0;
        console.log('[LinkPhotos] Restored ' + _labeledDescriptors.length + ' face descriptors from store');
        return _indexBuilt;
    }

    // =========================================================================
    // PHOTO SCANNING — Match camp photos against the face index
    // =========================================================================

    /**
     * Scan a single photo and return matched campers
     * @param {string} imageDataUrl - base64 data URL of the photo
     * @returns {Array} - [{ camperName, confidence, box: {x,y,width,height} }]
     */
    async function scanPhoto(imageDataUrl) {
        if (!_indexBuilt || !_labeledDescriptors.length) {
            return { matches: [], error: 'Face index not built. Run buildFaceIndex() first.' };
        }

        var matcher = new faceapi.FaceMatcher(_labeledDescriptors, 1 - _store.settings.minConfidence);

        try {
            var img = await _loadImage(imageDataUrl);
            var detections = await faceapi
                .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }))
                .withFaceLandmarks(true)
                .withFaceDescriptors();

            if (!detections.length) {
                return { matches: [], facesFound: 0 };
            }

            var matches = [];
            detections.forEach(function(det) {
                var bestMatch = matcher.findBestMatch(det.descriptor);
                if (bestMatch.label !== 'unknown') {
                    matches.push({
                        camperName: bestMatch.label,
                        confidence: Math.round((1 - bestMatch.distance) * 100) / 100,
                        box: {
                            x: Math.round(det.detection.box.x),
                            y: Math.round(det.detection.box.y),
                            width: Math.round(det.detection.box.width),
                            height: Math.round(det.detection.box.height)
                        }
                    });
                }
            });

            return { matches: matches, facesFound: detections.length };
        } catch(e) {
            console.warn('[LinkPhotos] Scan error:', e.message);
            return { matches: [], error: e.message };
        }
    }

    /**
     * Batch upload and scan multiple photos
     * @param {FileList|Array} files - image files to process
     * @param {Function} progressCallback - called with { current, total, name, phase }
     * @returns {Object} - { processed, tagged, untagged, errors }
     */
    async function batchUploadAndScan(files, progressCallback) {
        if (!_indexBuilt) {
            return { processed: 0, tagged: 0, untagged: 0, errors: 0, error: 'Build face index first' };
        }

        var processed = 0, tagged = 0, untagged = 0, errors = 0;
        var weekKey = _getWeekKey();

        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!file.type.startsWith('image/')) { errors++; continue; }

            if (progressCallback) {
                progressCallback({
                    current: i + 1,
                    total: files.length,
                    name: file.name,
                    phase: 'scanning'
                });
            }

            try {
                var dataUrl = await _fileToDataUrl(file);
                
                // Resize if too large (keep under 1200px for faster processing)
                dataUrl = await _resizeImage(dataUrl, 1200);

                var result = await scanPhoto(dataUrl);
                
                var photoRecord = {
                    id: 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                    dataUrl: dataUrl,
                    fileName: file.name,
                    uploadDate: new Date().toISOString(),
                    week: weekKey,
                    tags: result.matches || [],
                    facesFound: result.facesFound || 0,
                    sent: false,
                    manualTags: [] // for manual corrections
                };

                _store.photos.push(photoRecord);
                _store.stats.totalUploaded++;

                if (photoRecord.tags.length > 0) {
                    tagged++;
                    _store.stats.totalTagged++;
                } else {
                    untagged++;
                }
                processed++;

            } catch(e) {
                console.warn('[LinkPhotos] Error processing file:', file.name, e.message);
                errors++;
            }
        }

        _store.stats.lastScanDate = new Date().toISOString();
        saveStore();

        return { processed: processed, tagged: tagged, untagged: untagged, errors: errors };
    }

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
        saveStore();
        return true;
    }

    // =========================================================================
    // PHOTO DISTRIBUTION — Send roundups to parents
    // =========================================================================

    /**
     * Get all photos for a specific camper (auto + manual tags)
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

        weekPhotos.forEach(function(p) {
            var allTags = (p.tags || []).concat(p.manualTags || []);
            allTags.forEach(function(t) {
                if (!summary[t.camperName]) summary[t.camperName] = { count: 0, sent: false };
                summary[t.camperName].count++;
                if (p.sent) summary[t.camperName].sent = true;
            });
        });

        return {
            week: weekKey,
            totalPhotos: weekPhotos.length,
            taggedPhotos: weekPhotos.filter(function(p) { return (p.tags||[]).length + (p.manualTags||[]).length > 0; }).length,
            untaggedPhotos: weekPhotos.filter(function(p) { return (p.tags||[]).length + (p.manualTags||[]).length === 0; }).length,
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

    function _loadImage(src) {
        return new Promise(function(resolve, reject) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function() { resolve(img); };
            img.onerror = function() { reject(new Error('Image load failed')); };
            img.src = src;
        });
    }

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
    loadStore();

    window.CampistryPhotos = {
        // Core pipeline
        loadModels: loadModels,
        buildFaceIndex: buildFaceIndex,
        restoreIndex: restoreIndexFromStore,
        scanPhoto: scanPhoto,
        batchUploadAndScan: batchUploadAndScan,

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
        getIndexSize: function() { return _labeledDescriptors.length; },
        getStore: function() { return _store; }
    };

    console.log('[LinkPhotos] Photo engine ready. Stored photos:', _store.photos.length, '| Face index:', Object.keys(_store.faceIndex).length);

})();
