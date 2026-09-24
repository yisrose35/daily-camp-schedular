// =============================================================================
// canteen_wallet_model.js — migration 275's refund reservation, as a model for
// the edge-function tests (the SQL itself is covered by
// scripts/pgtests/275_a_canteen_refund_takes_its_money_first.sql, including a
// real two-connection race).
//
// HOLDS is scenario source appended AFTER a scenario that defines `tx` (the
// canteen ledger rows the refund view returns), `let bal` (the one child's
// balance) and T.rpc.canteen_refund_view. It adds reserve / settle / release
// with the same rules as the SQL, and puts the open holds on the view. Because
// the harness runs every function in one process and each call runs to its
// next `await`, a reserve here is as atomic as the locked one in Postgres.
//
// T.holdAge (seconds) is how long the open holds have waited — 0 unless a
// scenario says otherwise.
// =============================================================================
'use strict';

const HOLDS = `
T.tables.canteen_refund_holds = T.tables.canteen_refund_holds || [];
// the wallet after the last change, for the test to read (T.tables is returned)
const __seen = () => { T.tables.__bal = bal; };
const __H = () => T.tables.canteen_refund_holds;
const __r2 = (n: number) => Math.round(n * 100) / 100;
const __floor = () => (typeof FLOOR !== 'undefined' ? (FLOOR as any) : 0);
T.rpc.reserve_canteen_refund = (a: any) => {
  const h = __H().find((x: any) => x.key === a.p_hold_key);
  if (h && (h.state === 'open' || h.state === 'posted')) return { success: true, existing: true, state: h.state, amount: h.amount, refundId: h.refundId, balance: bal };
  const amt = __r2(Number(a.p_amount) || 0);
  if (!(amt > 0)) return { success: false, error: 'invalid_amount' };
  const avail = __r2(bal - __floor());
  if (amt > avail) return { success: false, error: 'insufficient', available: Math.max(avail, 0) };
  bal = __r2(bal - amt);
  const row = { key: a.p_hold_key, amount: amt, method: a.p_method, paymentRef: a.p_payment_ref, stripeKey: a.p_stripe_key ?? null, state: 'open', refundId: null, camperId: a.p_camper_id ?? 7, accountKey: 'Avi' };
  if (h) Object.assign(h, row); else __H().push(row);
  __seen(); return { success: true, balance: bal };
};
T.rpc.settle_canteen_refund_hold = (a: any) => {
  const h = __H().find((x: any) => x.key === a.p_hold_key);
  if (!h) return { success: false, error: 'no_hold' };
  if (h.state === 'posted') return { success: true, alreadyProcessed: true, balance: bal };
  if (h.state === 'released') bal = __r2(bal - h.amount);
  tx.push(h.method === 'stripe'
    ? { kind: 'refund', method: 'stripe', stripePaymentIntentId: h.paymentRef, amount: h.amount, stripeRefundId: a.p_refund_id, camperId: 7 }
    : { kind: 'refund', method: h.method, byopTransactionId: h.paymentRef, amount: h.amount, byopRefundId: a.p_refund_id, camperId: 7 });
  h.state = 'posted'; h.refundId = a.p_refund_id;
  __seen(); return { success: true, balance: bal };
};
T.rpc.release_canteen_refund_hold = (a: any) => {
  const h = __H().find((x: any) => x.key === a.p_hold_key);
  if (!h) return { released: false, error: 'no_hold' };
  if (h.state !== 'open') return { released: false, state: h.state };
  if (a.p_min_age && (T.holdAge || 0) < 180) return { released: false, error: 'too_new' };
  bal = __r2(bal + h.amount); h.state = 'released'; __seen();
  return { released: true, balance: bal, amount: h.amount };
};
const __view = T.rpc.canteen_refund_view;
T.rpc.canteen_refund_view = (a: any) => (__seen(), Object.assign({}, __view(a), {
  holds: __H().filter((h: any) => h.state === 'open').map((h: any) => ({ key: h.key, accountKey: h.accountKey, camperId: h.camperId,
    amount: h.amount, method: h.method, paymentRef: h.paymentRef, stripeKey: h.stripeKey, ageSeconds: T.holdAge || 0 })) }));
`;

module.exports = { HOLDS };
