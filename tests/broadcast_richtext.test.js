// node --test tests/broadcast_richtext.test.js
// Validates the broadcast composer's markup renderer:
//   • one source renders as HTML for email/portal and plain text for SMS
//   • pasted HTML can never reach a parent's inbox as markup
//   • colours come from a fixed palette, so no style injection
const test = require('node:test');
const assert = require('node:assert');
const C = require('../campistry_broadcast_core.js');

const html = m => C.renderBroadcastBody(m);
const text = m => C.broadcastPlainText(m);

test('bold, italic and strikethrough render as elements in HTML', () => {
    assert.strictEqual(html('**Bus is late**'), '<strong>Bus is late</strong>');
    assert.strictEqual(html('~~Cancelled~~'), '<s>Cancelled</s>');
    assert.strictEqual(html('the _early_ bus'), 'the <em>early</em> bus');
});

test('SMS keeps the words and drops every mark', () => {
    // Formatting is meaningless in a text message, but the words are not —
    // dropping the content along with the marks would change the meaning.
    assert.strictEqual(text('**Bus is late** and ~~cancelled~~ for the _early_ run'),
        'Bus is late and cancelled for the early run');
    assert.strictEqual(text('[color=red][size=huge]URGENT[/size][/color]'), 'URGENT');
});

test('a divider is its own line — a rule in HTML, dashes in SMS', () => {
    const out = html('Top\n---\nBottom');
    assert.ok(out.includes('<hr'), 'divider must render as a rule');
    assert.ok(out.startsWith('Top<br>') && out.endsWith('<br>Bottom'));

    assert.strictEqual(text('Top\n---\nBottom'), 'Top\n------------------------\nBottom');

    // Dashes inside a sentence are not a divider.
    assert.strictEqual(html('9 --- 10 buses'), '9 --- 10 buses');
    // Four or more dashes still count; extra spaces are tolerated.
    assert.ok(html('  ----  ').includes('<hr'));
});

test('pasted HTML is escaped and can never inject markup', () => {
    const out = html('<script>alert(1)</script> & "quotes"');
    assert.ok(!out.includes('<script'), 'a script tag must not survive');
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(out.includes('&amp;') && out.includes('&quot;'));

    // An <img onerror> paste is inert text, not an element.
    assert.ok(!html('<img src=x onerror=alert(1)>').includes('<img'));
});

test('size and colour resolve from a fixed palette only', () => {
    const big = html('[size=large]Field day[/size]');
    assert.ok(big.includes('font-size:1.25em') && big.includes('Field day'));

    const red = html('[color=red]Closed[/color]');
    assert.ok(red.includes('color:#DC2626') && red.includes('Closed'));

    // An unknown colour keeps the words and drops the tag — it must never
    // become free-form CSS.
    const bogus = html('[color=javascript]Hi[/color]');
    assert.strictEqual(bogus, 'Hi');

    // A tag carrying extra CSS doesn't match the pattern at all, so it never
    // reaches the style attribute — it survives as inert escaped text.
    const injected = html('[color=red;background:url(x)]Hi[/color]');
    assert.ok(!injected.includes('style='), 'no arbitrary CSS may reach a style attribute');
    assert.ok(injected.includes('Hi'), 'the message text still has to come through');
});

test('bold wins over italic where the markers overlap', () => {
    // Parsing _ first would turn **word** into *<em>*word*</em>*.
    assert.strictEqual(html('**bold**'), '<strong>bold</strong>');
    assert.strictEqual(html('**a _b_ c**'), '<strong>a <em>b</em> c</strong>');
});

test('underscores inside words are left alone', () => {
    // Route names and file names routinely contain them.
    assert.strictEqual(html('route_4_am is delayed'), 'route_4_am is delayed');
    assert.strictEqual(html('snake_case_name'), 'snake_case_name');
});

test('newlines become line breaks in HTML and survive in text', () => {
    assert.strictEqual(html('one\ntwo'), 'one<br>two');
    assert.strictEqual(text('one\ntwo'), 'one\ntwo');
    assert.strictEqual(html('one\r\ntwo'), 'one<br>two');
});

test('empty and missing input render as nothing rather than throwing', () => {
    for (const v of ['', null, undefined]) {
        assert.strictEqual(html(v), '');
        assert.strictEqual(text(v), '');
    }
});

test('an unclosed tag leaves the text readable instead of eating the message', () => {
    // A half-typed tag must not swallow the rest of the broadcast.
    assert.ok(html('[color=red]Closed for the day').includes('Closed for the day'));
    assert.ok(html('**not closed').includes('not closed'));
});

test('the email wrapper escapes the subject and carries inline styles', () => {
    const out = C.wrapBroadcastEmail('<strong>Hi</strong>', { subject: 'Bus <update>' });
    assert.ok(out.includes('&lt;update&gt;'), 'subject must be escaped');
    assert.ok(out.includes('font-family'), 'email clients strip <style>, so styles must be inline');
    assert.ok(out.includes('<strong>Hi</strong>'));
});

test('the toolbar palette is exactly what the renderer accepts', () => {
    const opts = C.richTextOptions();
    for (const size of opts.sizes) {
        assert.ok(html('[size=' + size + ']x[/size]').includes('font-size:'), size + ' must render');
    }
    for (const color of opts.colors) {
        assert.ok(html('[color=' + color + ']x[/color]').includes('color:#'), color + ' must render');
    }
});

test('merge tags still resolve after formatting is applied', () => {
    // Formatting must not break the existing merge-tag pass.
    const merged = C.applyMergeTags('**Hi {{parent_name}}**', { parentName: 'Dov' });
    assert.strictEqual(html(merged), '<strong>Hi Dov</strong>');
});
