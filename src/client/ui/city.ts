/**
 * FREE-09 (CITY-05/07): the garage kiosk and plot dialog. Every purchase is an `empire.action` the host (or the cloud
 * coordinator) validates with the shared rules; this view never changes credits itself. Prices are fictional city
 * credits, never provider spending.
 */
import { GARAGE, HELICOPTER, HELIPAD, PLOTS, VEHICLE_MODELS, freeBay, normalizeCity, type PlotId } from '../../shared/city';
import type { EmpireAction } from '../../shared/empire';
import { store } from '../state';
import { h, openModal } from './dom';
import type { CityTarget } from '../world/districts';
import { PurchaseTracker } from './purchase-tracker';

let tracker: PurchaseTracker | undefined;

/** A per-click purchase nonce (shared/city.ts PURCHASE_NONCE). */
export function purchaseNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export interface CityDialogDeps {
  send(action: EmpireAction): void;
  /** Apron slots the live sedan or the founder occupies right now. */
  blocked(): number[];
  /** CITY-06: a vehicle driven or parked away from the garage this session (it cannot be moved from the kiosk). */
  away?(vehicleId: string): boolean;
  /** Current key labels, so the how-to copy follows remapped keys. */
  keys?: { interact: string; jump: string; run: string };
}

export function openCityDialog(deps: CityDialogDeps, target: CityTarget) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const body = h('div.body.city-dialog');
  const title = target.kind === 'garage' ? GARAGE.name : target.kind === 'helipad' ? HELIPAD.name : PLOTS.find((p) => p.id === target.plot)!.name;
  const keys = deps.keys ?? { interact: 'E', jump: 'Space', run: 'Left Shift' };
  const dialog = h('div.modal.ae-dark.city-modal', { role: 'dialog', 'aria-labelledby': 'city-dialog-title' }, h('header', {}, h('h2', { id: 'city-dialog-title' }, title), close), body);
  const button = (key: string, label: string, onclick: () => void, disabled = false) =>
    h('button.btn', { type: 'button', 'data-key': key, onclick, disabled }, label);

  // One nonce per purchase target until it is bought (ui/purchase-tracker.ts); the tracker outlives the
  // dialog so reopening it cannot mint a second nonce for a purchase still queued in cloud mode.
  tracker ??= new PurchaseTracker(purchaseNonce, store.empire.city);
  const purchases = tracker;
  purchases.update(store.empire.city);
  const purchase = (action: Omit<Extract<EmpireAction, { kind: 'buy-vehicle' }>, 'nonce'> | Omit<Extract<EmpireAction, { kind: 'buy-plot' }>, 'nonce'> | Omit<Extract<EmpireAction, { kind: 'buy-helicopter' }>, 'nonce'>) => {
    if (purchases.pending) return;
    const nonce = purchases.click(action.kind === 'buy-vehicle' ? `vehicle:${action.model}` : action.kind === 'buy-helicopter' ? 'helicopter' : `plot:${action.plot}`);
    deps.send({ ...action, nonce } as EmpireAction);
    // Cloud mode may answer minutes later and may not toast a refusal. Re-enabling Buy is safe: a further click on
    // the same target resends the same nonce, which the shared rules refuse once the first purchase is applied.
    setTimeout(() => { if (purchases.pending) { purchases.timedOut(); render(); } }, 8000);
    render();
  };
  const pendingNow = () => purchases.pending;
  function render() {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const state = store.empire, city = normalizeCity(state.city);
    const credits = h('p.setting-note', {}, `Treasury ${state.funds.toLocaleString('en-US')} city credits. City credits are fictional and never charge your AI provider.`);
    const rows: HTMLElement[] = [credits];
    if (target.kind === 'garage') {
      const full = freeBay(city) < 0;
      rows.push(h('h3', {}, `Your vehicles · ${city.vehicles.length}/${GARAGE.bays.length} bays`));
      rows.push(h('p.setting-note', {}, `Bought vehicles are kept here: park them in a bay or bring them out to the kerb. To drive one, walk to its driver's door and press ${keys.interact}. A car you leave elsewhere stays there until you reload, then returns to its bay or kerb slot.`));
      rows.push(city.vehicles.length
        ? h('ul.city-list', {}, ...city.vehicles.map((v) => {
            const model = VEHICLE_MODELS.find((m) => m.id === v.model)!;
            const away = deps.away?.(v.id) ?? false;
            return h('li', {}, h('span', {}, `${model.name} · ${away ? 'parked away from the garage' : v.apron === undefined ? `bay ${v.bay + 1}` : `outside, kerb slot ${v.apron + 1}`}`),
              away
                ? button(`away-${v.id}`, 'Drive it back first', () => {}, true)
                : v.apron === undefined
                ? button(`out-${v.id}`, 'Bring out', () => deps.send({ kind: 'vehicle-spawn', vehicle: v.id, blocked: deps.blocked() }))
                : button(`store-${v.id}`, 'Store in bay', () => deps.send({ kind: 'vehicle-store', vehicle: v.id })));
          }))
        : h('p', {}, 'No vehicles in the garage yet.'));
      rows.push(h('h3', {}, 'Buy a vehicle'));
      if (!state.setup.completed) rows.push(h('p.setting-note', {}, 'Complete founding setup before buying vehicles.'));
      rows.push(h('ul.city-list', {}, ...VEHICLE_MODELS.map((m) =>
        h('li', {}, h('span', {}, `${m.name} · ${m.cost.toLocaleString('en-US')} cr`),
          button(`buy-${m.id}`, full ? 'Garage full' : pendingNow() ? 'Buying…' : 'Buy', () => purchase({ kind: 'buy-vehicle', model: m.id }), pendingNow() || full || !state.setup.completed || state.funds < m.cost)))));
    } else if (target.kind === 'helipad') {
      rows.push(h('p', {}, state.city?.helicopter
        ? `Your ${HELICOPTER.name.toLowerCase()} is ready. Walk to the pilot's door and press ${keys.interact}.`
        : `The ${HELICOPTER.name.toLowerCase()} costs ${HELICOPTER.cost.toLocaleString('en-US')} city credits and is kept on this rooftop pad.`));
      rows.push(h('p.setting-note', {}, `Flying: ${keys.jump} climbs, ${keys.run} descends, the movement keys fly forward and back and turn. Land on this pad or at street level, then press ${keys.interact} to step out. On a touch screen use the joystick with Up and Down.`));
      if (!state.city?.helicopter) {
        if (!state.setup.completed) rows.push(h('p.setting-note', {}, 'Complete founding setup before buying the helicopter.'));
        rows.push(button('buy-helicopter', pendingNow() ? 'Buying…' : `Buy helicopter · ${HELICOPTER.cost.toLocaleString('en-US')} cr`, () => purchase({ kind: 'buy-helicopter' }), pendingNow() || !state.setup.completed || state.funds < HELICOPTER.cost));
      }
    } else {
      const plot = PLOTS.find((p) => p.id === target.plot)!;
      const owned = city.plots.includes(plot.id as PlotId);
      rows.push(h('p', {}, owned
        ? 'You own this parcel. Building on district parcels is coming in a later update.'
        : `This ${plot.district === 'business' ? 'business district' : 'harbour'} parcel costs ${plot.cost.toLocaleString('en-US')} city credits.`));
      if (!owned && !state.setup.completed) rows.push(h('p.setting-note', {}, 'Complete founding setup before buying parcels.'));
      if (!owned) rows.push(button(`plot-${plot.id}`, pendingNow() ? 'Buying…' : `Buy parcel · ${plot.cost.toLocaleString('en-US')} cr`, () => purchase({ kind: 'buy-plot', plot: plot.id }), pendingNow() || !state.setup.completed || state.funds < plot.cost));
    }
    body.replaceChildren(...rows);
    if (focused) (body.querySelector(`[data-key="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
  }
  render();
  // Pending clears only when the city's purchases change, not on every empire event (cloud snapshots, ticks).
  const off = store.on('empire', () => { purchases.update(store.empire.city); render(); });
  // A refused purchase arrives as an error toast (host) and leaves the state unchanged: re-enable the buttons.
  const toasts = document.getElementById('toasts');
  const watch = new MutationObserver((records) => {
    if (!purchases.pending) return;
    const error = records.flatMap((r) => [...r.addedNodes]).find((n) => n instanceof HTMLElement && n.classList.contains('error'));
    if (error) { purchases.refused(); render(); }
  });
  if (toasts) watch.observe(toasts, { childList: true });
  const modal = openModal(dialog, { escCloses: true, backdropCloses: true, onClose: () => { off?.(); watch.disconnect(); } });
  close.addEventListener('click', () => modal.close());
  return modal;
}
