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

export interface CityDialogDeps {
  send(action: EmpireAction): void;
  /** Apron slots the live sedan or the founder occupies right now. */
  blocked(): number[];
}

export function openCityDialog(deps: CityDialogDeps, target: CityTarget) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const body = h('div.body.city-dialog');
  const title = target.kind === 'garage' ? GARAGE.name : PLOTS.find((p) => p.id === target.plot)!.name;
  const dialog = h('div.modal', { role: 'dialog', 'aria-labelledby': 'city-dialog-title' }, h('header', {}, h('h2', { id: 'city-dialog-title' }, title), close), body);
  const button = (key: string, label: string, onclick: () => void, disabled = false) =>
    h('button.btn', { type: 'button', 'data-key': key, onclick, disabled }, label);

  function render() {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const state = store.empire, city = normalizeCity(state.city);
    const credits = h('p.setting-note', {}, `Treasury ${state.funds.toLocaleString('en-US')} city credits. City credits are fictional and never charge your AI provider.`);
    const rows: HTMLElement[] = [credits];
    if (target.kind === 'garage') {
      const full = freeBay(city) < 0;
      rows.push(h('h3', {}, `Your vehicles · ${city.vehicles.length}/${GARAGE.bays.length} bays`));
      rows.push(h('p.setting-note', {}, 'The executive sedan stays your drivable car. Bought vehicles are stored here and can be brought out to the kerb; driving them arrives with authored door and seat animation (CITY-06).'));
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
          button(`buy-${m.id}`, full ? 'Garage full' : 'Buy', () => deps.send({ kind: 'buy-vehicle', model: m.id }), full || !state.setup.completed || state.funds < m.cost)))));
    } else {
      const plot = PLOTS.find((p) => p.id === target.plot)!;
      const owned = city.plots.includes(plot.id as PlotId);
      rows.push(h('p', {}, owned
        ? 'You own this parcel. Construction on district plots arrives in a later phase.'
        : `This ${plot.district === 'business' ? 'business district' : 'harbour'} parcel costs ${plot.cost.toLocaleString('en-US')} city credits.`));
      if (!owned) rows.push(button(`plot-${plot.id}`, `Buy parcel · ${plot.cost.toLocaleString('en-US')} cr`, () => deps.send({ kind: 'buy-plot', plot: plot.id }), state.funds < plot.cost));
    }
    body.replaceChildren(...rows);
    if (focused) (body.querySelector(`[data-key="${focused}"]`) as HTMLElement | null)?.focus();
  }
  render();
  const off = store.on('empire', render);
  const modal = openModal(dialog, { escCloses: true, backdropCloses: true, onClose: () => off?.() });
  close.addEventListener('click', () => modal.close());
  return modal;
}
