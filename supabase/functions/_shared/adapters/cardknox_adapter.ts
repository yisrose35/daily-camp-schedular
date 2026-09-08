// =============================================================================
// _shared/adapters/cardknox_adapter.ts — BYOP reference implementation for
// Cardknox / Sola Payments, against their long-standing "xWeb" gateway API
// (the same API surface Cardknox and Sola Payments both run — Sola is
// Cardknox's own consumer-facing rebrand, confirmed via docs.solapayments.com
// this session).
//
// *** VERIFIED LIVE against a real Sola sandbox key (Campistry DEV account,
// 2026-09) — GATEWAY_URL is correct, request/response format fixed below.
// Field names (xKey, xCommand, xAmount, xToken, xRefNum, xResult, xError)
// were cross-checked against docs.solapayments.com's own Introduction page
// AND confirmed against a real response.
//
// The response format was the one thing gotten wrong initially: this
// adapter originally sent/received JSON, but a live test call came back
// as classic URL-encoded key=value pairs (e.g. "xResult=E&..."), the same
// legacy "xWeb" wire format Banquest/NMI uses — NOT JSON. Fixed below to
// POST x-www-form-urlencoded and parse the response the same way
// banquest_adapter.ts's postForm() already does.
//
// Credential shape (from payment_processor_catalog.credential_fields):
//   { apiKey: string }   -- Cardknox/Sola calls this "xKey" on their side.
//
// customerRef (as passed into charge()) is a Cardknox-issued PAYMENT TOKEN
// (their xToken, created via saveMethod() below from an iFields-issued
// token — iFields is Cardknox's own hosted tokenization component,
// client-side, never a raw card number, same PCI-scope-reduction role
// Stripe.js/Elements already plays for the existing Stripe flows).
// campistry_card_setup.html currently only implements the Collect.js
// (Banquest/NMI) side of the client-side tokenization page — an iFields
// variant for Cardknox is flagged in BYOP_SETUP.md as not yet built, since
// Banquest was the immediate priority (the actual at-risk camp uses it).
// =============================================================================
import type { ProcessorAdapter, ChargeResult, RefundResult, TestConnectionResult, SaveMethodResult } from "../processor_adapter.ts";

const GATEWAY_URL = "https://x1.cardknox.com/gateway";
const SOFTWARE_NAME = "Campistry";
const SOFTWARE_VERSION = "1.0";

async function post(fields: Record<string, string>): Promise<Record<string, string>> {
  const resp = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await resp.text();
  // Sola's xWeb gateway returns url-encoded key=value pairs, not JSON —
  // confirmed via a live sandbox response ("xResult=E&..."), same wire
  // format as the Banquest/NMI adapter's postForm().
  const parsed: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { parsed[k] = v; });
  return parsed;
}

function baseFields(apiKey: string): Record<string, string> {
  return {
    xKey: apiKey,
    xVersion: "4.5.9",
    xSoftwareName: SOFTWARE_NAME,
    xSoftwareVersion: SOFTWARE_VERSION,
  };
}

export const cardknoxAdapter: ProcessorAdapter = {
  key: "cardknox",

  async testConnection(credentials: Record<string, string>): Promise<TestConnectionResult> {
    const apiKey = credentials.apiKey;
    if (!apiKey) return { success: false, error: "Missing apiKey" };
    try {
      // Report:Transactions turned out not to be a valid xCommand on this
      // gateway's transaction endpoint (confirmed live: "Invalid xcommand:
      // Report:Transactions") — reporting likely lives on a separate
      // endpoint here, same split Banquest/NMI has (transact.php vs
      // query.php), which isn't confirmed. Rather than guess at another
      // endpoint, this uses cc:sale (already confirmed valid) with one of
      // Sola's own published sandbox test cards and their documented
      // always-decline trigger amount ($9.91, per docs.solapayments.com's
      // "Sandbox Account Testing Info and Triggers" section) — a clean
      // decline still proves the key/endpoint/format all work, since only a
      // genuinely authenticated, well-formed request would even reach that
      // trigger logic. No real card, no money moved either way.
      const xInvoice = "TEST-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const result = await post({
        ...baseFields(apiKey),
        xCommand: "cc:sale",
        xCardNum: "4444333322221111",
        xExp: "1230",
        xAmount: "9.91",
        xInvoice,
      });
      // 'A' (approved) or 'D' (declined — expected here) both mean the
      // gateway authenticated the key and actually processed the request.
      // Only 'E' (error — bad key, malformed request, etc.) is a real
      // connectivity failure.
      if (result.xResult === "E") {
        return { success: false, error: result.xError || "Gateway returned an error" };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  async saveMethod(
    credentials: Record<string, string>,
    token: string,
  ): Promise<SaveMethodResult> {
    const apiKey = credentials.apiKey;
    try {
      // An iFields-issued token is often already reusable directly per
      // Cardknox's own model, but cc:save explicitly converts it into a
      // long-lived vault token — the safer, explicit choice so this
      // adapter never depends on a temporary token outliving its expiry
      // between "save" and some later charge.
      const result = await post({
        ...baseFields(apiKey),
        xCommand: "cc:save",
        xToken: token,
      });
      if (result.xResult !== "A" || !result.xToken) {
        return { success: false, error: result.xError || "Could not save payment method", raw: result };
      }
      return { success: true, customerRef: result.xToken, raw: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  async charge(
    credentials: Record<string, string>,
    amountCents: number,
    customerRef: string,
    description: string,
  ): Promise<ChargeResult> {
    const apiKey = credentials.apiKey;
    try {
      // xInvoice must be unique PER CHARGE, not derived from the description —
      // Sola's duplicate-transaction filter blocks any transaction whose
      // Key+Card+Amount+Invoice match another within a 10-minute window
      // (docs.solapayments.com's own "Duplicate Handling" section). Two
      // genuinely different charges sharing a description and amount (e.g.
      // two autopay installments of the same amount, back to back) would
      // otherwise risk a false "Duplicate Transaction" decline.
      const xInvoice = "CI-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const result = await post({
        ...baseFields(apiKey),
        xCommand: "cc:sale",
        xAmount: (amountCents / 100).toFixed(2),
        xToken: customerRef,
        xInvoice,
      });
      if (result.xResult !== "A") {
        return { success: false, status: result.xStatus, error: result.xError || "Declined", raw: result };
      }
      return {
        success: true,
        externalTransactionId: result.xRefNum,
        status: result.xStatus,
        raw: result,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  async refund(
    credentials: Record<string, string>,
    externalTransactionId: string,
    amountCents: number,
  ): Promise<RefundResult> {
    const apiKey = credentials.apiKey;
    try {
      const result = await post({
        ...baseFields(apiKey),
        xCommand: "cc:refund",
        xRefNum: externalTransactionId,
        xAmount: (amountCents / 100).toFixed(2),
      });
      if (result.xResult !== "A") {
        return { success: false, status: result.xStatus, error: result.xError || "Refund failed", raw: result };
      }
      return {
        success: true,
        externalTransactionId: result.xRefNum,
        status: result.xStatus,
        raw: result,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};
