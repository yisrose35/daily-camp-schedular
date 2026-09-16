/* =============================================================================
 * campistry_card_capture.js — get a card accepted BEFORE the form is submitted.
 *
 * One module, both forms (registration and post-acceptance), because the rule
 * is the same in both places and two copies of it would drift.
 *
 * WHAT IT DOES
 *   Picking Credit Card or ACH offers a button. The button opens the camp's
 *   own processor -- framed in for Banquest, a popup window for Stripe and
 *   Cardknox/Sola. When the processor accepts the card, a tick appears next to
 *   the method; when it refuses, a cross and the reason. The host form asks
 *   `accepted()` before it lets anyone submit.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   Charge anything. Every path is a zero-amount "is this card good" check.
 *   The deposit is taken afterwards, server-side, for the amount the camp
 *   stamped on the saved application.
 *
 *   Touch a card number. Banquest's fields live inside Banquest's iframe
 *   inside campistry_card_setup.html; Stripe and Sola collect on their own
 *   pages. This file never sees a PAN and never will.
 *
 * WHY POLLING, NOT postMessage
 *   The popup is on the processor's origin, so it cannot talk to us, and
 *   whether a processor will even redirect back is per-processor (Sola answers
 *   by webhook and never returns anything to the browser). One mechanism that
 *   works for all three: the server mints a reference, every rail reports its
 *   verdict onto that row, and the form asks the row. A closed popup, a
 *   refreshed tab and a parent who wandered off all behave the same way.
 * ========================================================================== */
(function (global) {
    'use strict';

    var CC = {};

    // How long to keep asking. A parent typing a card with a bank app open on
    // their phone is slow; a spinner that gives up at 60 seconds is a bug
    // report. Ten minutes, then say so plainly rather than spinning forever.
    var POLL_MS = 2500;
    var POLL_LIMIT_MS = 10 * 60 * 1000;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
            return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
        });
    }

    function client() {
        return (global.CampistryDB && global.CampistryDB.getClient && global.CampistryDB.getClient()) ||
               (global.supabase && typeof global.supabase.rpc === 'function' ? global.supabase : null);
    }

    /**
     * One capture, bound to one form.
     *
     * opts: { el, campId, method, returnUrl, onChange }
     *   el        the container to draw into
     *   campId    which camp's processor to open
     *   method    'credit_card' | 'ach' — only affects wording
     *   returnUrl where a popup processor sends the parent back to
     *   onChange  called after every state change, so the host can re-check
     *             whether Submit should be enabled
     */
    CC.create = function (opts) {
        var o = opts || {};
        var state = {
            status: 'idle',   // idle | opening | waiting | accepted | refused | error
            // Set when the SERVER says this camp has no rail at all (no
            // processor connected, or one with no card entry here). That is
            // the only trustworthy answer to "can this camp take a card" --
            // it is the same code that would have to run the charge -- so the
            // host form uses it to decide whether to hold Submit, rather than
            // guessing from a separate lookup that may not even be deployed.
            unavailable: false,
            reference: null,
            processor: null,
            mode: null,
            last4: null,
            brand: null,
            error: null
        };
        var pollTimer = null, pollStarted = 0, popup = null;

        function changed() {
            render();
            try { if (o.onChange) o.onChange(snapshot()); } catch (e) { /* host's problem */ }
        }

        function snapshot() {
            return {
                accepted: state.status === 'accepted',
                unavailable: state.unavailable,
                status: state.status,
                reference: state.reference,
                processor: state.processor,
                last4: state.last4,
                brand: state.brand,
                error: state.error
            };
        }

        function stopPolling() {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }

        function startPolling() {
            stopPolling();
            pollStarted = Date.now();
            pollTimer = setInterval(function () {
                if (Date.now() - pollStarted > POLL_LIMIT_MS) {
                    stopPolling();
                    if (state.status === 'waiting') {
                        state.status = 'error';
                        state.error = 'We did not hear back from the payment page. Try again.';
                        changed();
                    }
                    return;
                }
                var c = client();
                if (!c || !c.rpc || !state.reference) return;
                c.rpc('get_card_capture_status', { p_reference: state.reference }).then(function (r) {
                    var d = r && r.data;
                    if (!d || !d.success) return;                 // still ours to wait for
                    if (d.status === 'completed') {
                        stopPolling();
                        state.status = 'accepted';
                        state.last4 = d.last4 || null;
                        state.brand = d.brand || null;
                        state.error = null;
                        try { if (popup && !popup.closed) popup.close(); } catch (e) { /* cross-origin */ }
                        changed();
                    } else if (d.status === 'failed') {
                        stopPolling();
                        state.status = 'refused';
                        state.error = d.error || 'The card was not accepted.';
                        changed();
                    }
                }).catch(function () { /* one missed poll is not a failure */ });
            }, POLL_MS);
        }

        function open() {
            var c = client();
            if (!c || !c.functions) {
                state.status = 'error';
                state.error = 'Could not reach the payment service. Try again.';
                return changed();
            }
            state.status = 'opening';
            state.error = null;
            changed();

            // OPENED FIRST, BEFORE THE AWAIT. A window.open() that happens
            // after a network round-trip is no longer "in a click" as far as
            // the browser is concerned, and every popup blocker eats it. So
            // the window is opened empty here and pointed at the processor
            // once we know the URL.
            var pending = null;
            try { pending = global.open('', 'campistry_card', 'width=520,height=760'); } catch (e) { pending = null; }

            c.functions.invoke('card-capture-start', {
                body: { campId: o.campId, returnUrl: o.returnUrl || (global.location.origin + '/campistry_pay_thanks.html') }
            }).then(function (r) {
                var d = r && r.data;
                if ((r && r.error) || !d || !d.success) {
                    if (pending) { try { pending.close(); } catch (e) {} }
                    // "This camp has no way to take a card" is a different
                    // answer from "that did not work" -- one is permanent and
                    // must release the form, the other is worth retrying.
                    var reason = d && d.reason;
                    state.unavailable = reason === 'no_processor'
                                     || reason === 'processor_unsupported'
                                     || reason === 'no_stripe_key'
                                     || reason === 'banquest_not_configured'
                                     || reason === 'cardknox_not_configured';
                    state.status = 'error';
                    state.error = (d && d.error) || 'Could not open card entry. Try again.';
                    return changed();
                }
                state.unavailable = false;
                state.reference = d.reference;
                state.processor = d.processor;
                state.mode = d.mode;

                if (d.mode === 'inline') {
                    // Our own framed card page; nothing to pop up.
                    if (pending) { try { pending.close(); } catch (e) {} }
                    state.status = 'waiting';
                    return changed();
                }

                popup = pending;
                if (popup) { try { popup.location.href = d.url; } catch (e) { popup = null; } }
                if (!popup) {
                    // Blocked. A link they can click themselves is better than
                    // a dead end, and it is the same URL.
                    state.status = 'waiting';
                    state.error = 'Your browser blocked the payment window.';
                    state.blockedUrl = d.url;
                    return changed();
                }
                state.status = 'waiting';
                changed();
                startPolling();
            }).catch(function () {
                if (pending) { try { pending.close(); } catch (e) {} }
                state.status = 'error';
                state.error = 'Could not open card entry. Try again.';
                changed();
            });
        }

        // Banquest only: the framed card page handed back a nonce, so ask the
        // gateway whether it is any good. This is the moment the tick is
        // earned -- not the moment the fields were filled in.
        function finishInline(token, card, billing) {
            var c = client();
            if (!c || !c.functions || !state.reference) return;
            state.status = 'opening';
            changed();
            c.functions.invoke('card-capture-start', {
                body: {
                    action: 'finish', campId: o.campId, reference: state.reference,
                    cardToken: token, card: card, billing: billing
                }
            }).then(function (r) {
                var d = r && r.data;
                if ((r && r.error) || !d || !d.success) {
                    state.status = 'error';
                    state.error = (d && d.error) || 'Could not check the card. Try again.';
                    return changed();
                }
                if (!d.accepted) {
                    state.status = 'refused';
                    state.error = d.error || 'The card was not accepted.';
                    return changed();
                }
                state.status = 'accepted';
                state.last4 = d.last4 || null;
                state.brand = d.brand || null;
                state.error = null;
                changed();
            }).catch(function () {
                state.status = 'error';
                state.error = 'Could not check the card. Try again.';
                changed();
            });
        }

        function reset() {
            stopPolling();
            state = { status: 'idle', unavailable: false, reference: null, processor: null,
                      mode: null, last4: null, brand: null, error: null };
            changed();
        }

        // ── drawing ─────────────────────────────────────────────────────────
        function setHtml(el, html) {
            if (!el || el.innerHTML === html) return;   // never rebuild a live iframe
            el.innerHTML = html;
        }

        function render() {
            var el = o.el;
            if (!el) return;
            var noun = o.method === 'ach' ? 'bank details' : 'card';

            if (state.status === 'accepted') {
                setHtml(el,
                    '<div class="cc-ok" style="display:flex;justify-content:space-between;align-items:center;gap:12px;' +
                    'flex-wrap:wrap;background:#ECFDF5;border:1px solid #A7F3D0;border-radius:8px;padding:12px 14px;margin-top:8px">' +
                    '<div style="display:flex;align-items:center;gap:9px;font-size:.87rem;color:#065F46;font-weight:700">' +
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">' +
                    '<polyline points="20 6 9 17 4 12"/></svg>' +
                    esc(state.brand || 'Card') + (state.last4 ? ' ending ' + esc(state.last4) : '') + ' — accepted</div>' +
                    '<button type="button" data-cc="reset" style="background:none;border:none;padding:0;font:inherit;' +
                    'font-size:.8rem;color:#0E7C4A;text-decoration:underline;cursor:pointer">Use a different ' + noun.split(' ')[0] + '</button></div>');
                return;
            }

            if (state.status === 'waiting' && state.mode === 'inline') {
                // The fields themselves. They are not ours: the card number
                // lives inside the processor's iframe inside that page.
                setHtml(el,
                    '<div style="border:1px solid #E2E8F0;border-radius:8px;padding:13px 14px;margin-top:8px">' +
                    '<iframe id="ccFrame" title="Card details" style="width:100%;height:340px;border:0;display:block" src="' +
                    esc('campistry_card_setup.html?campId=' + encodeURIComponent(o.campId) + '&mode=token&embed=1') + '"></iframe>' +
                    '</div>');
                return;
            }

            var busy = state.status === 'opening';
            var refused = state.status === 'refused';
            var problem = refused || state.status === 'error';

            // A camp with no rail at all gets no button: there is nothing
            // behind it, and Submit has already been released.
            if (state.unavailable) {
                setHtml(el,
                    '<div style="font-size:.82rem;color:#475569;line-height:1.6;margin-top:8px">' +
                    esc(state.error || 'This camp takes payment another way.') +
                    ' You can submit the form \u2014 they will be in touch.</div>');
                return;
            }

            setHtml(el,
                '<div style="margin-top:8px">' +
                '<button type="button" data-cc="open"' + (busy ? ' disabled' : '') +
                ' style="width:100%;background:' + (busy ? '#94A3B8' : '#147D91') + ';color:#fff;border:none;border-radius:9px;' +
                'padding:12px 14px;font:inherit;font-size:.9rem;font-weight:700;cursor:' + (busy ? 'default' : 'pointer') + '">' +
                (busy ? 'Opening…'
                     : state.status === 'waiting' ? 'Reopen the payment window'
                     : problem ? 'Try again'
                     : 'Enter ' + noun) + '</button>' +
                (state.status === 'waiting'
                    ? '<div style="font-size:.82rem;color:#475569;line-height:1.6;margin-top:8px">' +
                      'Finish on the payment page. This form will tick automatically when your ' + noun.split(' ')[0] +
                      ' is accepted — you can leave this tab open.' +
                      (state.blockedUrl ? ' <a href="' + esc(state.blockedUrl) + '" target="_blank" rel="noopener">Open it here</a>.' : '') +
                      '</div>'
                    : '') +
                (problem
                    ? '<div style="display:flex;align-items:flex-start;gap:8px;background:#FEF2F2;border:1px solid #FECACA;' +
                      'border-radius:8px;padding:10px 12px;margin-top:8px;font-size:.82rem;color:#991B1B;line-height:1.55">' +
                      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="flex:none;margin-top:1px">' +
                      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
                      '<span>' + esc(state.error || 'The card was not accepted.') + '</span></div>'
                    : '') +
                '</div>');
        }

        // One delegated listener rather than inline handlers, so this module
        // needs nothing on the host page's global scope.
        if (o.el) {
            o.el.addEventListener('click', function (ev) {
                var b = ev.target && ev.target.closest && ev.target.closest('[data-cc]');
                if (!b) return;
                ev.preventDefault();
                if (b.getAttribute('data-cc') === 'open') open();
                else if (b.getAttribute('data-cc') === 'reset') reset();
            });
        }

        // The framed card page (Banquest) hands the nonce back this way. Only
        // ever from the frame we created -- a message from anywhere else
        // claiming to carry a card is ignored.
        global.addEventListener('message', function (ev) {
            var d = ev && ev.data;
            if (!d || typeof d !== 'object') return;
            if (d.type !== 'campistry-card-token' && d.type !== 'campistry-card-height') return;
            var frame = o.el && o.el.querySelector('#ccFrame');
            if (!frame || ev.source !== frame.contentWindow) return;
            if (d.type === 'campistry-card-height') {
                var h = Number(d.height) || 0;
                if (h > 0) frame.style.height = Math.min(h, 900) + 'px';
                return;
            }
            if (!d.token) return;
            finishInline(d.token, d.card, d.billing);
        });

        return {
            open: open,
            reset: reset,
            render: render,
            state: snapshot,
            accepted: function () { return state.status === 'accepted'; },
            reference: function () { return state.reference; },
            setMethod: function (m) { o.method = m; render(); },
            destroy: function () { stopPolling(); if (o.el) o.el.innerHTML = ''; }
        };
    };

    global.CampistryCardCapture = CC;
})(typeof window !== 'undefined' ? window : this);
