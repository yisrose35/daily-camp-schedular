// =============================================================================
// campistry_shop_core.js — camp shop catalogue, pricing and stock
//
// Pure functions. The page (campistry_shop.js) owns storage and rendering;
// everything that decides a price, a stock level or an order total lives here
// so it can be unit tested and so the storefront and the back office can't
// disagree about what something costs.
//
// THE VARIANT MODEL. Camp swag is sold by size and colour, and the two combine:
// a "Camp Ruach Tee" is one PRODUCT with a variant per size × colour. Stock,
// and sometimes price, hang off the variant, not the product — a 2XL usually
// costs a couple of dollars more, and running out of Adult Medium in navy
// shouldn't hide the whole tee from the catalogue.
//
// Variant ids are derived from the option values (`sku:size:color`) rather than
// generated, so a product can be edited — a size added, a colour renamed —
// without orphaning the orders that already reference it.
//
// Exposed as window.ShopCore (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var S = {};

    // Youth through adult, in the order a camp actually orders them. Kept as a
    // list, not a free-text field, so the size roll-up that tells a camp how
    // many of each to order can be trusted.
    S.SIZES = ['YXS', 'YS', 'YM', 'YL', 'YXL', 'AS', 'AM', 'AL', 'AXL', 'AXXL', 'A3XL'];
    S.SIZE_LABELS = {
        YXS: 'Youth XS', YS: 'Youth S', YM: 'Youth M', YL: 'Youth L', YXL: 'Youth XL',
        AS: 'Adult S', AM: 'Adult M', AL: 'Adult L', AXL: 'Adult XL',
        AXXL: 'Adult 2XL', A3XL: 'Adult 3XL'
    };

    S.CATEGORIES = [
        { id: 'tees', label: 'T-Shirts' },
        { id: 'sweats', label: 'Sweatshirts' },
        { id: 'hats', label: 'Hats' },
        { id: 'bags', label: 'Bags' },
        { id: 'accessories', label: 'Accessories' },
        { id: 'bundles', label: 'Bundles' }
    ];

    // Same stance as the canteen: credit yes, debit no. "Camp bill" posts the
    // amount to the family's account in Billing instead of taking money now.
    S.PAY_METHODS = [
        { id: 'credit', label: 'Credit card' },
        { id: 'cash', label: 'Cash' },
        { id: 'check', label: 'Check' },
        { id: 'canteen', label: 'Charge to canteen account' },
        { id: 'bill', label: 'Charge to camp bill' }
    ];

    S.ORDER_STATUSES = ['placed', 'paid', 'packed', 'delivered', 'cancelled'];
    S.STATUS_LABELS = {
        placed: 'Placed', paid: 'Paid', packed: 'Packed',
        delivered: 'Delivered', cancelled: 'Cancelled'
    };

    function money(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
    S.money = money;

    function slug(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    S.slug = slug;

    // ── product photos ───────────────────────────────────────────────────────
    // Photos are stored as raster data URLs on the product. Only raster: an
    // SVG data URL can carry <script>, and these strings are interpolated into
    // markup on both the admin page and the parent portal.
    //
    // They live in the same camp_state_kv blob as the rest of the catalogue, so
    // size matters — every page that reads the shop pays for them. Uploads are
    // downscaled hard before storage (see downscaleImage) and MAX_IMAGE_BYTES
    // is the backstop.
    S.MAX_IMAGE_BYTES = 160 * 1024;

    S.isSafeImage = function (s) {
        return typeof s === 'string' &&
            /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
    };

    /** Approximate decoded byte size of a data URL. */
    S.imageBytes = function (dataUrl) {
        if (typeof dataUrl !== 'string') return 0;
        var i = dataUrl.indexOf(',');
        if (i < 0) return 0;
        var b64 = dataUrl.slice(i + 1);
        var pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
        return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
    };

    /** The product's photo, or '' when there isn't a usable one. */
    S.productImage = function (product) {
        var img = product && product.image;
        return S.isSafeImage(img) ? img : '';
    };

    /**
     * Downscale + re-encode an uploaded file to a small JPEG data URL.
     * Browser only; resolves to '' anywhere else.
     *
     * Quality steps down until the result fits MAX_IMAGE_BYTES, rather than
     * rejecting the upload — a camp photographing a t-shirt on a phone will
     * hand us a 4MB image every time, and refusing it just means no photos.
     */
    S.downscaleImage = function (file, opts) {
        opts = opts || {};
        var maxDim = opts.maxDim || 700;
        var limit = opts.maxBytes || S.MAX_IMAGE_BYTES;
        if (typeof FileReader === 'undefined' || typeof document === 'undefined') {
            return Promise.resolve('');
        }
        return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onload = function (e) {
                var img = new Image();
                img.onload = function () {
                    var w = img.naturalWidth || img.width;
                    var h = img.naturalHeight || img.height;
                    var scale = Math.min(1, maxDim / Math.max(w, h));
                    var c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(w * scale));
                    c.height = Math.max(1, Math.round(h * scale));
                    var ctx = c.getContext('2d');
                    if (!ctx) { resolve(''); return; }
                    // Photos of merchandise are usually shot on white; filling
                    // first keeps a transparent PNG from going black as JPEG.
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, c.width, c.height);
                    ctx.drawImage(img, 0, 0, c.width, c.height);
                    var q = 0.82, url = c.toDataURL('image/jpeg', q);
                    while (S.imageBytes(url) > limit && q > 0.3) {
                        q -= 0.12;
                        url = c.toDataURL('image/jpeg', q);
                    }
                    resolve(S.imageBytes(url) <= limit ? url : '');
                };
                img.onerror = function () { resolve(''); };
                img.src = e.target.result;
            };
            reader.onerror = function () { resolve(''); };
            reader.readAsDataURL(file);
        });
    };

    /** Stable variant id. Derived, never generated — see the header note. */
    S.variantId = function (product, size, color) {
        var base = (product && (product.sku || product.id)) || 'item';
        return [slug(base), slug(size || 'onesize'), slug(color || 'default')].join(':');
    };

    /**
     * Every variant a product implies, with stock and price filled in.
     *
     * Stock lives in `product.stock` keyed by variant id, so adding a size
     * doesn't disturb the counts already recorded for the others. A size with
     * no entry reads as 0 in stock rather than as unlimited.
     */
    S.variants = function (product) {
        product = product || {};
        var sizes = (product.sizes && product.sizes.length) ? product.sizes : [''];
        var colors = (product.colors && product.colors.length) ? product.colors : [''];
        var stock = product.stock || {};
        var deltas = product.priceDeltas || {};
        var out = [];
        sizes.forEach(function (size) {
            colors.forEach(function (color) {
                var id = S.variantId(product, size, color);
                out.push({
                    id: id,
                    productId: product.id,
                    size: size || '',
                    color: color || '',
                    label: [size ? (S.SIZE_LABELS[size] || size) : '', color || ''].filter(Boolean).join(' · ') || 'One size',
                    price: money((parseFloat(product.price) || 0) + (parseFloat(deltas[size]) || 0)),
                    stock: parseInt(stock[id], 10) || 0
                });
            });
        });
        return out;
    };

    S.variant = function (product, size, color) {
        var id = S.variantId(product, size, color);
        return S.variants(product).filter(function (v) { return v.id === id; })[0] || null;
    };

    /** Price of one unit of a variant, including any per-size uplift. */
    S.unitPrice = function (product, size) {
        product = product || {};
        var deltas = product.priceDeltas || {};
        return money((parseFloat(product.price) || 0) + (parseFloat(deltas[size]) || 0));
    };

    S.totalStock = function (product) {
        return S.variants(product).reduce(function (s, v) { return s + v.stock; }, 0);
    };

    S.lowStockVariants = function (product, threshold) {
        var t = threshold == null ? 5 : threshold;
        return S.variants(product).filter(function (v) { return v.stock <= t; });
    };

    /**
     * Order totals.
     *
     * Discount can be a flat amount or a percentage; both are applied to the
     * subtotal, and the result is floored at zero so a generous discount can
     * never produce a negative charge. Tax is a rate (0.08875 style) applied
     * after the discount.
     */
    S.orderTotals = function (order, catalogue) {
        order = order || {};
        var byId = {};
        (catalogue || []).forEach(function (p) { if (p) byId[String(p.id)] = p; });

        var lines = (order.lines || []).map(function (l) {
            var p = byId[String(l.productId)] || null;
            var qty = Math.max(0, parseInt(l.qty, 10) || 0);
            // A line remembers its own unitPrice so an old order doesn't
            // silently re-price when the catalogue changes.
            var unit = (l.unitPrice != null) ? money(l.unitPrice) : (p ? S.unitPrice(p, l.size) : 0);
            return {
                productId: l.productId,
                name: l.name || (p ? p.name : 'Item'),
                size: l.size || '', color: l.color || '',
                qty: qty, unitPrice: unit, lineTotal: money(unit * qty),
                missing: !p
            };
        });

        var subtotal = money(lines.reduce(function (s, l) { return s + l.lineTotal; }, 0));
        var discount = 0;
        if (order.discountPct) discount += subtotal * (parseFloat(order.discountPct) || 0) / 100;
        if (order.discountAmt) discount += parseFloat(order.discountAmt) || 0;
        discount = money(Math.min(Math.max(0, discount), subtotal));
        var afterDiscount = money(subtotal - discount);
        var tax = money(afterDiscount * (parseFloat(order.taxRate) || 0));
        return {
            lines: lines,
            itemCount: lines.reduce(function (s, l) { return s + l.qty; }, 0),
            subtotal: subtotal,
            discount: discount,
            tax: tax,
            total: money(afterDiscount + tax)
        };
    };

    /**
     * Can this order be fulfilled from stock right now?
     *
     * Returns the shortfalls rather than a boolean, because the office needs to
     * know which line to substitute. Quantities are summed per variant first —
     * two lines of the same size must not each pass a check the pair fails.
     */
    S.checkStock = function (order, catalogue) {
        var byId = {};
        (catalogue || []).forEach(function (p) { if (p) byId[String(p.id)] = p; });
        var wanted = {};
        (order && order.lines || []).forEach(function (l) {
            var p = byId[String(l.productId)];
            if (!p) return;
            var vid = S.variantId(p, l.size, l.color);
            if (!wanted[vid]) wanted[vid] = { product: p, size: l.size, color: l.color, qty: 0 };
            wanted[vid].qty += Math.max(0, parseInt(l.qty, 10) || 0);
        });
        var short = [];
        Object.keys(wanted).forEach(function (vid) {
            var w = wanted[vid];
            var v = S.variant(w.product, w.size, w.color);
            var have = v ? v.stock : 0;
            if (w.qty > have) {
                short.push({
                    variantId: vid, name: w.product.name, size: w.size, color: w.color,
                    wanted: w.qty, available: have, shortBy: w.qty - have
                });
            }
        });
        return { ok: short.length === 0, shortfalls: short };
    };

    /**
     * Apply an order's quantities to stock. `direction` is -1 to fulfil, +1 to
     * return. Mutates nothing — hands back a new stock map for the caller to
     * store, so a failed save can't leave stock half-adjusted.
     */
    S.applyStock = function (product, order, direction) {
        var next = Object.assign({}, product.stock || {});
        (order && order.lines || []).forEach(function (l) {
            if (String(l.productId) !== String(product.id)) return;
            var vid = S.variantId(product, l.size, l.color);
            var qty = Math.max(0, parseInt(l.qty, 10) || 0);
            var cur = parseInt(next[vid], 10) || 0;
            next[vid] = Math.max(0, cur + direction * qty);
        });
        return next;
    };

    /**
     * How many of each size were ordered — the number a camp actually needs
     * when placing a print run. Optionally scoped to one product.
     */
    S.sizeBreakdown = function (orders, opts) {
        opts = opts || {};
        var counts = {};
        (orders || []).forEach(function (o) {
            if (!o || o.status === 'cancelled') return;
            (o.lines || []).forEach(function (l) {
                if (opts.productId && String(l.productId) !== String(opts.productId)) return;
                var size = l.size || 'One size';
                counts[size] = (counts[size] || 0) + Math.max(0, parseInt(l.qty, 10) || 0);
            });
        });
        // Ordered youth-to-adult, with anything unrecognised trailing.
        var known = S.SIZES.filter(function (s) { return counts[s]; })
            .map(function (s) { return { size: s, label: S.SIZE_LABELS[s] || s, qty: counts[s] }; });
        var extra = Object.keys(counts).filter(function (s) { return S.SIZES.indexOf(s) < 0; })
            .sort()
            .map(function (s) { return { size: s, label: s, qty: counts[s] }; });
        return known.concat(extra);
    };

    /** Units sold per product, best first. Cancelled orders don't count. */
    S.topSellers = function (orders, catalogue) {
        var byProduct = {};
        (orders || []).forEach(function (o) {
            if (!o || o.status === 'cancelled') return;
            (o.lines || []).forEach(function (l) {
                var k = String(l.productId);
                if (!byProduct[k]) byProduct[k] = { productId: l.productId, name: l.name || '', qty: 0, revenue: 0 };
                var qty = Math.max(0, parseInt(l.qty, 10) || 0);
                byProduct[k].qty += qty;
                byProduct[k].revenue = money(byProduct[k].revenue + qty * (parseFloat(l.unitPrice) || 0));
            });
        });
        (catalogue || []).forEach(function (p) {
            if (p && byProduct[String(p.id)]) byProduct[String(p.id)].name = p.name;
        });
        return Object.keys(byProduct).map(function (k) { return byProduct[k]; })
            .sort(function (a, b) { return b.qty - a.qty || String(a.name).localeCompare(String(b.name)); });
    };

    /**
     * The pick list, grouped by bunk — how the shop is actually handed out.
     * Orders with no bunk land under "Unassigned" rather than disappearing.
     */
    S.pickListByBunk = function (orders, opts) {
        opts = opts || {};
        var groups = {};
        (orders || []).forEach(function (o) {
            if (!o || o.status === 'cancelled') return;
            if (opts.status && o.status !== opts.status) return;
            var bunk = o.bunk || 'Unassigned';
            if (!groups[bunk]) groups[bunk] = { bunk: bunk, orders: [], items: 0 };
            groups[bunk].orders.push(o);
            groups[bunk].items += (o.lines || []).reduce(function (s, l) {
                return s + Math.max(0, parseInt(l.qty, 10) || 0);
            }, 0);
        });
        return Object.keys(groups).sort(function (a, b) {
            if (a === 'Unassigned') return 1;
            if (b === 'Unassigned') return -1;
            return a.localeCompare(b, undefined, { numeric: true });
        }).map(function (k) { return groups[k]; });
    };

    /** Revenue actually collected vs still owed. Cancelled orders are ignored. */
    S.revenue = function (orders, catalogue) {
        var collected = 0, outstanding = 0, count = 0;
        (orders || []).forEach(function (o) {
            if (!o || o.status === 'cancelled') return;
            count++;
            var t = S.orderTotals(o, catalogue);
            if (o.paid) collected = money(collected + t.total);
            else outstanding = money(outstanding + t.total);
        });
        return { collected: collected, outstanding: outstanding, total: money(collected + outstanding), orders: count };
    };

    if (typeof window !== 'undefined') window.ShopCore = S;
    if (typeof module !== 'undefined' && module.exports) module.exports = S;
})();
