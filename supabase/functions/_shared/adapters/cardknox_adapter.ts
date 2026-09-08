// =============================================================================
// _shared/adapters/cardknox_adapter.ts — BYOP reference implementation for
// Cardknox / Sola Payments, against their long-standing "xWeb" gateway API
// (the same API surface Cardknox and Sola Payments both run — Sola is
// Cardknox's own consumer-facing rebrand, confirmed via docs.solapayments.com
// this session).
//
// *** NOT YET VERIFIED AGAINST A LIVE SANDBOX — READ BEFORE ENABLING FOR A
// REAL CAMP ***
// Field names (xKey, xCommand, xAmount, xToken, xRefNum, xResult, xError)
// were cross-checked directly against docs.solapayments.com's own
// Introduction page (pasted into this session) — xResult/xRefNum/xToken/
// xError/cc:sale/cc:refund/cc:save all match Sola's documented gateway
// fields exactly, so the field shape itself is confirmed, not guessed.
// What's still unconfirmed: whether GATEWAY_URL below (the long-standing
// x1.cardknox.com/gateway endpoint) is still the right one to hit under
// the Sola brand, vs. a distinct endpoint documented on
// docs.solapayments.com/api/transaction (not fetched this session) — check
// that page, or ask Sola support directly, before running testConnection()
// against a real sandbox key. This environment has no Cardknox/Sola
// developer credentials to test against directly (same category of
// limitation as everywhere else in this codebase that a Dashboard/vendor-
// portal walkthrough is handed to the user instead of run directly).
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

async function post(body: Record<string, string>): Promise<Record<string, any>> {
  const resp = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
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
      // Report:Transactions is a read-only reporting call — proves the key
      // authenticates without moving any money, the correct shape for a
      // connectivity test. A tiny (same-day) window keeps the response small.
      const today = new Date().toISOString().slice(0, 10);
      const result = await post({
        ...baseFields(apiKey),
        xCommand: "Report:Transactions",
        xStartDate: today,
        xEndDate: today,
      });
      if (result.xError) return { success: false, error: String(result.xError) };
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
