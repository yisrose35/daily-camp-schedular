// node --test tests/link_branding.test.js
// Validates the Campistry Link branding/watermark renderer:
//   • the branding model normalizes (and sanitizes) every field
//   • the watermark CSS layer is only emitted when there's something to paint
//   • the HTML email is escaped, branded, and carries the watermark
const test = require('node:test');
const assert = require('node:assert');
const LB = require('../campistry_link_branding.js');

// A 1x1 transparent PNG — the smallest thing that passes the safe-image test.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('isSafeImage accepts raster data URLs and rejects SVG / remote URLs', () => {
    assert.ok(LB.isSafeImage(PNG));
    assert.ok(!LB.isSafeImage('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg=='));
    assert.ok(!LB.isSafeImage('https://example.com/logo.png'));
    assert.ok(!LB.isSafeImage('javascript:alert(1)'));
    assert.ok(!LB.isSafeImage(null));
});

test('normalize fills defaults and drops unsafe values', () => {
    const b = LB.normalize({ logo: 'https://evil.example/x.png', brandColor: 'red; }', footer: 'Bye' });
    assert.strictEqual(b.logo, '');                 // remote URL rejected
    assert.strictEqual(b.brandColor, '#2A7A35');    // non-hex rejected
    assert.strictEqual(b.footer, 'Bye');
    assert.strictEqual(b.header, 'bar');
    assert.strictEqual(b.watermark.enabled, false);
    assert.strictEqual(b.watermark.source, 'logo');
});

test('normalize clamps watermark opacity, size and rotation into range', () => {
    const b = LB.normalize({ watermark: { enabled: true, opacity: 9, size: 500, rotate: -400 } });
    assert.strictEqual(b.watermark.opacity, 0.45);
    assert.strictEqual(b.watermark.size, 100);
    assert.strictEqual(b.watermark.rotate, -90);

    const c = LB.normalize({ watermark: { enabled: true, opacity: -1, size: 0, rotate: 999 } });
    assert.strictEqual(c.watermark.opacity, 0.02);
    assert.strictEqual(c.watermark.size, 15);
    assert.strictEqual(c.watermark.rotate, 90);
});

test('normalize never mutates or aliases the input', () => {
    const raw = { footer: 'x', watermark: { enabled: true } };
    const b = LB.normalize(raw);
    b.footer = 'changed';
    b.watermark.enabled = false;
    assert.strictEqual(raw.footer, 'x');
    assert.strictEqual(raw.watermark.enabled, true);
});

test('watermarkSource follows the chosen source', () => {
    const other = PNG.replace('iVBORw0', 'iVBORw1');
    assert.strictEqual(LB.watermarkSource({ logo: PNG, watermark: { enabled: true, source: 'logo' } }), PNG);
    assert.strictEqual(LB.watermarkSource({ logo: PNG, watermark: { enabled: true, source: 'custom', image: other } }), other);
    assert.strictEqual(LB.watermarkSource({ logo: PNG, watermark: { enabled: true, source: 'text', text: 'DRAFT' } }), '');
    // Disabled means no source at all, even with a logo on file.
    assert.strictEqual(LB.watermarkSource({ logo: PNG, watermark: { enabled: false, source: 'logo' } }), '');
});

test('watermarkStyle is empty unless the watermark is on AND has an image', () => {
    assert.strictEqual(LB.watermarkStyle({ logo: PNG }), '');
    assert.strictEqual(LB.watermarkStyle({ watermark: { enabled: true, source: 'logo' } }), '');
    const css = LB.watermarkStyle({ logo: PNG, watermark: { enabled: true, source: 'logo', size: 40 } });
    assert.ok(css.includes('background-image:url(' + PNG + ')'));
    assert.ok(css.includes('background-size:40% auto'));
    assert.ok(css.includes('background-repeat:no-repeat'));
});

test('watermarkStyle: tile repeats and halves the size, corner pins bottom-right', () => {
    const tile = LB.watermarkStyle({ logo: PNG, watermark: { enabled: true, position: 'tile', size: 60 } });
    assert.ok(tile.includes('background-repeat:repeat'));
    assert.ok(tile.includes('background-size:30% auto'));

    const corner = LB.watermarkStyle({ logo: PNG, watermark: { enabled: true, position: 'corner' } });
    assert.ok(corner.includes('background-position:right bottom'));
});

test('watermarkStyle prefers the pre-faded render over the raw source', () => {
    const rendered = PNG.replace('iVBORw0', 'iVBORw2');
    const css = LB.watermarkStyle({ logo: PNG, watermark: { enabled: true, source: 'logo', rendered: rendered } });
    assert.ok(css.includes(rendered));
    assert.ok(!css.includes('url(' + PNG + ')'));
});

test('hasWatermark: text watermarks need text, image watermarks need an image', () => {
    assert.ok(!LB.hasWatermark({ watermark: { enabled: true, source: 'text', text: '   ' } }));
    assert.ok(LB.hasWatermark({ watermark: { enabled: true, source: 'text', text: 'DRAFT' } }));
    assert.ok(!LB.hasWatermark({ watermark: { enabled: true, source: 'custom' } }));
    assert.ok(LB.hasWatermark({ watermark: { enabled: true, source: 'custom', image: PNG } }));
});

test('buildEmailHtml: subject and body are HTML-escaped, never injected raw', () => {
    const html = LB.buildEmailHtml({
        subject: '<script>alert(1)</script>',
        body: 'Tom & Jerry <b>bold</b>',
        campName: 'Camp "Quotes" & Co',
        branding: {}
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt;'));
    assert.ok(html.includes('Camp &quot;Quotes&quot; &amp; Co'));
});

test('buildEmailHtml: brand colour, logo and footer all reach the document', () => {
    const html = LB.buildEmailHtml({
        subject: 'Hi', body: 'Body', campName: 'Camp Ruach',
        branding: { logo: PNG, brandColor: '#123456', footer: 'The Office' }
    });
    assert.ok(html.includes('#123456'));
    assert.ok(html.includes('src="' + PNG + '"'));
    assert.ok(html.includes('The Office'));
    assert.ok(html.startsWith('<!DOCTYPE html>'));
});

test('buildEmailHtml: watermark rides on the message body cell', () => {
    const off = LB.buildEmailHtml({ body: 'x', branding: { logo: PNG } });
    assert.ok(!off.includes('background-image'));

    const on = LB.buildEmailHtml({ body: 'x', branding: { logo: PNG, watermark: { enabled: true } } });
    assert.ok(on.includes('background-image:url(' + PNG + ')'));
});

test('buildEmailHtml: header style none drops the header entirely', () => {
    const html = LB.buildEmailHtml({ body: 'x', campName: 'Camp Ruach', branding: { header: 'none', logo: PNG } });
    assert.ok(!html.includes('src="' + PNG + '"'));
    // The camp name still appears in the trailing "sent by" line.
    assert.ok(html.includes('Sent by Camp Ruach'));
});

test('buildEmailText: plain-text part carries subject, body and footer', () => {
    const txt = LB.buildEmailText({
        subject: 'Visiting Day', body: 'Gates open at 10.', campName: 'Camp Ruach',
        branding: { footer: 'The Office' }
    });
    assert.ok(txt.includes('Camp Ruach'));
    assert.ok(txt.includes('Visiting Day'));
    assert.ok(txt.includes('Gates open at 10.'));
    assert.ok(txt.includes('The Office'));
    assert.ok(!txt.includes('<'));
});

test('buildPreviewHtml: sms variant prefixes the camp name and counts segments', () => {
    const html = LB.buildPreviewHtml({ variant: 'sms', body: 'A'.repeat(170), campName: 'Camp Ruach' });
    assert.ok(html.includes('Camp Ruach:'));
    assert.ok(html.includes('2 segment(s)'));
});

test('buildPreviewHtml: app and email variants both escape and both watermark', () => {
    const brand = { logo: PNG, watermark: { enabled: true } };
    ['app', 'email'].forEach(v => {
        const html = LB.buildPreviewHtml({ variant: v, subject: '<x>', body: '&y', branding: brand });
        assert.ok(html.includes('&lt;x&gt;'), v + ': subject escaped');
        assert.ok(html.includes('&amp;y'), v + ': body escaped');
        assert.ok(html.includes('background-image'), v + ': watermark painted');
    });
});

test('renderWatermark resolves to empty string outside a browser', async () => {
    const out = await LB.renderWatermark({ logo: PNG, watermark: { enabled: true } });
    assert.strictEqual(out, '');
});
