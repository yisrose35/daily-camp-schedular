# Campistry Security Audit — Vulnerability Report

**Date:** March 2025  
**Scope:** Client-side (JS/HTML), Edge Function (send-invite-email), auth and data flow.

Findings are ranked: **Mild** | **Moderate** | **High-risk** | **Severe**.

---

## Severe

### 1. **Use of `eval()` — Code Injection**

| Field | Detail |
|-------|--------|
| **Location** | `rbac_integration.js` line 187 |
| **Code** | `eval(originalHandler);` where `originalHandler` comes from `generateBtn.getAttribute('onclick')` |
| **Risk** | If the Generate button’s `onclick` is ever set or tampered with (e.g. via DevTools or a DOM vulnerability), arbitrary JavaScript runs in the user’s session. `eval()` is unsafe by design. |
| **Recommendation** | Remove `eval()`. Call a known function by name (e.g. `window.generateSchedule`) or attach the handler with `addEventListener` and do not fall back to evaluating the original attribute string. |

---

## High-risk

### 2. **Hardcoded Demo Exit Password**

| Field | Detail |
|-------|--------|
| **Location** | `demo_mode.js` line 640 |
| **Code** | `const DEMO_EXIT_PASSWORD = 'JewishCamPExpo2026';` |
| **Risk** | Password is in client-side source. Anyone who views the script (or built assets) can exit demo mode or reuse the password elsewhere if it is shared. In production builds this is a high-risk information disclosure. |
| **Recommendation** | Remove hardcoded password. Use a server-side check, or a one-time code shown only to the operator, or disable demo exit in production. |

### 3. **Supabase Anon Key in Client Code**

| Field | Detail |
|-------|--------|
| **Location** | `supabase_client.js` lines 38–40 |
| **Code** | `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `CONFIG` |
| **Risk** | Anon key is public by design; real protection must come from Row Level Security (RLS). If RLS is misconfigured, the key could be used to access or modify data. Risk is “high” only if RLS is not fully and correctly enforced. |
| **Recommendation** | Confirm every table has correct RLS policies. Prefer env/build-time injection for the key so it’s not in repo history. Document that the anon key must never be used for server-side admin actions. |

### 4. **Role / Camp ID in localStorage — Client-Side Trust**

| Field | Detail |
|-------|--------|
| **Location** | `supabase_client.js`, `access_control.js`, `dashboard.js` — `localStorage.setItem('campistry_role'|'campistry_camp_id'|...)` and reads |
| **Risk** | Role and camp ID are cached in localStorage. Until DB verification runs, a tampered value could be used. You already have `verifyBeforeWrite()` and session cache; the remaining risk is a short window or a bug that uses cached role before verify. |
| **Recommendation** | Ensure no permission decision uses only localStorage; always go through a path that calls `verifyBeforeWrite()` (or equivalent) for writes. Prefer short TTL for session cache. |

---

## Moderate

### 5. **XSS — User Input in `innerHTML` (Camper Locator)**

| Field | Detail |
|-------|--------|
| **Location** | `camper_locator.js` lines 401, 447 |
| **Code** | `resultContainer.innerHTML = \`... "${nameQuery}" ...\`;` and `... "${timeValue}" ...` |
| **Risk** | `nameQuery` and `timeValue` come from the user (search/time input). If not escaped, e.g. `<img src=x onerror=alert(1)>`, script runs in the page. |
| **Recommendation** | Use `escapeHtml(nameQuery)` and `escapeHtml(timeValue)` (or `textContent` / safe helpers from `campistry_security.js`) before inserting into `innerHTML`. |

### 6. **XSS — Validation Modal Renders Unescaped Schedule Data**

| Field | Detail |
|-------|--------|
| **Location** | `validator.js` lines 829–841, 886, 931–937 |
| **Code** | `buildCategorySection(..., items, ...)` and `overlay.innerHTML = content`. List items are rendered as `${item}` without escaping. |
| **Risk** | `errors` and `warnings` include bunk names, division names, field names, activity names (from schedule data). That data is user-controlled. Unescaped insertion into `innerHTML` allows stored XSS when the validator is opened. |
| **Recommendation** | Escape every user-derived string before adding to `content`. In `buildCategorySection`, use e.g. `escapeHtml(item)` when building the `<li>` content. Use a shared `escapeHtml` (e.g. from `campistry_security.js`). |

### 7. **XSS — Dashboard Welcome Name**

| Field | Detail |
|-------|--------|
| **Location** | `dashboard.js` line 340 |
| **Code** | `welcomeTitle.innerHTML = \`Welcome back, <span>${displayName}</span>!\`;` |
| **Risk** | `displayName` can be camp name, user name, or email-derived. If any of these are attacker-controlled (e.g. camp name), HTML/script injection is possible. |
| **Recommendation** | Use `escapeHtml(displayName)` (or set `textContent` on a dedicated node) before putting it in the welcome message. |

### 8. **Email HTML Injection — Invite Edge Function**

| Field | Detail |
|-------|--------|
| **Location** | `supabase/functions/send-invite-email/index.ts` lines 24–31 |
| **Code** | `invitedBy`, `role`, `inviteUrl` interpolated into HTML: `<strong>${invitedBy}</strong>`, `<strong>${role}</strong>`, `href="${inviteUrl}"`, etc. |
| **Risk** | If `invitedBy` or `role` contain HTML/JS, the email body can be manipulated (e.g. fake links, phishing). `inviteUrl` could be a `javascript:` or malicious URL if not validated. |
| **Recommendation** | Sanitize/escape all interpolated values (HTML-escape for body; allowlist for `inviteUrl` scheme and domain). Validate and sanitize `email` and other fields. |

### 9. **Invite Token in URL**

| Field | Detail |
|-------|--------|
| **Location** | `invite.html?token=...`, `access_control.js` (invite URL construction), `invite.html` (loadInvite(token)) |
| **Risk** | Token in URL can leak via Referer, logs, or sharing. Anyone with the link can accept the invite until it’s used. |
| **Recommendation** | Keep tokens single-use (you clear on accept). Consider short expiry and rate limiting on `lookup_invite`. Avoid logging full token. |

### 10. **`document.write` for Script Loading**

| Field | Detail |
|-------|--------|
| **Location** | `dashboard.html` 274–276, `campistry_me.html` 1088–1090, `index.html` (similar pattern) |
| **Code** | `document.write('<script src="..."><\/script>');` |
| **Risk** | If the written URL or path were ever derived from user input, it could lead to script injection. Currently static. Also blocks parsing and can hurt performance. |
| **Recommendation** | Replace with a single `<script src="...">` in the HTML, or dynamic `createElement('script')` with a fixed URL. |

---

## Mild

### 11. **CORS `*` on Edge Function**

| Field | Detail |
|-------|--------|
| **Location** | `supabase/functions/send-invite-email/index.ts` — `Access-Control-Allow-Origin: '*'` |
| **Risk** | Any origin can call the function. Actual auth is via Bearer token; the main residual risk is that a malicious site could trigger requests if the user is logged in and the site can obtain a token (e.g. via another bug). |
| **Recommendation** | Restrict to your app origin(s), e.g. `https://your-app-domain.com`. |

### 12. **Scheduler / Orchestrator Notification Message**

| Field | Detail |
|-------|--------|
| **Location** | `schedule_orchestrator.js` line 161 |
| **Code** | `notification.innerHTML = \`<span>${icons[type] || ''}</span><span>${message}</span>\`;` |
| **Risk** | If `message` comes from API or user data and is not escaped, XSS is possible. |
| **Recommendation** | Ensure `message` is always escaped (e.g. `escapeHtml(message)`) or use `textContent` for the message node. |

### 13. **Alert / Confirm / Prompt with Dynamic Content**

| Field | Detail |
|-------|--------|
| **Location** | Multiple files (e.g. `unified_schedule_system.js`, `calendar.js`, `campistry_me.js`) — `alert(...)`, `confirm(...)`, `prompt(...)` with variables (bunk names, error messages, etc.) |
| **Risk** | `alert`/`confirm`/`prompt` render plain text, so no HTML execution. Risk is low; only UX and consistency (prefer in-app modals with escaped content). |
| **Recommendation** | Optional: replace with in-app modals (as in daily_adjustments) and still escape any user-derived strings. |

### 14. **Redirects to Fixed Paths**

| Field | Detail |
|-------|--------|
| **Location** | Various — `window.location.href = 'index.html'`, `'dashboard.html'`, etc. |
| **Risk** | All observed redirects use fixed strings; no open redirect found. |
| **Recommendation** | If you ever add redirects from query/fragment or config, validate with a safe redirect helper (e.g. `campistry_security.js`’s `isSafeRedirect`). |

### 15. **Clickjacking and Safe Redirect**

| Field | Detail |
|-------|--------|
| **Location** | `campistry_security.js` — clickjack detection and `isSafeRedirect` |
| **Risk** | You already mitigate clickjacking and validate redirects. |
| **Recommendation** | Ensure security script loads early on all pages. Consider `X-Frame-Options` or CSP `frame-ancestors` on the server. |

---

## Summary Table

| # | Severity   | Issue                          | File(s) / location                    |
|---|------------|----------------------------------|--------------------------------------|
| 1 | **Severe** | `eval()` use                    | `rbac_integration.js:187`            |
| 2 | **High**   | Hardcoded demo password         | `demo_mode.js:640`                   |
| 3 | **High**   | Anon key + RLS dependency       | `supabase_client.js:38–40`           |
| 4 | **High**   | Role/camp in localStorage        | Multiple (supabase_client, access_control, dashboard) |
| 5 | **Moderate** | XSS — Camper Locator          | `camper_locator.js:401, 447`         |
| 6 | **Moderate** | XSS — Validator modal         | `validator.js:829–886, 931`          |
| 7 | **Moderate** | XSS — Dashboard welcome       | `dashboard.js:340`                   |
| 8 | **Moderate** | Email HTML injection          | `supabase/functions/send-invite-email/index.ts` |
| 9 | **Moderate** | Invite token in URL           | `invite.html`, `access_control.js`   |
| 10 | **Moderate** | `document.write` script load | `dashboard.html`, `campistry_me.html`, `index.html` |
| 11 | **Mild**   | CORS `*` on edge function       | `send-invite-email/index.ts`         |
| 12 | **Mild**   | Orchestrator notification HTML  | `schedule_orchestrator.js:161`        |
| 13 | **Mild**   | alert/confirm/prompt content    | Various                               |
| 14 | **Mild**   | Redirects (no open redirect)    | Various                               |
| 15 | **Mild**   | Clickjacking / redirect helpers | `campistry_security.js`               |

---

## Positive Notes

- **Invite lookup**: Use of RPC `lookup_invite` instead of direct table read reduces exposure of invite data.
- **RBAC**: `verifyBeforeWrite()`, session cache with TTL, and DB verification limit role escalation.
- **Security module**: XSS helpers, CSRF token, rate limiting, safe redirect, and localStorage checks are present in `campistry_security.js`.
- **access_control.js**: Cache validation uses `hasOwnProperty` to reduce prototype pollution risk.

Addressing the **Severe** and **High** items first, then **Moderate** (especially XSS and email injection), will materially improve security posture.
