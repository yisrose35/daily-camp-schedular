// =============================================================================
// campistry_link_branding.js — message + email branding for Campistry Link
//
// Owns ONE thing: turning a camp's branding settings plus a subject/body into
// the markup that actually goes out — the admin preview, the in-app message
// card, and the HTML email. Before this module the admin preview built its own
// inline markup and the email channel shipped a bare text body, so what the
// office saw and what the parent received were two different things.
//
// The branding model (stored at CampistryLink store → settings.branding):
//   logo        data: URL, shown in the header bar
//   brandColor  header bar colour
//   footer      signature block under the message
//   header      'bar' | 'plain' | 'none'
//   watermark { enabled, source, image, text, opacity, size, position,
//               rotate, rendered }
//
// WATERMARK + EMAIL. Email clients do not honour `opacity` on an element and
// most strip absolutely-positioned overlays, so a watermark can't be faded at
// render time. Instead we pre-composite it: renderWatermark() paints the source
// image (or text) onto a canvas at the chosen opacity and stores the flattened
// PNG in watermark.rendered. Every surface then just references that image —
// as a CSS background on the message body, which Apple Mail, Gmail (web + iOS),
// Yahoo and Thunderbird all render. Outlook for Windows drops background
// images on non-body elements; it degrades to a clean unwatermarked message,
// which is the right failure mode.
//
// Exposed as window.LinkBranding (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var LinkBranding = {};

    var DEFAULT_COLOR = '#2A7A35';

    // Only raster data URLs. An SVG data URL can carry <script>, and these
    // strings get interpolated straight into markup.
    function isSafeImage(s) {
        return typeof s === 'string' &&
            /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
    }
    LinkBranding.isSafeImage = isSafeImage;

    function isColor(s) { return typeof s === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    LinkBranding.esc = esc;

    function clamp(n, lo, hi, dflt) {
        n = parseFloat(n);
        if (!isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }

    // ── model ────────────────────────────────────────────────────────────────
    var DEFAULT_WATERMARK = {
        enabled: false,
        source: 'logo',      // 'logo' | 'custom' | 'text'
        image: '',           // used when source === 'custom'
        text: '',            // used when source === 'text'
        opacity: 0.08,
        size: 55,            // % of the message width
        position: 'center',  // 'center' | 'tile' | 'corner'
        rotate: -24,
        rendered: ''         // pre-faded PNG produced by renderWatermark()
    };

    LinkBranding.defaults = function () {
        return {
            logo: '', brandColor: DEFAULT_COLOR, footer: '', header: 'bar',
            watermark: JSON.parse(JSON.stringify(DEFAULT_WATERMARK))
        };
    };

    /** Fill in every field and drop anything unsafe. Always returns a fresh object. */
    LinkBranding.normalize = function (raw) {
        var b = (raw && typeof raw === 'object') ? raw : {};
        var w = (b.watermark && typeof b.watermark === 'object') ? b.watermark : {};
        var source = (w.source === 'custom' || w.source === 'text') ? w.source : 'logo';
        return {
            logo: isSafeImage(b.logo) ? b.logo : '',
            brandColor: isColor(b.brandColor) ? b.brandColor : DEFAULT_COLOR,
            footer: typeof b.footer === 'string' ? b.footer : '',
            header: (b.header === 'plain' || b.header === 'none') ? b.header : 'bar',
            watermark: {
                enabled: !!w.enabled,
                source: source,
                image: isSafeImage(w.image) ? w.image : '',
                text: typeof w.text === 'string' ? w.text.slice(0, 60) : '',
                opacity: clamp(w.opacity, 0.02, 0.45, DEFAULT_WATERMARK.opacity),
                size: Math.round(clamp(w.size, 15, 100, DEFAULT_WATERMARK.size)),
                position: (w.position === 'tile' || w.position === 'corner') ? w.position : 'center',
                rotate: Math.round(clamp(w.rotate, -90, 90, DEFAULT_WATERMARK.rotate)),
                rendered: isSafeImage(w.rendered) ? w.rendered : ''
            }
        };
    };

    /**
     * The un-faded source image the watermark is built from — the custom upload
     * when there is one, otherwise the camp logo. Text watermarks have no
     * source image; they're painted from scratch by renderWatermark().
     */
    LinkBranding.watermarkSource = function (branding) {
        var b = LinkBranding.normalize(branding);
        if (!b.watermark.enabled) return '';
        if (b.watermark.source === 'custom') return b.watermark.image;
        if (b.watermark.source === 'text') return '';
        return b.logo;
    };

    /** True when this branding has everything it needs to paint a watermark. */
    LinkBranding.hasWatermark = function (branding) {
        var b = LinkBranding.normalize(branding);
        if (!b.watermark.enabled) return false;
        if (b.watermark.rendered) return true;
        if (b.watermark.source === 'text') return !!b.watermark.text.trim();
        return !!LinkBranding.watermarkSource(b);
    };

    // ── CSS for the watermark layer ──────────────────────────────────────────
    // Returns the style declarations to drop on the element that holds the
    // message body. Empty string when there's nothing to paint.
    LinkBranding.watermarkStyle = function (branding) {
        var b = LinkBranding.normalize(branding);
        if (!b.watermark.enabled) return '';
        var img = b.watermark.rendered || LinkBranding.watermarkSource(b);
        if (!isSafeImage(img)) return '';
        var w = b.watermark;
        var css = 'background-image:url(' + img + ');';
        if (w.position === 'tile') {
            css += 'background-repeat:repeat;background-position:center;' +
                   'background-size:' + Math.max(12, Math.round(w.size / 2)) + '% auto;';
        } else if (w.position === 'corner') {
            css += 'background-repeat:no-repeat;background-position:right bottom;' +
                   'background-size:' + w.size + '% auto;';
        } else {
            css += 'background-repeat:no-repeat;background-position:center center;' +
                   'background-size:' + w.size + '% auto;';
        }
        return css;
    };

    // ── shared pieces ────────────────────────────────────────────────────────
    function headerHtml(b, campName, opts) {
        if (b.header === 'none') return '';
        var logo = isSafeImage(b.logo)
            ? '<img src="' + b.logo + '" alt="" width="' + (opts.logoWidth || 150) + '" ' +
              'style="max-height:' + (opts.logoHeight || 46) + 'px;max-width:' + (opts.logoWidth || 150) +
              'px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto 6px;border:0;">'
            : '';
        if (b.header === 'plain') {
            return '<div style="padding:14px 0 10px;text-align:center;border-bottom:2px solid ' + b.brandColor + ';">' +
                logo +
                '<div style="font-weight:700;font-size:15px;color:' + b.brandColor + ';">' + esc(campName) + '</div>' +
                '</div>';
        }
        return '<div style="background:' + b.brandColor + ';padding:14px 18px;text-align:center;">' +
            logo +
            '<div style="font-weight:700;font-size:15px;color:#ffffff;letter-spacing:.01em;">' + esc(campName) + '</div>' +
            '</div>';
    }

    function footerHtml(b) {
        if (!b.footer) return '';
        return '<div style="margin-top:18px;padding-top:12px;border-top:1px solid #e2e8f0;' +
            'font-size:12px;line-height:1.55;color:#64748b;white-space:pre-wrap;">' + esc(b.footer) + '</div>';
    }

    // ── full HTML email ──────────────────────────────────────────────────────
    /**
     * A standalone, email-client-safe HTML document.
     *
     * @param {object} o
     *   subject   string  — rendered above the body (merge tags already applied)
     *   body      string  — plain text; newlines preserved
     *   branding  object  — raw or normalized branding
     *   campName  string
     *   ctaText / ctaUrl  optional button under the message
     *   preheader string  — hidden inbox-preview line
     */
    LinkBranding.buildEmailHtml = function (o) {
        o = o || {};
        var b = LinkBranding.normalize(o.branding);
        var campName = o.campName || 'Camp';
        var wm = LinkBranding.watermarkStyle(b);
        var bodyBg = wm ? ('background-color:#ffffff;' + wm) : 'background-color:#ffffff;';

        var preheader = o.preheader || (o.body || '').replace(/\s+/g, ' ').slice(0, 110);
        var cta = (o.ctaText && o.ctaUrl)
            ? '<div style="margin-top:20px;"><a href="' + esc(o.ctaUrl) + '" ' +
              'style="display:inline-block;background:' + b.brandColor + ';color:#ffffff;text-decoration:none;' +
              'font-weight:600;font-size:14px;padding:11px 22px;border-radius:8px;">' + esc(o.ctaText) + '</a></div>'
            : '';

        return '<!DOCTYPE html>\n' +
            '<html><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>' + esc(o.subject || campName) + '</title></head>' +
            '<body style="margin:0;padding:0;background:#f1f5f9;">' +
            '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(preheader) + '</div>' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">' +
            '<tr><td align="center" style="padding:22px 12px;">' +
            '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ' +
            'style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;' +
            'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
            '<tr><td>' + headerHtml(b, campName, { logoWidth: 170, logoHeight: 52 }) + '</td></tr>' +
            '<tr><td style="' + bodyBg + 'padding:26px 28px 30px;">' +
            (o.subject ? '<div style="font-size:17px;font-weight:700;color:#0f172a;margin:0 0 12px;">' + esc(o.subject) + '</div>' : '') +
            '<div style="font-size:14.5px;line-height:1.65;color:#334155;white-space:pre-wrap;">' + esc(o.body || '') + '</div>' +
            cta +
            footerHtml(b) +
            '</td></tr>' +
            '<tr><td style="padding:14px 20px;background:#f8fafc;text-align:center;font-size:11px;color:#94a3b8;">' +
            'Sent by ' + esc(campName) + ' via Campistry Link' +
            '</td></tr>' +
            '</table></td></tr></table></body></html>';
    };

    /** Plain-text alternative part, so the email isn't HTML-only. */
    LinkBranding.buildEmailText = function (o) {
        o = o || {};
        var b = LinkBranding.normalize(o.branding);
        var lines = [];
        if (o.campName) lines.push(o.campName, '');
        if (o.subject) lines.push(o.subject, '');
        lines.push(o.body || '');
        if (o.ctaText && o.ctaUrl) lines.push('', o.ctaText + ': ' + o.ctaUrl);
        if (b.footer) lines.push('', '—', b.footer);
        return lines.join('\n');
    };

    // ── in-admin preview fragment ────────────────────────────────────────────
    /**
     * The same message rendered for the compose drawer. `variant` picks the
     * surface being simulated: 'email' | 'app' | 'sms'.
     */
    LinkBranding.buildPreviewHtml = function (o) {
        o = o || {};
        var variant = o.variant || 'email';
        var b = LinkBranding.normalize(o.branding);
        var campName = o.campName || 'Camp';

        if (variant === 'sms') {
            var sms = (o.campName ? campName + ': ' : '') + (o.body || '');
            return '<div style="background:#eef2f7;padding:14px;border-radius:10px;">' +
                '<div style="max-width:290px;background:#3b82f6;color:#fff;border-radius:16px 16px 16px 4px;' +
                'padding:9px 13px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;">' + esc(sms) + '</div>' +
                '<div style="font-size:11px;color:#64748b;margin-top:6px;">' +
                sms.length + ' characters · ' + Math.max(1, Math.ceil(sms.length / 160)) + ' segment(s)</div></div>';
        }

        var wm = LinkBranding.watermarkStyle(b);
        var shell = variant === 'app'
            ? 'border-radius:14px;border:1px solid #e2e8f0;max-width:380px;margin:0 auto;'
            : 'border-radius:10px;border:1px solid #e2e8f0;';

        return '<div style="background:#ffffff;overflow:hidden;' + shell + '">' +
            headerHtml(b, campName, { logoWidth: 140, logoHeight: 40 }) +
            '<div style="' + (wm ? wm : '') + 'padding:16px 18px 20px;">' +
            (o.subject ? '<div style="font-size:14px;font-weight:700;color:#0f172a;margin:0 0 8px;">' + esc(o.subject) + '</div>' : '') +
            '<div style="font-size:13px;line-height:1.6;color:#334155;white-space:pre-wrap;">' + esc(o.body || '') + '</div>' +
            footerHtml(b) +
            '</div></div>';
    };

    // ── watermark compositing (browser only) ─────────────────────────────────
    /**
     * Paint the watermark source at `opacity` onto a transparent canvas and
     * hand back a flattened PNG data URL. This is what makes the watermark
     * survive email clients — they never have to apply opacity themselves.
     *
     * Resolves to '' when there's nothing to draw (or when called off-browser).
     */
    LinkBranding.renderWatermark = function (branding) {
        var b = LinkBranding.normalize(branding);
        var w = b.watermark;
        var noop = function () { return Promise.resolve(''); };
        if (!w.enabled) return noop();
        if (typeof document === 'undefined' || !document.createElement) return noop();

        var MAX = 900; // plenty for a 600px-wide email at 1.5x

        function paint(draw, width, height) {
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(width));
            c.height = Math.max(1, Math.round(height));
            var ctx = c.getContext('2d');
            if (!ctx) return '';
            ctx.globalAlpha = w.opacity;
            if (w.rotate) {
                ctx.translate(c.width / 2, c.height / 2);
                ctx.rotate(w.rotate * Math.PI / 180);
                ctx.translate(-c.width / 2, -c.height / 2);
            }
            draw(ctx, c);
            return c.toDataURL('image/png');
        }

        if (w.source === 'text') {
            var text = (w.text || '').trim();
            if (!text) return noop();
            return Promise.resolve(paint(function (ctx, c) {
                var size = Math.round(c.height * 0.42);
                ctx.font = '700 ' + size + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
                ctx.fillStyle = isColor(b.brandColor) ? b.brandColor : DEFAULT_COLOR;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, c.width / 2, c.height / 2);
            }, Math.min(MAX, Math.max(240, text.length * 34)), 200));
        }

        var src = LinkBranding.watermarkSource(b);
        if (!isSafeImage(src)) return noop();

        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                // Rotation needs headroom or the corners clip. Grow the canvas
                // by the rotated bounding box of the source.
                var rad = Math.abs(w.rotate * Math.PI / 180);
                var iw = img.naturalWidth || img.width || 300;
                var ih = img.naturalHeight || img.height || 300;
                var scale = Math.min(1, MAX / Math.max(iw, ih));
                iw = iw * scale; ih = ih * scale;
                var cw = iw * Math.cos(rad) + ih * Math.sin(rad);
                var ch = iw * Math.sin(rad) + ih * Math.cos(rad);
                resolve(paint(function (ctx, c) {
                    ctx.drawImage(img, (c.width - iw) / 2, (c.height - ih) / 2, iw, ih);
                }, cw, ch));
            };
            img.onerror = function () { resolve(''); };
            img.src = src;
        });
    };

    if (typeof window !== 'undefined') window.LinkBranding = LinkBranding;
    if (typeof module !== 'undefined' && module.exports) module.exports = LinkBranding;
})();
