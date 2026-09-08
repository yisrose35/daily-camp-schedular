// =============================================================================
// _shared/adapters/banquest_adapter.ts — BYOP adapter for Banquest.
//
// *** NOT YET VERIFIED AGAINST A LIVE SANDBOX — READ BEFORE ENABLING FOR A
// REAL CAMP *** (same caveat as the Cardknox adapter — no test credentials
// available in this environment).
//
// Banquest is a white-label reseller built on NMI's ("Network Merchants")
// gateway — confirmed this session (NMI explicitly supports onboarding
// multiple merchant IDs under one integration and has a mature ISV/partner
// developer API, docs.nmi.dev / docs.nmi.com). White-label NMI resellers
// typically issue their OWN branded gateway hostname rather than
// secure.nmi.com directly, and this codebase has no way to confirm
// Banquest's exact one from here — so, unlike the Cardknox adapter (whose
// endpoint is fixed), this adapter treats the gateway URL as PART OF THE
// CREDENTIAL, defaulting to NMI's own shared endpoint only if the camp's
// setup didn't specify one. Confirm the real URL with the camp/Banquest
// directly during onboarding and pass it as `gatewayUrl` — see
// BYOP_SETUP.md.
//
// API shape: NMI's classic Direct Post API — POST url-encoded fields to
// `<gatewayUrl>/api/transact.php`, response comes back as url-encoded
// key=value pairs (NOT JSON) with a `response` field (1=approved,
// 2=declined, 3=error), `transactionid`, `authcode`, `responsetext`.
// Read-only reporting lives at `<gatewayUrl>/api/query.php` — used here as
// the zero-money-movement connectivity test, same role Cardknox's
// Report:Transactions plays in that adapter.
//
// Credential shape (from payment_processor_catalog.credential_fields):
//   { securityKey: string, gatewayUrl?: string }
//
// customerRef (as passed into charge()) is an NMI "Customer Vault ID" —
// created via saveMethod() below from a Collect.js single-use payment_token
// (Collect.js is NMI's hosted client-side tokenizer, the same
// PCI-scope-reduction role Stripe.js/iFields play for the other two
// processors — see campistry_card_setup.html for where that token actually
// comes from).
// =============================================================================
import type { ProcessorAdapter, ChargeResult, RefundResult, TestConnectionResult, SaveMethodResult } from "../processor_adapter.ts";

const DEFAULT_GATEWAY_URL = "https://secure.nmi.com";

function gatewayBase(credentials: Record<string, string>): string {
  return (credentials.gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
}

async function postForm(url: string, fields: Record<string, string>): Promise<Record<string, string>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await resp.text();
  // NMI's classic API returns url-encoded key=value pairs, not JSON.
  const parsed: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { parsed[k] = v; });
  return parsed;
}

export const banquestAdapter: ProcessorAdapter = {
  key: "banquest",

  async testConnection(credentials: Record<string, string>): Promise<TestConnectionResult> {
    const securityKey = credentials.securityKey;
    if (!securityKey) return { success: false, error: "Missing securityKey" };
    try {
      // query.php is NMI's read-only reporting endpoint — proves the key
      // authenticates without moving any money. A narrow same-day window
      // keeps the response small; report_type=receipt is the standard
      // transaction-listing report.
      const today = new Date().toISOString().slice(0, 10);
      const result = await postForm(`${gatewayBase(credentials)}/api/query.php`, {
        security_key: securityKey,
        report_type: "receipt",
        start_date: today.replace(/-/g, "") + "000000",
        end_date: today.replace(/-/g, "") + "235959",
      });
      // query.php returns an XML-ish error string in `error_message` or a
      // bare auth failure rather than a `response` code the way
      // transact.php does — treat presence of an explicit error as failure,
      // anything else (including an empty result set) as a working key.
      if (result.error_response || result.error_message) {
        return { success: false, error: result.error_message || result.error_response };
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
    try {
      // NMI's Collect.js issues a single-use payment_token (expires in a
      // few minutes) — type=add_customer exchanges it for a permanent
      // Customer Vault id, exactly the "turn an ephemeral tokenization
      // result into a durable reference" step this method exists for.
      const result = await postForm(`${gatewayBase(credentials)}/api/transact.php`, {
        security_key: credentials.securityKey,
        type: "add_customer",
        payment_token: token,
      });
      if (result.response !== "1" || !result.customer_vault_id) {
        return { success: false, error: result.responsetext || "Could not save payment method", raw: result };
      }
      return { success: true, customerRef: result.customer_vault_id, raw: result };
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
    try {
      // orderid must be unique PER CHARGE — same reasoning as the fix just
      // applied to the Cardknox/Sola adapter's xInvoice: NMI (the gateway
      // Banquest resells) supports account-level "duplicate transaction
      // checking" keyed on card/vault + amount + orderid within a time
      // window. Sending a fixed/absent orderid is harmless if that setting
      // is off for a given camp's account, but would risk a false decline
      // on two genuinely different same-amount charges (e.g. two autopay
      // installments) if it's on — cheap to always send, so always send it.
      const orderid = "CI-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const result = await postForm(`${gatewayBase(credentials)}/api/transact.php`, {
        security_key: credentials.securityKey,
        type: "sale",
        amount: (amountCents / 100).toFixed(2),
        customer_vault_id: customerRef,
        orderid,
        orderdescription: description.slice(0, 255),
      });
      if (result.response !== "1") {
        return { success: false, status: result.response_code, error: result.responsetext || "Declined", raw: result };
      }
      return {
        success: true,
        externalTransactionId: result.transactionid,
        status: result.response_code,
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
    try {
      const result = await postForm(`${gatewayBase(credentials)}/api/transact.php`, {
        security_key: credentials.securityKey,
        type: "refund",
        transactionid: externalTransactionId,
        amount: (amountCents / 100).toFixed(2),
      });
      if (result.response !== "1") {
        return { success: false, status: result.response_code, error: result.responsetext || "Refund failed", raw: result };
      }
      return {
        success: true,
        externalTransactionId: result.transactionid,
        status: result.response_code,
        raw: result,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};
