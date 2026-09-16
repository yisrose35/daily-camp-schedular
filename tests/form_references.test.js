const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ─── every function a form calls has to exist ────────────────────────────────
//
// Twice in one session I removed a block from campistry_register.html and took
// working functions out with it. `node --check` passes -- the file is still
// valid JavaScript -- and every grep-based test passes too, because the STRING
// it was looking for was somewhere else in the file. The failure only shows up
// as a ReferenceError in a real browser, which is exactly how the registration
// form went white earlier.
//
// So: pull the scripts out of each form, collect what is DEFINED and what is
// CALLED, and fail on anything called that nothing defines. Crude on purpose --
// it only looks at bare `name(` calls, never `obj.method(` -- which is enough
// to catch a deleted local function without needing a real parser.

const BUILTINS = new Set([
    // language + DOM
    'String','Number','Boolean','Math','JSON','Object','Array','Date','RegExp','Error','Promise','Map','Set',
    'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
    'setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','fetch','alert','confirm',
    'prompt','btoa','atob','structuredClone','URLSearchParams','URL','FormData','FileReader','Blob','Image',
    'Intl','console','Uint8Array','Uint16Array','ArrayBuffer','TextEncoder','TextDecoder','window','document','localStorage','sessionStorage','navigator','location','history','print',
    // keywords that look like calls to a regex
    'if','for','while','switch','catch','return','typeof','function','new','await','do','else','delete','in','of',
    'var','let','const','try','finally','break','continue',
    'async','yield','void','throw','instanceof','case','super','this',
]);

// Globals these pages get from the other <script src> files they load.
const PROVIDED = new Set([
    'CampistryDB','CampistryPayments','CampistryDepositPolicy','CampistryCardCapture','supabase','esc','fm',
]);

function scriptsOf(file) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
        .map(b => b.replace(/^<script>/, '').replace(/<\/script>$/, ''))
        .join('\n;\n');
}

// Strings, comments and regex literals hold plenty of "text (" that is not a
// call. A regex cannot remove them reliably -- the first version of this used
// one, a single apostrophe inside a double-quoted string paired with another
// one thousands of lines away, and it silently deleted a third of the file.
// The test then passed because it could no longer SEE the calls it was meant
// to be checking, which is worse than not having it.
//
// So: a real left-to-right scan. Short, and it cannot lose its place.
function stripNonCode(src) {
    let out = '', i = 0;
    const n = src.length;
    // Whether a '/' here starts a regex literal or is a division sign is
    // decided by what came before it -- the same rule a JS lexer uses.
    const regexCanFollow = () => {
        for (let k = out.length - 1; k >= 0; k--) {
            const c = out[k];
            if (/\s/.test(c)) continue;
            if (/[)\]}\w$]/.test(c)) {
                // `if (...) /re/` is a regex; `x) / 2` is division. Tell them
                // apart by the keyword before the bracket.
                if (c === ')') return /\b(if|for|while|switch|catch|with)\s*\($/.test(out.slice(0, k + 1).replace(/\([^()]*\)$/, '('));
                return false;
            }
            return true;
        }
        return true;
    };
    while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (c === '/' && c2 === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
        if (c === '/' && c2 === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; out += ' '; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c; i++;
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === q) { i++; break; }
                // A template's ${...} is real code, but nothing in these files
                // calls a function only from inside one, so it goes with the
                // string rather than complicating the scan.
                i++;
            }
            out += '""'; continue;
        }
        if (c === '/' && regexCanFollow()) {
            let j = i + 1, inClass = false, ok = false;
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (d === '\n') break;                 // not a regex after all
                if (d === '[') inClass = true;
                else if (d === ']') inClass = false;
                else if (d === '/' && !inClass) { ok = true; j++; break; }
                j++;
            }
            if (ok) { while (j < n && /[gimsuyd]/.test(src[j])) j++; i = j; out += ' 0 '; continue; }
        }
        out += c; i++;
    }
    return out;
}

function check(file) {
    const raw = scriptsOf(file);
    const code = stripNonCode(raw);
    // Definitions are read from the RAW source, calls from the stripped one.
    // Stripping strings with a regex is approximate -- one stray apostrophe in
    // an HTML string and a whole region disappears -- and the two directions
    // fail differently: an over-strip that hides a DEFINITION invents a bug,
    // while one that hides a CALL merely misses one. So the side that would
    // cry wolf reads the text as written.
    const defined = new Set([
        ...(raw.match(/function\s+([A-Za-z_$][\w$]*)/g) || []).map(m => m.split(/\s+/)[1]),
        ...(raw.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g) || []).map(m => /\s([A-Za-z_$][\w$]*)\s*=$/.exec(m)[1]),
        // window.foo = function — how these pages expose their handlers
        ...(raw.match(/window\.([A-Za-z_$][\w$]*)\s*=/g) || []).map(m => m.slice(7).replace(/\s*=$/, '')),
        // function parameters, which are local names that get called
        ...(raw.match(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g) || [])
            .flatMap(m => (/\(([^)]*)\)/.exec(m)[1] || '').split(',').map(x => x.trim().split(/[\s=]/)[0]))
            .filter(Boolean),
    ]);
    const called = new Set((code.match(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g) || [])
        .map(m => /([A-Za-z_$][\w$]*)\s*\($/.exec(m)[1]));

    return [...called]
        .filter(n => !defined.has(n) && !BUILTINS.has(n) && !PROVIDED.has(n))
        // Capitalised names are constructors and library globals from the
        // other files these pages load, not the page's own helpers. They are
        // also what the approximate string-stripping above coughs up when it
        // gets a quote wrong ("John Doe (555)" in a placeholder). Skipping
        // them keeps the signal: this test is here to catch a LOCAL function
        // that got deleted, which is the mistake that actually happens.
        .filter(n => !/^[A-Z]/.test(n))
        .sort();
}

for (const form of ['campistry_register.html', 'campistry_postaccept.html', 'campistry_card_setup.html']) {
    test(`${form} calls nothing it does not define`, () => {
        assert.deepStrictEqual(check(form), [],
            'these are called but defined nowhere — a browser would throw ReferenceError:\n  ' +
            check(form).join('\n  '));
    });
}
