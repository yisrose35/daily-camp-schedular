// campistry_scan_to_pdf.js — shared "Scan Document" capability.
//
// Lets a parent or staff member photograph one or more pages with their
// camera (or pick photos from their gallery) and turns them into a single
// real PDF file, client-side, via the already-vendored pdf-lib. The result
// is a plain File object (application/pdf) handed back through a callback —
// callers feed it into whatever upload path they already have (Print &
// Return, the Documents attachment list, etc.) exactly as if the user had
// picked a PDF from the file chooser. No server involvement, no new upload
// plumbing needed per caller.
//
// Usage:
//   CampistryScanToPdf.open({
//     title: 'Scan Health Form',              // optional
//     onDone: function(file){ ... },           // required — file.type === 'application/pdf'
//     onCancel: function(){ ... }              // optional
//   });
//
// Requires pdf-lib (window.PDFLib) to already be loaded on the page.
(function(){
'use strict';

var MAX_IMAGE_DIM = 1600;      // resized long edge, px — keeps a multi-page PDF small
var JPEG_QUALITY = 0.82;
var PAGE_LONG_EDGE_PT = 792;   // ~11in at 72dpi — standard printable page size

var _pages = [];   // [{dataUrl, width, height}]
var _els = null;   // cached DOM refs for the open overlay
var _opts = null;

function _esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function _resizeToDataUrl(file){
    return new Promise(function(resolve, reject){
        var reader = new FileReader();
        reader.onerror = function(){ reject(new Error('read_failed')); };
        reader.onload = function(){
            var img = new Image();
            img.onerror = function(){ reject(new Error('decode_failed')); };
            img.onload = function(){
                var scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
                var w = Math.max(1, Math.round(img.width * scale));
                var h = Math.max(1, Math.round(img.height * scale));
                var canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve({ dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: w, height: h });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function _dataUrlToBytes(dataUrl){
    var b64 = dataUrl.split(',')[1] || '';
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function _renderThumbs(){
    if (!_els) return;
    _els.thumbs.innerHTML = '';
    _pages.forEach(function(p, i){
        var cell = document.createElement('div');
        cell.style.cssText = 'position:relative;width:74px;height:96px;border-radius:6px;overflow:hidden;border:1px solid rgba(0,0,0,.15);flex-shrink:0;background:#fff;';
        var img = document.createElement('img');
        img.src = p.dataUrl;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        var badge = document.createElement('div');
        badge.textContent = String(i+1);
        badge.style.cssText = 'position:absolute;left:3px;top:3px;background:rgba(0,0,0,.55);color:#fff;font-size:.62rem;font-weight:700;padding:1px 5px;border-radius:8px;';
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '×';
        rm.setAttribute('aria-label', 'Remove page ' + (i+1));
        rm.style.cssText = 'position:absolute;right:2px;top:2px;width:18px;height:18px;line-height:16px;border-radius:50%;border:none;background:rgba(0,0,0,.6);color:#fff;font-size:.85rem;cursor:pointer;padding:0;';
        rm.onclick = function(){ _pages.splice(i,1); _renderThumbs(); };
        cell.appendChild(img); cell.appendChild(badge); cell.appendChild(rm);
        _els.thumbs.appendChild(cell);
    });
    var n = _pages.length;
    _els.count.textContent = n ? (n + ' page' + (n===1?'':'s') + ' captured') : 'No pages yet';
    _els.doneBtn.disabled = n === 0;
    _els.doneBtn.style.opacity = n === 0 ? '.5' : '1';
    _els.doneBtn.style.cursor = n === 0 ? 'default' : 'pointer';
    _els.doneBtn.textContent = n ? ('Done — ' + n + ' page' + (n===1?'':'s')) : 'Done';
}

function _addCapturedFile(file){
    if (!file) return;
    _resizeToDataUrl(file).then(function(res){
        _pages.push(res);
        _renderThumbs();
    }).catch(function(){
        _toast('Could not read that photo — try again');
    });
}

function _toast(msg){
    if (typeof window.toast === 'function') { window.toast(msg, 'error'); return; }
    // Minimal fallback toast so this works on any host page.
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1e293b;color:#fff;padding:9px 16px;border-radius:8px;font-size:.82rem;z-index:1000002;box-shadow:0 6px 20px rgba(0,0,0,.25);';
    document.body.appendChild(t);
    setTimeout(function(){ t.remove(); }, 2600);
}

function _buildPdf(){
    var PDFLib = window.PDFLib;
    if (!PDFLib) return Promise.reject(new Error('pdf_lib_missing'));
    var doc;
    return PDFLib.PDFDocument.create().then(function(d){
        doc = d;
        var chain = Promise.resolve();
        _pages.forEach(function(p){
            chain = chain.then(function(){
                var bytes = _dataUrlToBytes(p.dataUrl);
                return doc.embedJpg(bytes).then(function(jpg){
                    var longEdge = Math.max(p.width, p.height);
                    var scale = PAGE_LONG_EDGE_PT / longEdge;
                    var pw = p.width * scale, ph = p.height * scale;
                    var page = doc.addPage([pw, ph]);
                    page.drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
                });
            });
        });
        return chain;
    }).then(function(){
        return doc.save();
    });
}

function _finish(){
    if (!_pages.length) return;
    _els.doneBtn.disabled = true;
    _els.doneBtn.textContent = 'Building PDF…';
    _buildPdf().then(function(bytes){
        var blob = new Blob([bytes], { type: 'application/pdf' });
        var stamp = new Date().toISOString().slice(0,10);
        var name = 'Scan_' + stamp + '_' + Date.now() + '.pdf';
        var file = new File([blob], name, { type: 'application/pdf' });
        var onDone = _opts && _opts.onDone;
        _close();
        if (onDone) onDone(file);
    }).catch(function(e){
        console.error('[ScanToPdf] build failed', e);
        _toast('Could not build the PDF — try again');
        _finishedOnce = false; // a build failure isn't a finish — a later Cancel should still report "cancelled"
        _els.doneBtn.disabled = false;
        _renderThumbs();
    });
}

function _close(){
    if (_els && _els.overlay && _els.overlay.parentNode) _els.overlay.parentNode.removeChild(_els.overlay);
    var onCancel = _opts && _opts.onCancel;
    var hadPages = _pages.length > 0;
    _els = null; _opts = null; _pages = [];
    if (onCancel && !_finishedOnce) onCancel(hadPages);
    _finishedOnce = false;
}
var _finishedOnce = false;

function open(opts){
    opts = opts || {};
    if (!window.PDFLib){ _toast('Scanning isn’t available right now — refresh and try again'); return; }
    _opts = opts;
    _pages = [];
    _finishedOnce = false;

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000000;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;';
    overlay.addEventListener('mousedown', function(e){ if (e.target === overlay) _close(); });

    var sheet = document.createElement('div');
    sheet.style.cssText = 'background:#fff;width:100%;max-width:480px;max-height:88vh;border-radius:16px 16px 0 0;display:flex;flex-direction:column;box-shadow:0 -10px 40px rgba(0,0,0,.3);';
    // On wider screens, center it like a normal modal instead of a bottom sheet.
    if (window.innerWidth >= 640) {
        overlay.style.alignItems = 'center';
        sheet.style.borderRadius = '16px';
        sheet.style.maxHeight = '80vh';
    }

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #E2E8F0;';
    header.innerHTML = '<span style="font-size:1rem;font-weight:700;color:#0F172A;">'+_esc(opts.title||'Scan Document')+'</span>';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background:none;border:none;font-size:1.5rem;line-height:1;color:#64748B;cursor:pointer;padding:0 2px;';
    closeBtn.onclick = function(){ _close(); };
    header.appendChild(closeBtn);

    var body = document.createElement('div');
    body.style.cssText = 'padding:16px 18px;overflow-y:auto;flex:1;';
    body.innerHTML = '<p style="font-size:.82rem;color:#64748B;margin:0 0 12px;line-height:1.5;">Photograph each page in order. You can add as many pages as you need before finishing.</p>';

    var captureRow = document.createElement('label');
    captureRow.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border:2px dashed #93C5FD;border-radius:10px;background:#EFF6FF;color:#1D4ED8;font-weight:700;font-size:.88rem;cursor:pointer;';
    captureRow.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span id="stpCaptureLabel">Take Photo</span>';
    var captureInput = document.createElement('input');
    captureInput.type = 'file';
    captureInput.accept = 'image/*';
    captureInput.setAttribute('capture', 'environment');
    captureInput.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;';
    captureInput.onchange = function(){
        var f = captureInput.files && captureInput.files[0];
        captureInput.value = '';
        if (f) _addCapturedFile(f);
    };
    captureRow.appendChild(captureInput);
    body.appendChild(captureRow);

    var thumbsWrap = document.createElement('div');
    thumbsWrap.style.cssText = 'display:flex;gap:8px;overflow-x:auto;padding:14px 0 4px;min-height:96px;';
    body.appendChild(thumbsWrap);

    var countLabel = document.createElement('div');
    countLabel.style.cssText = 'font-size:.75rem;color:#64748B;margin-top:2px;';
    body.appendChild(countLabel);

    var footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:14px 18px;border-top:1px solid #E2E8F0;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:none;border:1px solid #CBD5E1;border-radius:8px;padding:9px 18px;font-size:.85rem;font-weight:600;color:#64748B;cursor:pointer;';
    cancelBtn.onclick = function(){ _close(); };
    var doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.textContent = 'Done';
    doneBtn.disabled = true;
    doneBtn.style.cssText = 'background:#3B82F6;color:#fff;border:none;border-radius:8px;padding:9px 22px;font-size:.85rem;font-weight:700;cursor:default;opacity:.5;';
    doneBtn.onclick = function(){ _finishedOnce = true; _finish(); };
    footer.appendChild(cancelBtn);
    footer.appendChild(doneBtn);

    sheet.appendChild(header);
    sheet.appendChild(body);
    sheet.appendChild(footer);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    _els = { overlay: overlay, thumbs: thumbsWrap, count: countLabel, doneBtn: doneBtn };
    _renderThumbs();
}

window.CampistryScanToPdf = { open: open };
})();
