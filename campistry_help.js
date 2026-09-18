// campistry_help.js — relevance-ranked search, keyboard shortcuts, scroll-spy,
// back-to-top and the mobile contents drawer for the Help Center. No cloud
// data — everything here is static content already in the page.
(function () {
    'use strict';

    var STOPWORDS = ('a an the to of in on at for and or is are do does did i my me how '
        + 'can get set up with from into it this that what when where who why not '
        + 'no does doesn\'t don\'t a.m p.m').split(' ').reduce(function (acc, w) {
        acc[w] = true; return acc;
    }, {});

    function tokenize(str) {
        var m = (str || '').toLowerCase().match(/[a-z0-9']+/g);
        return m ? m.filter(function (t) { return t.length > 1; }) : [];
    }

    // A light stem so "bunk"/"bunks" and "activity"/"activities" match each
    // other. Matching stays whole-word (via a Set), not substring — raw
    // substring search would let "add" match inside "address", which is a
    // real word, not a match.
    function stem(word) {
        if (word.length > 4 && /ies$/.test(word)) return word.slice(0, -3) + 'y';
        // Only "boxes"/"classes"-style plurals (added -es after a sibilant)
        // drop both letters. Anything else ending in -es — "schedules",
        // "devices" — already has the "e" as part of the root, so only the
        // trailing "s" is the plural marker.
        if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
        if (word.length > 3 && /s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
        return word;
    }

    function wordSet(str) {
        var set = {};
        tokenize(str).forEach(function (t) { set[stem(t)] = true; });
        return set;
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function highlight(originalText, tokens) {
        if (!tokens.length) return escapeHtml(originalText);
        var sorted = tokens.slice().sort(function (a, b) { return b.length - a.length; });
        var re = new RegExp('(' + sorted.map(escapeRegExp).join('|') + ')', 'gi');
        var parts = originalText.split(re);
        var out = '';
        for (var i = 0; i < parts.length; i++) {
            out += (i % 2 === 1) ? '<mark>' + escapeHtml(parts[i]) + '</mark>' : escapeHtml(parts[i]);
        }
        return out;
    }

    function debounce(fn, wait) {
        var t;
        return function () {
            var args = arguments, ctx = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    }

    var searchInput = document.getElementById('hcSearch');
    var clearBtn = document.getElementById('hcSearchClear');
    var emptyClearBtn = document.getElementById('hcEmptyClear');
    var countEl = document.getElementById('hcSearchCount');
    var emptyEl = document.getElementById('hcEmpty');
    var sections = Array.prototype.slice.call(document.querySelectorAll('.hc-section[data-searchable]'));
    var subheads = Array.prototype.slice.call(document.querySelectorAll('.hc-subhead'));

    function updateSubheads(active) {
        subheads.forEach(function (sub) {
            if (!active) { sub.hidden = false; return; }
            var sib = sub.nextElementSibling, anyVisible = false;
            while (sib && !sib.classList.contains('hc-subhead')) {
                if (sib.classList.contains('hc-faq-item') && !sib.hidden) { anyVisible = true; break; }
                sib = sib.nextElementSibling;
            }
            sub.hidden = !anyVisible;
        });
    }

    // Cache each item's searchable text (question weighted separately from
    // the full body) and its original question markup, once, up front — so
    // repeated searches never re-read the DOM and highlighting always
    // rebuilds from a clean source instead of compounding old <mark> tags.
    var allItems = [];
    sections.forEach(function (sec) {
        var link = document.querySelector('.hc-toc-link[href="#' + sec.id + '"]');
        if (link) {
            var badge = document.createElement('span');
            badge.className = 'hc-toc-count';
            link.appendChild(badge);
            sec._tocBadge = badge;
        }
        var items = Array.prototype.slice.call(sec.querySelectorAll('.hc-faq-item'));
        items.forEach(function (item) {
            var qEl = item.querySelector('.hc-faq-q-text');
            item._qEl = qEl;
            item._qText = qEl ? qEl.textContent : '';
            item._fullLower = (item.textContent || '').toLowerCase();
            item._qWords = wordSet(item._qText);
            item._fullWords = wordSet(item._fullLower);
            allItems.push(item);
        });
    });

    // Document-frequency weighting: a word like "bunk" that shows up in a
    // handful of items is a much stronger signal than "add" or "set", which
    // appear in dozens of "How do I ..." questions across the site. Without
    // this, any query sharing a common verb with the question text pulls in
    // everything that happens to use that verb.
    var docFreq = {};
    allItems.forEach(function (item) {
        Object.keys(item._fullWords).forEach(function (t) {
            docFreq[t] = (docFreq[t] || 0) + 1;
        });
    });
    var N = allItems.length;
    function idf(stemmedToken) {
        return Math.log((N + 1) / ((docFreq[stemmedToken] || 0) + 1)) + 1;
    }

    function resetAll() {
        document.body.classList.remove('hc-search-active');
        allItems.forEach(function (item) {
            item.hidden = false;
            item.open = false;
            item.style.order = '';
            if (item._qEl) item._qEl.textContent = item._qText;
        });
        sections.forEach(function (sec) {
            sec.hidden = false;
            sec.style.order = '';
            if (sec._tocBadge) sec._tocBadge.classList.remove('show');
        });
        emptyEl.classList.remove('show');
        countEl.textContent = '';
        updateSubheads(false);
    }

    function runSearch() {
        var raw = searchInput.value.trim();
        if (!raw) { resetAll(); return; }

        document.body.classList.add('hc-search-active');

        var tokens = tokenize(raw).map(stem);
        var queryTokens = tokens.filter(function (t) { return !STOPWORDS[t]; });
        if (!queryTokens.length) queryTokens = tokens;
        var phrase = raw.toLowerCase();
        var phraseBonus = phrase.length >= 3;

        // Pass 1 — score every item. Each token contributes its rarity
        // weight (see idf() above), doubled when it's in the question text
        // rather than buried in the answer. Matching is whole-word (via the
        // pre-built stem sets), so "add" can't match inside "address". An
        // exact phrase hit anywhere is a strong signal on its own.
        //
        // Raw weighted sums alone let a multi-word query like "add a bunk"
        // fill up with every item that happens to share just its most
        // common word ("add"). The coverage factor pulls those partial
        // matches back down so items hitting more of the DISTINCT query
        // words outrank ones that only ever hit one, even repeatedly.
        var topScore = 0;
        allItems.forEach(function (item) {
            if (!queryTokens.length) { item._score = 0; item._qMatches = []; return; }
            var qMatches = [], raw = 0, covered = 0;
            queryTokens.forEach(function (t) {
                var w = idf(t);
                if (item._qWords[t]) { raw += w * 2; qMatches.push(t); covered++; }
                else if (item._fullWords[t]) { raw += w; covered++; }
            });
            if (phraseBonus && item._fullLower.indexOf(phrase) !== -1) raw += 5;
            var coverage = covered / queryTokens.length;
            var score = raw * Math.pow(coverage, 1.5);
            item._score = score;
            item._qMatches = qMatches;
            if (score > topScore) topScore = score;
        });

        // The cutoff scales with how strong the best match is, so a sharp
        // query (one clear winner) stays tight instead of dragging in every
        // item that shares just one common word with it. The min() keeps
        // the top match(es) always visible, even when nothing matches well.
        var threshold = topScore > 0 ? Math.min(topScore, Math.max(2, Math.ceil(topScore * 0.6))) : Infinity;

        // Pass 2 — apply visibility, highlighting, and per-section tallies.
        var totalVisible = 0;
        sections.forEach(function (sec) {
            var items = Array.prototype.slice.call(sec.querySelectorAll('.hc-faq-item'));
            var sectionVisible = 0;
            var sectionBestScore = 0;

            items.forEach(function (item) {
                var visible = item._score > 0 && item._score >= threshold;
                item.hidden = !visible;
                item.open = visible;
                item.style.order = visible ? String(-item._score) : '';

                if (item._qEl) {
                    item._qEl.innerHTML = visible ? highlight(item._qText, item._qMatches) : escapeHtml(item._qText);
                }

                if (visible) {
                    sectionVisible++;
                    totalVisible++;
                    if (item._score > sectionBestScore) sectionBestScore = item._score;
                }
            });

            sec.hidden = sectionVisible === 0;
            sec.style.order = sectionVisible ? String(-sectionBestScore) : '';
            if (sec._tocBadge) {
                sec._tocBadge.textContent = String(sectionVisible);
                sec._tocBadge.classList.toggle('show', sectionVisible > 0);
            }
        });

        emptyEl.classList.toggle('show', totalVisible === 0);
        countEl.innerHTML = totalVisible
            ? '<strong>' + totalVisible + '</strong> ' + (totalVisible === 1 ? 'result' : 'results')
            : '';
        updateSubheads(true);
    }

    var debouncedSearch = debounce(runSearch, 120);

    function clearSearch() {
        searchInput.value = '';
        resetAll();
        searchInput.focus();
    }

    if (searchInput) {
        searchInput.addEventListener('input', debouncedSearch);
        [clearBtn, emptyClearBtn].forEach(function (btn) {
            if (btn) btn.addEventListener('click', clearSearch);
        });
    }

    function isTypingTarget(el) {
        if (!el) return false;
        var tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === '/' && !isTypingTarget(document.activeElement)) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        } else if (e.key === 'Escape' && document.activeElement === searchInput) {
            if (searchInput.value) clearSearch(); else searchInput.blur();
        }
    });

    // Mobile "Contents" drawer
    var tocToggle = document.getElementById('hcTocToggle');
    var toc = document.getElementById('hcToc');
    if (tocToggle && toc) {
        tocToggle.addEventListener('click', function () {
            toc.classList.toggle('hc-toc-open');
        });
        toc.addEventListener('click', function (e) {
            if (e.target.closest('a')) toc.classList.remove('hc-toc-open');
        });
    }

    // Highlight the TOC entry for whichever section is in view
    var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.hc-toc-link'));
    var spyTargets = Array.prototype.slice.call(document.querySelectorAll('.hc-section[id]'));
    if ('IntersectionObserver' in window && spyTargets.length && tocLinks.length) {
        var spy = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var link = document.querySelector('.hc-toc-link[href="#' + entry.target.id + '"]');
                if (!link) return;
                tocLinks.forEach(function (l) { l.classList.remove('active'); });
                link.classList.add('active');
            });
        }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });
        spyTargets.forEach(function (t) { spy.observe(t); });
    }

    // Back to top, once the hero has scrolled out of view
    var backTop = document.getElementById('hcBackTop');
    var hero = document.querySelector('.hc-hero');
    if (backTop && hero) {
        backTop.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        if ('IntersectionObserver' in window) {
            var topSpy = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) { backTop.classList.toggle('show', !entry.isIntersecting); });
            }, { rootMargin: '-120px 0px 0px 0px' });
            topSpy.observe(hero);
        }
    }
})();
