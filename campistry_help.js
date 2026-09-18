// campistry_help.js — relevance-ranked search with live suggestions,
// keyboard shortcuts, scroll-spy, back-to-top and the mobile contents
// drawer for the Help Center. No cloud data — everything here is static
// content already in the page.
(function () {
    'use strict';

    var STOPWORDS = ('a an the to of in on at for and or is are do does did i my me how '
        + 'can get set up with from into it this that what when where who why not '
        + 'no does doesn\'t don\'t a.m p.m').split(' ').reduce(function (acc, w) {
        acc[w] = true; return acc;
    }, {});

    // Realistic word choices that don't share a stem but mean the same
    // thing in this app — "processor" vs "processing", "kid" vs "camper".
    // Stemming alone can't bridge these (different parts of speech), so
    // this is a short, hand-picked list rather than an attempt at real NLP.
    var SYNONYM_GROUPS = [
        ['processor', 'processing', 'stripe'],
        ['sign', 'signup', 'register', 'registration', 'enroll', 'enrollment'],
        ['login', 'signin', 'password'],
        ['kid', 'child', 'camper'],
        ['staff', 'counselor'],
        ['print', 'printing', 'printout'],
        ['text', 'sms', 'message', 'messaging'],
        ['bus', 'transportation', 'route'],
        ['photo', 'picture'],
        ['absent', 'absence'],
        ['delete', 'remove'],
        ['edit', 'change', 'update'],
        ['pool', 'swim', 'swimming'],
        ['money', 'tuition', 'balance'],
        ['schedule', 'calendar'],
        ['rain', 'rainy', 'weather'],
        ['app', 'phone', 'mobile']
    ];
    var SYNONYM_MAP = {};
    SYNONYM_GROUPS.forEach(function (group) {
        group.forEach(function (word) { SYNONYM_MAP[word] = group; });
    });
    function expandToken(t) { return SYNONYM_MAP[t] || [t]; }

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
    var searchWrap = document.querySelector('.hc-search-wrap');
    var clearBtn = document.getElementById('hcSearchClear');
    var emptyClearBtn = document.getElementById('hcEmptyClear');
    var countEl = document.getElementById('hcSearchCount');
    var emptyEl = document.getElementById('hcEmpty');
    var suggestEl = document.getElementById('hcSuggest');
    var sections = Array.prototype.slice.call(document.querySelectorAll('.hc-section[data-searchable]'));
    var subheads = Array.prototype.slice.call(document.querySelectorAll('.hc-subhead'));

    var PRODUCT_META = {
        'product-dashboard': { cls: 'hc-c-dashboard', name: 'Dashboard' },
        'product-me': { cls: 'hc-c-me', name: 'Me' },
        'product-flow': { cls: 'hc-c-flow', name: 'Flow' },
        'product-go': { cls: 'hc-c-go', name: 'Go' },
        'product-health': { cls: 'hc-c-health', name: 'Health' },
        'product-live': { cls: 'hc-c-live', name: 'Live' },
        'product-snacks': { cls: 'hc-c-snacks', name: 'Snacks' },
        'product-link': { cls: 'hc-c-link', name: 'Link' },
        'product-notes': { cls: 'hc-c-notes', name: 'Notes' },
        'product-lite': { cls: 'hc-c-lite', name: 'Lite' },
        'glossary': { cls: 'hc-c-dashboard', name: 'Glossary' },
        'troubleshooting': { cls: 'hc-c-dashboard', name: 'Troubleshooting' },
        'faq': { cls: 'hc-c-dashboard', name: 'FAQ' }
    };

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
        var meta = PRODUCT_META[sec.id] || { cls: '', name: '' };
        var items = Array.prototype.slice.call(sec.querySelectorAll('.hc-faq-item'));
        items.forEach(function (item) {
            var qEl = item.querySelector('.hc-faq-q-text');
            item._qEl = qEl;
            item._qText = qEl ? qEl.textContent : '';
            item._fullLower = (item.textContent || '').toLowerCase();
            item._qWords = wordSet(item._qText);
            item._fullWords = wordSet(item._fullLower);
            item._product = meta;
            item._score = 0;
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

    // Scores every item against a raw query string. Shared by the full-page
    // filter and the live suggestions dropdown so they never disagree.
    function scoreItems(raw) {
        var tokens = tokenize(raw).map(stem);
        var queryTokens = tokens.filter(function (t) { return !STOPWORDS[t]; });
        if (!queryTokens.length) queryTokens = tokens;
        var phrase = raw.toLowerCase();
        var phraseBonus = phrase.length >= 3;
        var topScore = 0;

        allItems.forEach(function (item) {
            if (!queryTokens.length) { item._score = 0; item._qMatches = []; return; }
            var qMatches = [], rawScore = 0, covered = 0;
            queryTokens.forEach(function (t) {
                var variants = expandToken(t);
                var w = idf(t);
                var matchedVariant = null;
                for (var i = 0; i < variants.length; i++) {
                    if (item._qWords[variants[i]]) { matchedVariant = variants[i]; break; }
                }
                if (matchedVariant) {
                    rawScore += w * 2;
                    qMatches.push(matchedVariant);
                    covered++;
                } else if (variants.some(function (v) { return item._fullWords[v]; })) {
                    rawScore += w;
                    covered++;
                }
            });
            if (phraseBonus && item._fullLower.indexOf(phrase) !== -1) rawScore += 5;
            // A multi-word query needs to hit more of its DISTINCT words to
            // rank well — otherwise every item sharing just the query's most
            // common word (e.g. "add") would tie with the one real match.
            var coverage = covered / queryTokens.length;
            var score = rawScore * Math.pow(coverage, 1.5);
            item._score = score;
            item._qMatches = qMatches;
            if (score > topScore) topScore = score;
        });

        return topScore;
    }

    function resetAll() {
        document.body.classList.remove('hc-search-active');
        allItems.forEach(function (item) {
            item.hidden = false;
            item.open = false;
            item.style.order = '';
            item._score = 0;
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
        hideSuggestions();
    }

    function runSearch() {
        var raw = searchInput.value.trim();
        if (!raw) { resetAll(); return; }

        document.body.classList.add('hc-search-active');

        // The cutoff scales with how strong the best match is, so a sharp
        // query (one clear winner) stays tight instead of dragging in every
        // item that shares just one common word with it. The min() keeps
        // the top match(es) always visible, even when nothing matches well.
        var topScore = scoreItems(raw);
        var threshold = topScore > 0 ? Math.min(topScore, Math.max(2, Math.ceil(topScore * 0.6))) : Infinity;

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

    // ==================== LIVE SUGGESTIONS DROPDOWN ====================
    var SUGGEST_MAX = 6;

    function renderSuggestions(raw) {
        if (!raw || !suggestEl) { hideSuggestions(); return; }
        var ranked = allItems
            .filter(function (item) { return item._score > 0; })
            .sort(function (a, b) { return b._score - a._score; })
            .slice(0, SUGGEST_MAX);

        if (!ranked.length) { hideSuggestions(); return; }

        suggestEl.innerHTML = ranked.map(function (item, idx) {
            return '<button class="hc-suggest-item" type="button" data-idx="' + idx + '">'
                + '<span class="hc-suggest-tag ' + item._product.cls + '">' + escapeHtml(item._product.name) + '</span>'
                + '<span class="hc-suggest-q">' + highlight(item._qText, item._qMatches) + '</span>'
                + '</button>';
        }).join('') + '<div class="hc-suggest-hint">↑↓ to navigate · Enter to open · Esc to close</div>';

        suggestEl._targets = ranked;
        showSuggestions();
    }

    function showSuggestions() {
        if (suggestEl) suggestEl.classList.add('show');
    }
    function hideSuggestions() {
        if (suggestEl) { suggestEl.classList.remove('show'); suggestEl._targets = null; }
    }

    function setActiveSuggestion(idx) {
        var items = Array.prototype.slice.call(suggestEl.querySelectorAll('.hc-suggest-item'));
        items.forEach(function (el, i) { el.classList.toggle('active', i === idx); });
        if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function openSuggestion(item) {
        hideSuggestions();
        item.hidden = false;
        item.open = true;
        window.scrollTo({ top: item.getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
        item.classList.add('hc-flash');
        setTimeout(function () { item.classList.remove('hc-flash'); }, 900);
    }

    if (suggestEl) {
        suggestEl.addEventListener('mousedown', function (e) {
            var btn = e.target.closest('.hc-suggest-item');
            if (!btn || !suggestEl._targets) return;
            e.preventDefault();
            var item = suggestEl._targets[Number(btn.dataset.idx)];
            if (item) openSuggestion(item);
        });
    }

    document.addEventListener('click', function (e) {
        if (searchWrap && !searchWrap.contains(e.target) && (!suggestEl || !suggestEl.contains(e.target))) {
            hideSuggestions();
        }
    });

    // ==================== SEARCH INPUT WIRING ====================
    var debouncedSearch = debounce(function () {
        runSearch();
        renderSuggestions(searchInput.value.trim());
    }, 120);

    function clearSearch() {
        searchInput.value = '';
        resetAll();
        searchInput.focus();
    }

    if (searchInput) {
        searchInput.addEventListener('input', debouncedSearch);
        searchInput.addEventListener('focus', function () {
            var v = searchInput.value.trim();
            if (v) renderSuggestions(v);
        });

        searchInput.addEventListener('keydown', function (e) {
            var open = suggestEl && suggestEl.classList.contains('show');
            if (!open) return;
            var items = Array.prototype.slice.call(suggestEl.querySelectorAll('.hc-suggest-item'));
            var activeIdx = items.findIndex(function (el) { return el.classList.contains('active'); });

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveSuggestion((activeIdx + 1) % items.length);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveSuggestion((activeIdx - 1 + items.length) % items.length);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                var idx = activeIdx >= 0 ? activeIdx : 0;
                var item = suggestEl._targets && suggestEl._targets[idx];
                if (item) openSuggestion(item);
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                hideSuggestions();
            }
        });

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

    // Contents toggle — same button and hamburger icon at every width, but
    // what it does depends on how much room there is: on a narrow screen
    // the sidebar has nowhere to live, so it opens as a full overlay; on a
    // wide desktop screen there's plenty of room, so it just collapses the
    // sidebar and lets .hc-main reclaim its width. The desktop choice is
    // remembered so it doesn't reset on every visit.
    var tocToggle = document.getElementById('hcTocToggle');
    var toc = document.getElementById('hcToc');
    var DESKTOP_MIN = 981;

    if (toc) {
        try {
            if (window.innerWidth >= DESKTOP_MIN && localStorage.getItem('hc_toc_collapsed') === '1') {
                toc.classList.add('hc-toc-collapsed');
            }
        } catch (e) { /* localStorage unavailable — default to expanded */ }
    }

    if (tocToggle && toc) {
        tocToggle.addEventListener('click', function () {
            if (window.innerWidth >= DESKTOP_MIN) {
                var collapsed = toc.classList.toggle('hc-toc-collapsed');
                try { localStorage.setItem('hc_toc_collapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
            } else {
                toc.classList.toggle('hc-toc-open');
            }
        });
        toc.addEventListener('click', function (e) {
            if (e.target.closest('a') && window.innerWidth < DESKTOP_MIN) toc.classList.remove('hc-toc-open');
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
