// =============================================================================
// campistry_luggage_core.js — camp luggage logistics
//
// Pure functions behind Campistry Luggage. The page owns storage and rendering;
// tag codes, pricing, the status machine and the manifests live here so they're
// testable and so the office, the truck and the bunk crew all read the same
// state.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DOMAIN, BRIEFLY
//
// Camp luggage moves separately from campers. Bags leave a day early, travel by
// truck, and are waiting on the bed when the bus arrives. Families either bring
// bags to a communal drop-off in their neighbourhood (Brooklyn, Five Towns,
// Monsey, Passaic and so on, each with a date and a morning time window) or pay
// more for a private pick-up at the house. Service is sold as round trip,
// drop-off only, or pick-up only. Pricing is per bag with a base allowance, and
// private pick-up carries a surcharge.
//
// Every bag gets a TAG before it leaves — the tag is what makes a duffel in a
// pile of four hundred identical duffels findable. Tag codes here are derived
// from camper + booking + bag index, so reprinting a lost tag reproduces the
// same code instead of minting a second identity for one bag.
//
// A bag then moves through a fixed sequence of states, and the useful question
// is never "where is it" in the abstract — it's "which bags for Bunk 12 aren't
// on the bed yet". That's what the manifests answer.
// ─────────────────────────────────────────────────────────────────────────────
//
// Exposed as window.LuggageCore (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var L = {};

    L.SERVICE_TYPES = [
        { id: 'round', label: 'Round trip', legs: ['to_camp', 'to_home'] },
        { id: 'to_camp', label: 'Drop-off only (to camp)', legs: ['to_camp'] },
        { id: 'to_home', label: 'Pick-up only (from camp)', legs: ['to_home'] }
    ];

    L.PICKUP_MODES = [
        { id: 'communal', label: 'Communal drop-off' },
        { id: 'private', label: 'Private home pick-up' }
    ];

    L.BAG_TYPES = [
        { id: 'duffel', label: 'Duffel', short: 'D' },
        { id: 'trunk', label: 'Trunk', short: 'T' },
        { id: 'bedding', label: 'Bedding / linens', short: 'B' },
        { id: 'sports', label: 'Sports gear', short: 'S' },
        { id: 'other', label: 'Other', short: 'X' }
    ];

    // The sequence a bag actually moves through, in order. `terminal` marks the
    // states where the bag is no longer the camp's problem.
    L.STATUSES = [
        { id: 'registered', label: 'Registered', hint: 'Booked, not yet tagged' },
        { id: 'tagged', label: 'Tagged', hint: 'Tag printed and attached' },
        { id: 'received', label: 'Received', hint: 'Handed in at drop-off / collected from home' },
        { id: 'loaded', label: 'Loaded', hint: 'On the truck' },
        { id: 'in_transit', label: 'In transit', hint: 'On the road' },
        { id: 'at_camp', label: 'At camp', hint: 'Unloaded at camp' },
        { id: 'delivered', label: 'Delivered to bunk', hint: 'On the bed', terminal: true },
        { id: 'returned', label: 'Returned home', hint: 'Back with the family', terminal: true },
        { id: 'exception', label: 'Exception', hint: 'Missing, damaged or unclaimed', problem: true }
    ];
    L.STATUS_IDS = L.STATUSES.map(function (s) { return s.id; });

    // The normal forward path. `exception` is reachable from anywhere and can
    // be resolved back to any state, which is why it isn't in this list.
    var FORWARD = ['registered', 'tagged', 'received', 'loaded', 'in_transit', 'at_camp', 'delivered', 'returned'];

    L.statusMeta = function (id) {
        return L.STATUSES.filter(function (s) { return s.id === id; })[0] || null;
    };
    L.statusIndex = function (id) { return FORWARD.indexOf(id); };

    /**
     * States this bag can legally move to next.
     *
     * Forward one step, back one step (bags get mis-scanned), or flagged as an
     * exception. Skipping ahead is deliberately not allowed: a bag that reads
     * "delivered" without ever being "received" means a scan was missed, and
     * hiding that would defeat the point of tracking.
     */
    L.nextStatuses = function (current) {
        if (current === 'exception') return FORWARD.slice();      // resolve to anywhere
        var i = FORWARD.indexOf(current);
        if (i < 0) return ['registered', 'exception'];
        var out = [];
        if (i + 1 < FORWARD.length) out.push(FORWARD[i + 1]);
        if (i - 1 >= 0) out.push(FORWARD[i - 1]);
        out.push('exception');
        return out;
    };

    L.canTransition = function (from, to) {
        if (from === to) return false;
        return L.nextStatuses(from).indexOf(to) >= 0;
    };

    // ── tags ─────────────────────────────────────────────────────────────────
    // Returns '' for an empty name so each caller can pick its own fallback.
    // (Baking one in here made tagCode's 'CMP' default unreachable.)
    function initials(name) {
        return String(name || '').trim().split(/\s+/)
            .map(function (w) { return (w[0] || '').toUpperCase(); })
            .join('').slice(0, 3);
    }

    /**
     * A bag's tag code, derived rather than generated.
     *
     * Shape: CAMP-BKG-NN — camp prefix, booking reference, bag number. Deriving
     * it means a reprinted tag carries the SAME code, so a bag never ends up
     * with two identities in the system, which is exactly how a "lost" bag gets
     * lost twice.
     */
    L.tagCode = function (o) {
        o = o || {};
        var camp = (o.campPrefix || initials(o.campName) || 'CMP').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        var ref = String(o.bookingRef || o.bookingId || '0').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-6);
        var n = String(Math.max(1, parseInt(o.bagIndex, 10) || 1));
        return camp + '-' + (ref || '0') + '-' + (n.length < 2 ? '0' + n : n);
    };

    /** A short booking reference from the camper name and a sequence number. */
    L.bookingRef = function (camperName, seq) {
        return (initials(camperName) || 'X') + String(Math.max(1, parseInt(seq, 10) || 1)).padStart(4, '0');
    };

    /**
     * Expand a booking into one bag record per piece.
     *
     * `bags` is a count per type ({ duffel: 2, trunk: 1 }). Bags already on the
     * booking are preserved by tag code, so re-running this after the family
     * adds a bag doesn't reset the statuses of the bags already in transit.
     */
    L.buildBags = function (booking, opts) {
        opts = opts || {};
        booking = booking || {};
        var existing = {};
        (booking.bags || []).forEach(function (b) { if (b && b.tag) existing[b.tag] = b; });

        var out = [], index = 0;
        L.BAG_TYPES.forEach(function (t) {
            var n = Math.max(0, parseInt((booking.counts || {})[t.id], 10) || 0);
            for (var i = 0; i < n; i++) {
                index++;
                var tag = L.tagCode({
                    campPrefix: opts.campPrefix, campName: opts.campName,
                    bookingRef: booking.ref || booking.id, bagIndex: index
                });
                out.push(existing[tag] || {
                    tag: tag, type: t.id, index: index,
                    status: 'registered', history: [], note: ''
                });
            }
        });
        return out;
    };

    L.bagCount = function (booking) {
        return Object.keys((booking && booking.counts) || {}).reduce(function (s, k) {
            return s + Math.max(0, parseInt(booking.counts[k], 10) || 0);
        }, 0);
    };

    // ── pricing ──────────────────────────────────────────────────────────────
    function money(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
    L.money = money;

    L.DEFAULT_PRICING = {
        // Modelled on what camp luggage services actually charge: a communal
        // drop-off covering the first couple of bags, extra per bag beyond
        // that, and a much higher flat rate for a private home pick-up.
        communalBase: 105,      // covers `includedBags`
        includedBags: 2,
        extraBagFee: 35,
        privatePickupFee: 250,  // flat, replaces the communal base
        returnLegMultiplier: 1, // round trip = base × 2 by default
        oversizeFee: 0
    };

    L.pricing = function (raw) {
        var p = Object.assign({}, L.DEFAULT_PRICING, (raw && typeof raw === 'object') ? raw : {});
        ['communalBase', 'extraBagFee', 'privatePickupFee', 'oversizeFee'].forEach(function (k) {
            p[k] = Math.max(0, money(p[k]));
        });
        p.includedBags = Math.max(0, parseInt(p.includedBags, 10) || 0);
        p.returnLegMultiplier = Math.max(0, parseFloat(p.returnLegMultiplier) || 0);
        return p;
    };

    /**
     * What a booking costs.
     *
     * One leg is the base. A round trip charges the return leg at
     * returnLegMultiplier (1 = same price both ways). Private pick-up replaces
     * the communal base rather than adding to it — the higher fee already
     * includes the collection.
     */
    L.quote = function (booking, pricingRaw) {
        var p = L.pricing(pricingRaw);
        booking = booking || {};
        var bags = L.bagCount(booking);
        var svc = L.SERVICE_TYPES.filter(function (s) { return s.id === booking.serviceType; })[0]
                || L.SERVICE_TYPES[0];
        var legs = svc.legs.length;

        var base = booking.pickupMode === 'private' ? p.privatePickupFee : p.communalBase;
        var extraBags = Math.max(0, bags - p.includedBags);
        var extra = money(extraBags * p.extraBagFee);
        var oneLeg = money(base + extra);

        var total = oneLeg;
        if (legs > 1) total = money(oneLeg + oneLeg * p.returnLegMultiplier);
        if (booking.oversize) total = money(total + p.oversizeFee);

        return {
            bags: bags,
            legs: legs,
            serviceLabel: svc.label,
            base: money(base),
            extraBags: extraBags,
            extraBagsFee: extra,
            perLeg: oneLeg,
            total: total
        };
    };

    // ── locations ────────────────────────────────────────────────────────────
    /**
     * Load on a drop-off location: how many bookings and bags are assigned, and
     * whether that's past what the site can take. Capacity is in BAGS, because
     * that's what fills a truck — a family with four trunks is not one unit.
     */
    L.locationLoad = function (location, bookings) {
        var id = location && location.id;
        var mine = (bookings || []).filter(function (b) {
            return b && b.locationId === id && b.status !== 'cancelled';
        });
        var bags = mine.reduce(function (s, b) { return s + L.bagCount(b); }, 0);
        var cap = parseInt(location && location.capacityBags, 10) || 0;
        return {
            bookings: mine.length,
            bags: bags,
            capacityBags: cap,
            over: cap > 0 && bags > cap,
            remaining: cap > 0 ? Math.max(0, cap - bags) : null
        };
    };

    // ── manifests ────────────────────────────────────────────────────────────
    /** Every bag across every booking, flattened, with its camper attached. */
    L.allBags = function (bookings) {
        var out = [];
        (bookings || []).forEach(function (b) {
            if (!b || b.status === 'cancelled') return;
            (b.bags || []).forEach(function (bag) {
                out.push(Object.assign({}, bag, {
                    bookingId: b.id, camperName: b.camperName || '',
                    bunk: b.bunk || '', division: b.division || '',
                    locationId: b.locationId || '', routeId: b.routeId || ''
                }));
            });
        });
        return out;
    };

    /**
     * The truck manifest for a location or route — what should be on board,
     * and what's actually been scanned.
     */
    L.manifest = function (bookings, opts) {
        opts = opts || {};
        var bags = L.allBags(bookings).filter(function (b) {
            if (opts.locationId && b.locationId !== opts.locationId) return false;
            if (opts.routeId && b.routeId !== opts.routeId) return false;
            return true;
        });
        var byStatus = {};
        bags.forEach(function (b) { byStatus[b.status] = (byStatus[b.status] || 0) + 1; });
        var loadedIdx = FORWARD.indexOf('loaded');
        return {
            bags: bags.sort(function (a, b) {
                return String(a.camperName).localeCompare(String(b.camperName)) ||
                    (a.index || 0) - (b.index || 0);
            }),
            total: bags.length,
            byStatus: byStatus,
            onBoard: bags.filter(function (b) {
                var i = FORWARD.indexOf(b.status);
                return i >= loadedIdx && b.status !== 'returned';
            }).length,
            exceptions: bags.filter(function (b) { return b.status === 'exception'; })
        };
    };

    /**
     * Delivery sheet grouped by bunk — the sheet the crew carries when they put
     * bags on beds. A bag with no bunk yet is grouped under "Unassigned" rather
     * than dropped, because an unassigned bag is precisely the one that goes
     * missing.
     */
    L.deliveryByBunk = function (bookings, opts) {
        opts = opts || {};
        var groups = {};
        L.allBags(bookings).forEach(function (b) {
            if (opts.status && b.status !== opts.status) return;
            var key = b.bunk || 'Unassigned';
            if (!groups[key]) groups[key] = { bunk: key, bags: [], campers: {} };
            groups[key].bags.push(b);
            groups[key].campers[b.camperName] = (groups[key].campers[b.camperName] || 0) + 1;
        });
        return Object.keys(groups).sort(function (a, b) {
            if (a === 'Unassigned') return 1;
            if (b === 'Unassigned') return -1;
            return a.localeCompare(b, undefined, { numeric: true });
        }).map(function (k) {
            var g = groups[k];
            return {
                bunk: g.bunk, bags: g.bags, bagCount: g.bags.length,
                camperCount: Object.keys(g.campers).length,
                campers: Object.keys(g.campers).sort().map(function (n) {
                    return { name: n, bags: g.campers[n] };
                })
            };
        });
    };

    /** Progress across the whole operation, for the dashboard. */
    L.summary = function (bookings) {
        var bags = L.allBags(bookings);
        var counts = {};
        L.STATUS_IDS.forEach(function (s) { counts[s] = 0; });
        bags.forEach(function (b) { if (counts[b.status] != null) counts[b.status]++; });
        var done = counts.delivered + counts.returned;
        return {
            bookings: (bookings || []).filter(function (b) { return b && b.status !== 'cancelled'; }).length,
            bags: bags.length,
            byStatus: counts,
            delivered: done,
            exceptions: counts.exception,
            percentComplete: bags.length ? Math.round(done / bags.length * 100) : 0
        };
    };

    /**
     * Move a bag to a new status, recording who and when.
     * Returns { ok, bag, error } and never mutates the input.
     */
    L.setStatus = function (bag, to, o) {
        o = o || {};
        if (!bag) return { ok: false, error: 'No bag' };
        if (!L.statusMeta(to)) return { ok: false, error: 'Unknown status: ' + to };
        if (!o.force && !L.canTransition(bag.status, to)) {
            return { ok: false, error: 'A bag can\'t go from ' +
                ((L.statusMeta(bag.status) || {}).label || bag.status) + ' straight to ' +
                (L.statusMeta(to).label) };
        }
        var next = Object.assign({}, bag, { status: to });
        next.history = (bag.history || []).concat([{
            status: to, at: o.at || '', by: o.by || '', note: o.note || ''
        }]);
        if (o.note != null) next.note = o.note;
        return { ok: true, bag: next };
    };

    /** Bulk scan — move every bag matching a tag list. Reports what missed. */
    L.scanBatch = function (bookings, tags, to, o) {
        var wanted = {};
        (tags || []).forEach(function (t) { wanted[String(t).trim().toUpperCase()] = 1; });
        var moved = [], failed = [], seen = {};
        (bookings || []).forEach(function (bk) {
            (bk && bk.bags || []).forEach(function (bag) {
                var key = String(bag.tag || '').toUpperCase();
                if (!wanted[key]) return;
                seen[key] = 1;
                var res = L.setStatus(bag, to, o);
                if (res.ok) moved.push({ bookingId: bk.id, tag: bag.tag, bag: res.bag });
                else failed.push({ tag: bag.tag, error: res.error });
            });
        });
        var unknown = Object.keys(wanted).filter(function (t) { return !seen[t]; });
        return { moved: moved, failed: failed, unknown: unknown };
    };

    if (typeof window !== 'undefined') window.LuggageCore = L;
    if (typeof module !== 'undefined' && module.exports) module.exports = L;
})();
