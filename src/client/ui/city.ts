/**
 * FREE-09 (CITY-05/07): the garage kiosk and plot dialog. Every purchase is an `empire.action` the host (or the cloud
 * coordinator) validates with the shared rules; this view never changes credits itself. Prices are fictional city
 * credits, never provider spending.
 */
import { GARAGE, PLOTS, VEHICLE_MODELS, freeBay, normalizeCity, type PlotId } from '../../shared/city';
import type { EmpireAction } from '../../shared/empire';
import { store } from '../state';
import { h, openModal } from './dom';
import type { CityTarget } from '../world/districts';

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
}

export function openCityDialog(deps: CityDialogDeps, target: CityTarget) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const body = h('div.body.city-dialog');
  const title = target.kind === 'garage' ? GARAGE.name : PLOTS.find((p) => p.id === target.plot)!.name;
  const dialog = h('div.modal.ae-dark.city-modal', { role: 'dialog', 'aria-labelledby': 'city-dialog-title' }, h('header', {}, h('h2', { id: 'city-dialog-title' }, title), close), body);
  const button = (key: string, label: string, onclick: () => void, disabled = false) =>
    h('button.btn', { type: 'button', 'data-key': key, onclick, disabled }, label);

  /** One purchase in flight at a time: buttons stay disabled until the city state changes or an error toast arrives. */
  let pending = false;
  const purchase = (action: Omit<Extract<EmpireAction, { kind: 'buy-vehicle' }>, 'nonce'> | Omit<Extract<EmpireAction, { kind: 'buy-plot' }>, 'nonce'>) => {
    if (pending) return;
    pending = true;
    deps.send({ ...action, nonce: purchaseNonce() } as EmpireAction);
    // Cloud refusals may not toast; the nonce already prevents a double purchase, so re-enable after a while.
    setTimeout(() => { if (pending) { pending = false; render(); } }, 8000);
    render();
  };
  function render() {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const state = store.empire, city = normalizeCity(state.city);
    const credits = h('p.setting-note', {}, `Treasury ${state.funds.toLocaleString('en-US')} city credits. City credits are fictional and never charge your AI provider.`);
    const rows: HTMLElement[] = [credits];
    if (target.kind === 'garage') {
      const full = freeBay(city) < 0;
      rows.push(h('h3', {}, `Your vehicles · ${city.vehicles.length}/${GARAGE.bays.length} bays`));
      rows.push(h('p.setting-note', {}, 'Bought vehicles are kept here: you can park them in a bay or bring them out to the kerb. Driving them is coming in a later update; today only your executive sedan can be driven.'));
      rows.push(city.vehicles.length
        ? h('ul.city-list', {}, ...city.vehicles.map((v) => {
            const model = VEHICLE_MODELS.find((m) => m.id === v.model)!;
            return h('li', {}, h('span', {}, `${model.name} · ${v.apron === undefined ? `bay ${v.bay + 1}` : `outside, kerb slot ${v.apron + 1}`}`),
              v.apron === undefined
                ? button(`out-${v.id}`, 'Bring out', () => deps.send({ kind: 'vehicle-spawn', vehicle: v.id, blocked: deps.blocked() }))
                : button(`store-${v.id}`, 'Store in bay', () => deps.send({ kind: 'vehicle-store', vehicle: v.id })));
          }))
        : h('p', {}, 'No vehicles in the garage yet.'));
      rows.push(h('h3', {}, 'Buy a vehicle'));
      if (!state.setup.completed) rows.push(h('p.setting-note', {}, 'Complete founding setup before buying vehicles.'));
      rows.push(h('ul.city-list', {}, ...VEHICLE_MODELS.map((m) =>
        h('li', {}, h('span', {}, `${m.name} · ${m.cost.toLocaleString('en-US')} cr`),
          button(`buy-${m.id}`, full ? 'Garage full' : pending ? 'Buying…' : 'Buy', () => purchase({ kind: 'buy-vehicle', model: m.id }), pending || full || !state.setup.completed || state.funds < m.cost)))));
    } else {
      const plot = PLOTS.find((p) => p.id === target.plot)!;
      const owned = city.plots.includes(plot.id as PlotId);
      rows.push(h('p', {}, owned
        ? 'You own this parcel. Building on district parcels is coming in a later update.'
        : `This ${plot.district === 'business' ? 'business district' : 'harbour'} parcel costs ${plot.cost.toLocaleString('en-US')} city credits.`));
      if (!owned && !state.setup.completed) rows.push(h('p.setting-note', {}, 'Complete founding setup before buying parcels.'));
      if (!owned) rows.push(button(`plot-${plot.id}`, pending ? 'Buying…' : `Buy parcel · ${plot.cost.toLocaleString('en-US')} cr`, () => purchase({ kind: 'buy-plot', plot: plot.id }), pending || !state.setup.completed || state.funds < plot.cost));
    }
    body.replaceChildren(...rows);
    if (focused) (body.querySelector(`[data-key="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
  }
  render();
  const off = store.on('empire', () => { pending = false; render(); });
  // A refused purchase arrives as an error toast (host) and leaves the state unchanged: re-enable the buttons.
  const toasts = document.getElementById('toasts');
  const watch = new MutationObserver((records) => {
    if (pending && records.some((r) => [...r.addedNodes].some((n) => n instanceof HTMLElement && n.classList.contains('error')))) { pending = false; render(); }
  });
  if (toasts) watch.observe(toasts, { childList: true });
  const modal = openModal(dialog, { escCloses: true, backdropCloses: true, onClose: () => { off?.(); watch.disconnect(); } });
  close.addEventListener('click', () => modal.close());
  return modal;
}
