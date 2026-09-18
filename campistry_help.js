// campistry_help.js — search/filter, mobile contents drawer, and scroll-spy
// for the Help Center. No cloud data — everything here is static content.
(function () {
    'use strict';

    var searchInput = document.getElementById('hcSearch');
    var clearBtn = document.getElementById('hcSearchClear');
    var emptyClearBtn = document.getElementById('hcEmptyClear');
    var countEl = document.getElementById('hcSearchCount');
    var emptyEl = document.getElementById('hcEmpty');
    var sections = Array.prototype.slice.call(document.querySelectorAll('.hc-section[data-searchable]'));
    var allItems = [];

    sections.forEach(function (sec) {
        var items = Array.prototype.slice.call(sec.querySelectorAll('.hc-faq-item'));
        items.forEach(function (item) {
            item.dataset.text = (item.textContent || '').toLowerCase();
            allItems.push(item);
        });
    });

    function runSearch() {
        var q = searchInput.value.trim().toLowerCase();
        var active = q.length > 0;
        document.body.classList.toggle('hc-search-active', active);

        if (!active) {
            allItems.forEach(function (item) { item.hidden = false; item.open = false; });
            sections.forEach(function (sec) { sec.hidden = false; });
            emptyEl.classList.remove('show');
            countEl.textContent = '';
            return;
        }

        var visibleCount = 0;
        sections.forEach(function (sec) {
            var items = Array.prototype.slice.call(sec.querySelectorAll('.hc-faq-item'));
            var sectionVisible = 0;
            items.forEach(function (item) {
                var match = item.dataset.text.indexOf(q) !== -1;
                item.hidden = !match;
                item.open = match;
                if (match) { sectionVisible++; visibleCount++; }
            });
            sec.hidden = sectionVisible === 0;
        });

        emptyEl.classList.toggle('show', visibleCount === 0);
        countEl.textContent = visibleCount ? (visibleCount + (visibleCount === 1 ? ' result' : ' results')) : '';
    }

    function clearSearch() {
        searchInput.value = '';
        runSearch();
        searchInput.focus();
    }

    if (searchInput) {
        searchInput.addEventListener('input', runSearch);
        [clearBtn, emptyClearBtn].forEach(function (btn) {
            if (btn) btn.addEventListener('click', clearSearch);
        });
    }

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
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var link = document.querySelector('.hc-toc-link[href="#' + entry.target.id + '"]');
                if (!link) return;
                tocLinks.forEach(function (l) { l.classList.remove('active'); });
                link.classList.add('active');
            });
        }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });
        spyTargets.forEach(function (t) { observer.observe(t); });
    }
})();
