// =============================================================================
// _shared/processor_adapter.ts — the BYOP (Bring-Your-Own Processor) plugin
// contract.
//
// Deliberate, reasoned exception to this repo's usual "duplicate the small
// bit of shared logic across every function, no _shared/ module" convention
// (confirmed via inventory: every stripe-* function inlines its own
// stripePost/callerCampId rather than importing one). That convention makes
// sense for a handful of near-identical Stripe functions; it works against
// the entire point of a processor-plugin framework, where the whole goal is
// "adding processor #4 is writing one file that implements this interface,"
// not re-deriving the interface by hand in three different dispatcher
// functions. Supabase Edge Functions support relative imports across
// functions natively — this is a standard pattern, not a workaround.
//
// Every processor adapter (supabase/functions/_shared/adapters/*.ts)
// implements this interface. The BYOP dispatcher functions
// (payments-checkout, payments-charge, payments-refund) are the ONLY
// callers — they look up a camp's payment_processor_key, load the matching
// adapter via getAdapter(), decrypt that camp's credentials via the
// service-role-only _admin_get_processor_credential RPC, and call the
// adapter's methods. Existing Stripe camps never touch this file at all —
// they keep going through the existing stripe-checkout/stripe-charge/
// stripe-refund functions completely unchanged; 'stripe' is intentionally
// NOT one of the adapters implemented here (see the migration's catalog
// comment — the adapter_module for 'stripe' points back at the existing
// functions, not at a file in this directory).
// =============================================================================

export interface ChargeResult {
  success: boolean;
  externalTransactionId?: string;
  status?: string;         // adapter-native status string, logged as-is
  error?: string;
  raw?: unknown;            // full adapter response, for processor_transactions.raw_response only
}

export interface RefundResult {
  success: boolean;
  externalTransactionId?: string;
  status?: string;
  error?: string;
  raw?: unknown;
}

export interface TestConnectionResult {
  success: boolean;
  error?: string;
}

export interface ProcessorAdapter {
  /** The catalog `key` this adapter implements — must match payment_processor_catalog.key. */
  readonly key: string;

  /**
   * A one-time, side-effect-free (or as close as the processor allows —
   * e.g. a $0 auth-only transaction if there's no dedicated ping endpoint)
   * call proving the credential actually works, BEFORE it's ever used for
   * a real charge. Called once by admin-connect-processor at setup time.
   */
  testConnection(credentials: Record<string, string>): Promise<TestConnectionResult>;

  /**
   * Charge amountCents to whatever payment method customerRef identifies.
   * customerRef's shape is adapter-specific (Cardknox: a saved token id;
   * a future adapter might use something else) — the dispatcher functions
   * never interpret it, only pass it through.
   */
  charge(
    credentials: Record<string, string>,
    amountCents: number,
    customerRef: string,
    description: string,
  ): Promise<ChargeResult>;

  /** Refund a previous charge, identified by that processor's own transaction id. */
  refund(
    credentials: Record<string, string>,
    externalTransactionId: string,
    amountCents: number,
  ): Promise<RefundResult>;
}

// Adapters register themselves here — adding processor #4 means adding one
// import + one entry, nothing else in this file changes.
import { cardknoxAdapter } from "./adapters/cardknox_adapter.ts";

const ADAPTERS: Record<string, ProcessorAdapter> = {
  cardknox: cardknoxAdapter,
};

export function getAdapter(processorKey: string): ProcessorAdapter | null {
  return ADAPTERS[processorKey] || null;
}
