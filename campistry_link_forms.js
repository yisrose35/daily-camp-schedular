/* ============================================================================
 * campistry_link_forms.js — shared form field engine for Campistry Link
 *
 * One source of truth for form FIELD TYPES, rendering, value reading and
 * validation, used by BOTH the admin builder/preview (campistry_link_admin.html)
 * and the parent fill-online drawer (campistry_link_parent.html) so the two can
 * never drift as new field types are added.
 *
 * A "field" is a plain object: { id, type, label, required, help, ...typeProps }
 * Backward compatible — older forms only carry {id,type,label,required,options}.
 * ========================================================================== */
(function (global) {
    'use strict';
    var LF = {};

    // ── Field type registry ────────────────────────────────────────────────
    // group: for palette grouping. opts: has an options[] list. grid: rows/cols.
    // static: layout-only (no answer). scale/rating/etc carry their own props.
    LF.TYPES = [
        { t: 'text',       label: 'Short answer',        group: 'text' },
        { t: 'textarea',   label: 'Paragraph',           group: 'text' },
        { t: 'email',      label: 'Email',               group: 'text' },
        { t: 'phone',      label: 'Phone',               group: 'text' },
        { t: 'number',     label: 'Number',              group: 'text' },
        { t: 'date',       label: 'Date',                group: 'datetime' },
        { t: 'time',       label: 'Time',                group: 'datetime' },
        { t: 'daterange',  label: 'Date range',          group: 'datetime' },
        { t: 'dropdown',   label: 'Dropdown',            group: 'choice', opts: true },
        { t: 'radio',      label: 'Multiple choice',     group: 'choice', opts: true },
        { t: 'checkboxes', label: 'Checkboxes',          group: 'choice', opts: true },
        { t: 'yesno',      label: 'Yes / No',            group: 'choice' },
        { t: 'scale',      label: 'Linear scale',        group: 'choice' },
        { t: 'rating',     label: 'Star rating',         group: 'choice' },
        { t: 'grid',       label: 'Multiple-choice grid', group: 'grid', grid: true },
        { t: 'checkgrid',  label: 'Checkbox grid',       group: 'grid', grid: true },
        { t: 'file',       label: 'File upload',         group: 'special' },
        { t: 'checkbox',   label: 'Agreement box',       group: 'special' },
        { t: 'signature',  label: 'Signature',           group: 'special' },
        { t: 'heading',    label: 'Section heading',     group: 'layout', static: true },
        { t: 'paragraph',  label: 'Description text',    group: 'layout', static: true }
    ];

    LF.meta = function (t) {
        for (var i = 0; i < LF.TYPES.length; i++) if (LF.TYPES[i].t === t) return LF.TYPES[i];
        return { t: t, label: t };
    };
    LF.isStatic  = function (t) { return t === 'heading' || t === 'paragraph'; };
    LF.hasOptions = function (t) { var m = LF.meta(t); return !!m.opts; };

    // Optional imagery (stored as data URLs on the field / form settings).
    LF.fieldImageHtml = function (field) {
        return field && field.image ? '<img class="lkf-qimg" src="' + field.image + '" alt="">' : '';
    };
    LF.formHeaderHtml = function (settings) {
        return settings && settings.headerImage ? '<img class="lkf-header-img" src="' + settings.headerImage + '" alt="">' : '';
    };

    LF.esc = function (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };

    // Deterministic-ish shuffle (fine for option display order).
    function shuffle(arr) {
        arr = arr.slice();
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
    }
    var OTHER = '__other__';

    function optionList(field) {
        var opts = (field.options || []).map(function (o) { return String(o).trim(); }).filter(Boolean);
        if (field.shuffle && (field.type === 'radio' || field.type === 'checkboxes' || field.type === 'dropdown')) opts = shuffle(opts);
        if (field.allowOther && (field.type === 'radio' || field.type === 'checkboxes')) opts = opts.concat([OTHER]);
        return opts;
    }

    // ── Render the input control for a field ────────────────────────────────
    // opts: { id: <baseId>, mode: 'live'|'preview' }
    LF.renderInput = function (field, opts) {
        opts = opts || {};
        var id = opts.id || ('lkf_' + (field.id || Math.random().toString(36).slice(2)));
        var dis = opts.mode === 'preview' ? ' disabled' : '';
        var ph = LF.esc(field.placeholder || '');
        var t = field.type;
        var v = field.validation || {};
        var options = optionList(field);
        var e = LF.esc;

        switch (t) {
            case 'textarea':
                return '<textarea id="' + id + '" class="lkf-input lkf-textarea"' + dis + ' placeholder="' + ph + '"></textarea>';
            case 'text': case 'email': case 'phone': case 'number': {
                var ht = t === 'email' ? 'email' : t === 'phone' ? 'tel' : t === 'number' ? 'number' : 'text';
                var mm = '';
                if (t === 'number') {
                    if (v.min != null && v.min !== '') mm += ' min="' + e(v.min) + '"';
                    if (v.max != null && v.max !== '') mm += ' max="' + e(v.max) + '"';
                }
                return '<input type="' + ht + '" id="' + id + '" class="lkf-input"' + dis + mm + ' placeholder="' + ph + '">';
            }
            case 'date': return '<input type="date" id="' + id + '" class="lkf-input"' + dis + '>';
            case 'time': return '<input type="time" id="' + id + '" class="lkf-input"' + dis + '>';
            case 'daterange':
                return '<div class="lkf-range"><input type="date" id="' + id + '_a" class="lkf-input"' + dis + '>' +
                    '<span class="lkf-range-sep">to</span>' +
                    '<input type="date" id="' + id + '_b" class="lkf-input"' + dis + '></div>';
            case 'dropdown':
                return '<select id="' + id + '" class="lkf-input"' + dis + '><option value="">Select…</option>' +
                    options.map(function (o) { return '<option value="' + e(o) + '">' + (o === OTHER ? 'Other…' : e(o)) + '</option>'; }).join('') + '</select>';
            case 'radio': case 'checkboxes': {
                var it = t === 'radio' ? 'radio' : 'checkbox';
                return '<div id="' + id + '" class="lkf-choices" data-type="' + t + '"' + (field.limitSel ? ' data-limit="' + e(field.limitSel) + '"' : '') + '>' +
                    options.map(function (o) {
                        var isOther = o === OTHER;
                        return '<label class="lkf-choice"><input type="' + it + '" name="' + id + '" value="' + e(o) + '"' + dis + '>' +
                            '<span>' + (isOther ? 'Other:' : e(o)) + '</span>' +
                            (isOther ? ' <input type="text" class="lkf-input lkf-other" data-other-for="' + id + '"' + dis + '>' : '') +
                            '</label>';
                    }).join('') + '</div>';
            }
            case 'yesno':
                return '<div id="' + id + '" class="lkf-choices" data-type="radio">' +
                    '<label class="lkf-choice"><input type="radio" name="' + id + '" value="Yes"' + dis + '><span>Yes</span></label>' +
                    '<label class="lkf-choice"><input type="radio" name="' + id + '" value="No"' + dis + '><span>No</span></label></div>';
            case 'scale': {
                var mn = (field.scaleMin != null ? +field.scaleMin : 1);
                var mx = (field.scaleMax != null ? +field.scaleMax : 5);
                if (mx < mn) mx = mn;
                var pts = '';
                for (var s = mn; s <= mx; s++) {
                    pts += '<label class="lkf-scale-pt"><input type="radio" name="' + id + '" value="' + s + '"' + dis + '><span>' + s + '</span></label>';
                }
                return '<div id="' + id + '" class="lkf-scale" data-type="radio">' +
                    (field.scaleMinLabel ? '<span class="lkf-scale-lab">' + e(field.scaleMinLabel) + '</span>' : '') +
                    pts +
                    (field.scaleMaxLabel ? '<span class="lkf-scale-lab">' + e(field.scaleMaxLabel) + '</span>' : '') + '</div>';
            }
            case 'rating': {
                var rmax = field.ratingMax ? +field.ratingMax : 5;
                var st = '';
                for (var r = 1; r <= rmax; r++) st += '<label class="lkf-star"><input type="radio" name="' + id + '" value="' + r + '"' + dis + '><span>★</span></label>';
                return '<div id="' + id + '" class="lkf-rating" data-type="radio">' + st + '</div>';
            }
            case 'grid': case 'checkgrid': {
                var rows = (field.rows || []).map(function (x) { return String(x).trim(); }).filter(Boolean);
                var cols = (field.cols || []).map(function (x) { return String(x).trim(); }).filter(Boolean);
                var git = t === 'grid' ? 'radio' : 'checkbox';
                var head = '<tr><th></th>' + cols.map(function (c) { return '<th>' + e(c) + '</th>'; }).join('') + '</tr>';
                var bdy = rows.map(function (rw, ri) {
                    return '<tr><td class="lkf-grid-row">' + e(rw) + '</td>' +
                        cols.map(function (c) { return '<td><input type="' + git + '" name="' + id + '_r' + ri + '" value="' + e(c) + '"' + dis + '></td>'; }).join('') + '</tr>';
                }).join('');
                return '<div class="lkf-grid-wrap"><table id="' + id + '" class="lkf-grid" data-type="' + t + '" data-rows="' + rows.length + '">' +
                    '<thead>' + head + '</thead><tbody>' + bdy + '</tbody></table></div>';
            }
            case 'file':
                return '<input type="file" id="' + id + '" class="lkf-file"' + dis + (field.accept ? ' accept="' + e(field.accept) + '"' : '') + '>' +
                    '<div class="lkf-hint">Max ' + (field.maxMB || 5) + ' MB</div>';
            case 'checkbox':
                return '<label class="lkf-agree"><input type="checkbox" id="' + id + '"' + dis + '><span>' + e(field.agreeText || 'I confirm and agree') + '</span></label>';
            case 'signature':
                return '<div class="lkf-sig-wrap"><canvas id="' + id + '_c" class="lkf-sig" width="440" height="110"></canvas></div>' +
                    '<button type="button" class="lkf-sig-clear" data-sig="' + id + '_c">Clear signature</button>';
            default:
                return '<input type="text" id="' + id + '" class="lkf-input"' + dis + '>';
        }
    };

    // ── Read a field's value from the live DOM ──────────────────────────────
    // Returns { value: <string for storage>, empty: bool, count: <n for multi>,
    //           file: <File|null> }. Signature/file payloads are handled by the
    //           caller (async), this just reports presence.
    LF.read = function (field, id, root) {
        root = root || document;
        var t = field.type;
        function el(sfx) { return root.querySelector('#' + (id + (sfx || '')).replace(/([^\w-])/g, '\\$1')) || document.getElementById(id + (sfx || '')); }
        function checkedIn(name) {
            var out = [], nodes = root.querySelectorAll('[name="' + name + '"]:checked');
            nodes.forEach(function (n) { out.push(n.value); });
            return out;
        }
        if (t === 'heading' || t === 'paragraph') return { value: '', empty: true, skip: true };

        if (t === 'radio' || t === 'yesno' || t === 'scale' || t === 'rating') {
            var sel = checkedIn(id);
            var val = sel.length ? sel[0] : '';
            if (val === OTHER) {
                var oi = root.querySelector('.lkf-other[data-other-for="' + id + '"]');
                val = oi ? oi.value.trim() : '';
            }
            return { value: val, empty: !val, count: val ? 1 : 0 };
        }
        if (t === 'checkboxes') {
            var vals = checkedIn(id).map(function (x) {
                if (x === OTHER) { var oi = root.querySelector('.lkf-other[data-other-for="' + id + '"]'); return oi ? oi.value.trim() : ''; }
                return x;
            }).filter(Boolean);
            return { value: vals.join(', '), empty: !vals.length, count: vals.length };
        }
        if (t === 'grid' || t === 'checkgrid') {
            var tbl = document.getElementById(id); if (!tbl) return { value: '', empty: true, count: 0 };
            var nrows = +(tbl.getAttribute('data-rows') || 0), rowsFilled = 0, parts = [];
            var rowLabels = tbl.querySelectorAll('.lkf-grid-row');
            for (var ri = 0; ri < nrows; ri++) {
                var picks = checkedIn(id + '_r' + ri);
                if (picks.length) { rowsFilled++; parts.push((rowLabels[ri] ? rowLabels[ri].textContent : ('Row ' + (ri + 1))) + ': ' + picks.join('/')); }
            }
            return { value: parts.join(' • '), empty: rowsFilled === 0, count: rowsFilled, totalRows: nrows };
        }
        if (t === 'checkbox') {
            var c = document.getElementById(id);
            return { value: (c && c.checked) ? 'Yes' : 'No', empty: !(c && c.checked), count: (c && c.checked) ? 1 : 0 };
        }
        if (t === 'daterange') {
            var a = (document.getElementById(id + '_a') || {}).value || '';
            var b = (document.getElementById(id + '_b') || {}).value || '';
            var joined = (a && b) ? (a + ' to ' + b) : (a || b || '');
            return { value: joined, empty: !(a && b) };
        }
        if (t === 'file') {
            var fi = document.getElementById(id);
            var file = fi && fi.files && fi.files[0] ? fi.files[0] : null;
            return { value: file ? file.name : '', empty: !file, file: file };
        }
        if (t === 'signature') {
            // caller checks the canvas; report presence loosely
            return { value: '[signature]', empty: false, signature: true };
        }
        // plain inputs
        var node = document.getElementById(id);
        var val2 = node ? String(node.value).trim() : '';
        return { value: val2, empty: !val2 };
    };

    // ── Validate a read result against the field's rules ────────────────────
    // Returns an error string, or null if OK. `read` is the object from LF.read.
    LF.validate = function (field, read) {
        var v = field.validation || {};
        var label = field.label || 'This field';
        if (field.required && read.empty && field.type !== 'signature') return label + ' is required.';
        if (read.empty) return null; // optional & empty → fine

        var val = read.value;
        if (field.type === 'number') {
            var n = parseFloat(val);
            if (isNaN(n)) return label + ' must be a number.';
            if (v.min != null && v.min !== '' && n < +v.min) return label + ' must be at least ' + v.min + '.';
            if (v.max != null && v.max !== '' && n > +v.max) return label + ' must be at most ' + v.max + '.';
        }
        if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return label + ' must be a valid email.';
        if (field.type === 'text' || field.type === 'textarea') {
            if (v.minLen && val.length < +v.minLen) return label + ' must be at least ' + v.minLen + ' characters.';
            if (v.maxLen && val.length > +v.maxLen) return label + ' must be ' + v.maxLen + ' characters or fewer.';
        }
        if (v.pattern) {
            try { if (!(new RegExp(v.pattern)).test(val)) return (v.patternMsg || (label + ' is not in the right format.')); } catch (e) {}
        }
        if (field.type === 'checkboxes' && field.limitSel && read.count > +field.limitSel) {
            return label + ': choose at most ' + field.limitSel + '.';
        }
        return null;
    };

    // Read a File field as a data URL (async). cb(dataUrl|null).
    LF.readFile = function (field, id, cb) {
        var fi = document.getElementById(id);
        var file = fi && fi.files && fi.files[0] ? fi.files[0] : null;
        if (!file) { cb(null, null); return; }
        var maxMB = field.maxMB || 5;
        if (file.size > maxMB * 1024 * 1024) { cb(null, { tooBig: true, name: file.name, maxMB: maxMB }); return; }
        var fr = new FileReader();
        fr.onload = function () { cb(fr.result, { name: file.name }); };
        fr.onerror = function () { cb(null, { error: true, name: file.name }); };
        fr.readAsDataURL(file);
    };

    // ── Post-render wiring for LIVE forms (rating fill, selection limits,
    //    signature clear buttons). Call after inserting rendered fields. ─────
    LF.wireLive = function (root) {
        root = root || document;
        root.querySelectorAll('.lkf-rating').forEach(function (rt) {
            function paint() {
                var checked = rt.querySelector('input:checked');
                var val = checked ? +checked.value : 0;
                rt.querySelectorAll('.lkf-star').forEach(function (st) {
                    var iv = +st.querySelector('input').value;
                    st.classList.toggle('on', iv <= val);
                });
            }
            if (!rt._wired) { rt._wired = true; rt.addEventListener('change', paint); }
            paint();
        });
        root.querySelectorAll('.lkf-choices[data-limit]').forEach(function (box) {
            if (box._wired) return; box._wired = true;
            var lim = +box.getAttribute('data-limit');
            box.addEventListener('change', function (e) {
                var checked = box.querySelectorAll('input[type=checkbox]:checked');
                if (checked.length > lim && e.target && e.target.checked) { e.target.checked = false; }
            });
        });
        root.querySelectorAll('.lkf-sig-clear').forEach(function (btn) {
            if (btn._wired) return; btn._wired = true;
            btn.addEventListener('click', function () {
                var cv = document.getElementById(btn.getAttribute('data-sig'));
                if (cv) { var c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height); }
            });
        });
    };

    // Attach freehand drawing to a signature canvas (mouse + touch).
    LF.initSignature = function (canvas) {
        if (!canvas || canvas._sigInit) return; canvas._sigInit = true;
        var ctx = canvas.getContext('2d'), drawing = false, lx = 0, ly = 0;
        function pos(e) {
            var r = canvas.getBoundingClientRect(), sx = canvas.width / r.width, sy = canvas.height / r.height;
            var src = e.touches ? e.touches[0] : e;
            return { x: (src.clientX - r.left) * sx, y: (src.clientY - r.top) * sy };
        }
        function down(e) { drawing = true; var p = pos(e); lx = p.x; ly = p.y; }
        function move(e) {
            if (!drawing) return; if (e.touches) e.preventDefault();
            var p = pos(e); ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(p.x, p.y);
            ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.stroke(); lx = p.x; ly = p.y;
        }
        function up() { drawing = false; }
        canvas.addEventListener('mousedown', down); canvas.addEventListener('mousemove', move);
        canvas.addEventListener('mouseup', up); canvas.addEventListener('mouseleave', up);
        canvas.addEventListener('touchstart', function (e) { e.preventDefault(); down(e); }, { passive: false });
        canvas.addEventListener('touchmove', move, { passive: false });
        canvas.addEventListener('touchend', up);
    };
    LF.signatureEmpty = function (canvas) {
        if (!canvas) return true;
        var d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (var i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
        return true;
    };

    // ── Sections & conditional logic ───────────────────────────────────────
    // A form is a flat fields[] list; a `heading` field starts a new section.
    // Fields before the first heading form an implicit opening section.
    LF.buildSections = function (fields) {
        var secs = [], cur = { id: '__sec0', title: '', desc: '', heading: null, fields: [] };
        (fields || []).forEach(function (f) {
            if (f.type === 'heading') {
                if (cur.fields.length || cur.heading) secs.push(cur);
                cur = { id: f.id, title: f.label || '', desc: f.help || '', heading: f, fields: [] };
            } else {
                cur.fields.push(f);
            }
        });
        secs.push(cur);
        if (secs.length > 1 && secs[0].id === '__sec0' && !secs[0].fields.length) secs.shift();
        secs.forEach(function (s, i) { s.index = i; });
        return secs;
    };

    // Evaluate a single condition { field, op, value } against an answers map
    // keyed by field id. Missing answer → treated as empty.
    LF.evalCond = function (cond, answers) {
        if (!cond || !cond.field) return true;
        var a = answers[cond.field]; if (a == null) a = '';
        var aStr = String(a), v = String(cond.value == null ? '' : cond.value);
        switch (cond.op || 'eq') {
            case 'eq': return aStr === v;
            case 'ne': return aStr !== v;
            case 'contains': return aStr.toLowerCase().indexOf(v.toLowerCase()) >= 0;
            case 'filled': return aStr.trim() !== '';
            case 'empty': return aStr.trim() === '';
            case 'gt': return parseFloat(aStr) > parseFloat(v);
            case 'lt': return parseFloat(aStr) < parseFloat(v);
            default: return true;
        }
    };
    LF.visible = function (field, answers) { return field.showIf && field.showIf.field ? LF.evalCond(field.showIf, answers) : true; };

    // Where does a section send the respondent next? Per-question option
    // branching (Google-Forms style) wins; else the section's own nextSection;
    // else the following section. Returns a section id, 'next' or 'submit'.
    LF.sectionTarget = function (section, answers) {
        for (var i = 0; i < section.fields.length; i++) {
            var f = section.fields[i];
            if (f.branchOn && f.branch) {
                var ans = answers[f.id];
                if (ans != null && ans !== '' && f.branch[ans]) return f.branch[ans];
            }
        }
        if (section.heading && section.heading.nextSection) return section.heading.nextSection;
        return 'next';
    };

    // Read every answerable field into { fieldId: value } for logic evaluation.
    // idFn(field, index) → the DOM base id used when the field was rendered.
    LF.collectById = function (fields, idFn) {
        var out = {};
        (fields || []).forEach(function (f, i) {
            if (f.type === 'heading' || f.type === 'paragraph') return;
            try { out[f.id] = LF.read(f, idFn(f, i)).value; } catch (e) { out[f.id] = ''; }
        });
        return out;
    };

    global.LinkForms = LF;
})(typeof window !== 'undefined' ? window : this);
