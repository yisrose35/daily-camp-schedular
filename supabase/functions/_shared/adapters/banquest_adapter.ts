// =============================================================================
// _shared/adapters/banquest_adapter.ts — BYOP adapter for Banquest.
//
// Banquest runs on the AffiniPay / 8am gateway (docs.banquestgateway.com/api/v2,
// developers.8am.com) — a JSON REST API. It is NOT a white-label NMI reseller
// (an earlier version of this file wrongly assumed that; corrected against a
// live sandbox, Sep 2026).
//
// NOTE ON DEPLOYMENT: the live code paths do NOT import this adapter — this
// project deploys edge functions by pasting one file into the Supabase
// Dashboard (no CLI, see CLAUDE.md), so a "../_shared" import can't bundle.
// Every Banquest call is therefore INLINED into the self-contained functions
// (admin-connect-processor, payments-save-method, charge-saved-card,
// charge-due-installments, canteen-auto-reload, payments-refund,
// payments-canteen-refund). This file is the canonical reference those inlined
// copies are kept in sync with (and what the _shared dispatchers would use if
// they were ever CLI-deployed).
//
// API shape (confirmed against the Banquest API v2 documentation, Sep 2026):
//   Base URL:  https://api.sandbox.banquestgateway.com/api/v2 (sandbox) /
//              https://api.banquestgateway.com/api/v2 (prod) — stored per-camp
//              as `gatewayUrl` since it differs by environment. The v2 API
//              always lives under /api/v2; baseUrl() appends it when the stored
//              value is a bare host.
//   Auth:      HTTP Basic, base64(sourceKey:pin).
//   Amounts:   DOLLARS (decimal), e.g. 5.00 — NOT cents.
//   Charge:    POST /transactions/charge { amount, source }
//   Verify:    POST /transactions/verify { source, save_card? } → card_ref, last_4
//   Reversal:  POST /transactions/reversal { reference_number, amount? }
//              (auto-picks refund for settled / void for unsettled)
//   Approval:  status_code === "A" (status === "Approved"). The transaction's
//              integer `reference_number` is the id to store and to later
//              refund/reverse by (NOT a "ref-" source string).
//   `source` prefixes: nonce-<hosted-tokenizer nonce>, tkn-<saved card_ref>,
//              pm-<payment method>, ref-<previous transaction's card>.
//
// Credential shape (payment_processor_catalog.credential_fields, migration 146):
//   { sourceKey, pin, tokenizationKey, gatewayUrl?, tokenizationUrl? }
//
// customerRef (as passed into charge()) is a Banquest `card_ref` from
// saveMethod(), charged as source "tkn-<card_ref>".
// =============================================================================
import type { ProcessorAdapter, ChargeResult, RefundResult, TestConnectionResult, SaveMethodResult } from "../processor_adapter.ts";

const DEFAULT_BASE_URL = "https://api.banquestgateway.com/api/v2";

function baseUrl(credentials: Record<string, string>): string {
  let b = (credentials.gatewayUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/\/(api\/)?v\d+$/i.test(b)) b += "/api/v2";
  return b;
}

function authHeader(credentials: Record<string, string>): string {
  return "Basic " + btoa(`${credentials.sourceKey}:${credentials.pin}`);
}

async function postJson(
  credentials: Record<string, string>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, any> }> {
  const resp = await fetch(`${baseUrl(credentials)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": authHeader(credentials) },
    body: JSON.stringify(body),
  });
  let data: Record<string, any> = {};
  try { data = await resp.json(); } catch { /* non-JSON error body */ }
  return { status: resp.status, data };
}

// The transaction's integer reference_number, as a string (falls back to a
// nested transaction.id if a response ever omits it).
function refNumber(data: Record<string, any>): string | undefined {
  if (data?.reference_number != null) return String(data.reference_number);
  if (data?.transaction?.id != null) return String(data.transaction.id);
  return undefined;
}

// Approval is status_code "A" (or the "Approved" status word). A reversal's own
// success words (void/refund) are accepted by the caller too.
function isApproved(data: Record<string, any>): boolean {
  return String(data?.status_code || "").toUpperCase() === "A"
      || String(data?.status || "").toLowerCase() === "approved";
}

function gwError(status: number, data: Record<string, any>): string {
  return (Array.isArray(data?.error_messages) && data.error_messages[0])
      || data?.error || data?.message || data?.status || `Banquest error (HTTP ${status})`;
}

export const banquestAdapter: ProcessorAdapter = {
  key: "banquest",

  async testConnection(credentials: Record<string, string>): Promise<TestConnectionResult> {
    if (!credentials.sourceKey || !credentials.pin) return { success: false, error: "Missing sourceKey/pin" };
    try {
      // Empty verify body: a valid key returns a validation error (auth OK,
      // nothing charged), a bad key returns 401/403.
      const { status, data } = await postJson(credentials, "/transactions/verify", {});
      if (status === 401 || status === 403) return { success: false, error: gwError(status, data) };
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  async saveMethod(
    credentials: Record<string, string>,
    token: string,
  ): Promise<SaveMethodResult> {
    try {
      // `token` is the Hosted-Tokenization nonce; a $0 verify with
      // save_card:true returns the durable card_ref.
      const { status, data } = await postJson(credentials, "/transactions/verify", {
        source: "nonce-" + token,
        save_card: true,
      });
      const cardRef = data?.card_ref;
      // A verify may return card_ref without a status word; treat card_ref
      // presence as approval in that case.
      if (status < 200 || status >= 300 || !cardRef || !(isApproved(data) || cardRef)) {
        return { success: false, error: gwError(status, data), raw: data };
      }
      return { success: true, customerRef: cardRef, raw: data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  async charge(
    credentials: Record<string, string>,
    amountCents: number,
    customerRef: string,
    _description: string,
  ): Promise<ChargeResult> {
    try {
      const { status, data } = await postJson(credentials, "/transactions/charge", {
        amount: Number((amountCents / 100).toFixed(2)),
        source: "tkn-" + customerRef,
      });
      if (status < 200 || status >= 300 || !isApproved(data) || !refNumber(data)) {
        return { success: false, status: data?.status, error: gwError(status, data), raw: data };
      }
      return { success: true, externalTransactionId: refNumber(data), status: data?.status, raw: data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  async refund(
    credentials: Record<string, string>,
    externalTransactionId: string,
    amountCents: number,
  ): Promise<RefundResult> {
    try {
      // /transactions/reversal auto-picks refund (settled) vs void (unsettled).
      // It's keyed on the original transaction's integer reference_number.
      const refNum = Number(externalTransactionId);
      if (!Number.isFinite(refNum)) {
        return { success: false, error: "Original transaction reference is not a valid Banquest reference_number." };
      }
      const { status, data } = await postJson(credentials, "/transactions/reversal", {
        reference_number: refNum,
        amount: Number((amountCents / 100).toFixed(2)),
      });
      const ok = isApproved(data) || /void|refund/.test(String(data?.status || "").toLowerCase());
      if (status < 200 || status >= 300 || !ok || !refNumber(data)) {
        return { success: false, status: data?.status, error: gwError(status, data), raw: data };
      }
      return { success: true, externalTransactionId: refNumber(data), status: data?.status, raw: data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};
