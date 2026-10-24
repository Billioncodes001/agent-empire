/**
 * FREE-09: one purchase nonce per target (a vehicle model or a plot) until that purchase is settled.
 *
 * Cloud intents are applied by the coordinator minutes after the click, and the client sees unrelated `empire`
 * updates in between. A fresh nonce per click would let a second click queue a second purchase. Instead, every click
 * on the same target reuses its nonce until the nonce shows up in `city.nonces` (bought) or the host refuses it; the
 * shared rules then refuse any repeat. `pending` only drives the buttons' disabled state and clears when the city's
 * purchases actually change, on a refusal, or after a timeout (safe, because the nonce is still reused).
 */
import { normalizeCity, type CityState } from '../../shared/city';

export type PurchaseTarget = `vehicle:${string}` | `plot:${string}`;
const signature = (city: CityState) => JSON.stringify([city.nonces ?? [], city.vehicles, city.plots]);

export class PurchaseTracker {
  private nonces = new Map<PurchaseTarget, string>();
  private last?: PurchaseTarget;
  private seen: string;
  pending = false;
  constructor(private makeNonce: () => string, city: unknown = undefined) {
    this.seen = signature(normalizeCity(city));
  }
  /** The nonce to send for a click on `target`: the same one until that purchase is settled. */
  click(target: PurchaseTarget): string {
    let nonce = this.nonces.get(target);
    if (!nonce) this.nonces.set(target, (nonce = this.makeNonce()));
    this.last = target;
    this.pending = true;
    return nonce;
  }
  /** Feed every `empire` update. Returns true when the city's purchases changed (and `pending` was cleared). */
  update(raw: unknown): boolean {
    const city = normalizeCity(raw);
    for (const [target, nonce] of this.nonces) if (city.nonces?.includes(nonce)) this.nonces.delete(target);
    const next = signature(city);
    if (next === this.seen) return false;
    this.seen = next;
    this.pending = false;
    return true;
  }
  /** A refusal toast for the last purchase. A duplicate refusal keeps the nonce (that purchase already happened). */
  refused(message: string) {
    this.pending = false;
    if (this.last && !/already made/i.test(message)) this.nonces.delete(this.last);
  }
  /** No answer yet (e.g. cloud mode): re-enable the buttons; a click still reuses the outstanding nonce. */
  timedOut() { this.pending = false; }
}
