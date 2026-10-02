import { lookFromSeed } from '../../shared/avatar';
import { AVATARS, OUTFIT_SWATCHES, avatarDef, sanitizeOutfit, type AvatarId, type Outfit, type OutfitRegion } from '../../shared/outfit';
import { Preview } from './character';
import { h } from './dom';

const REGION_LABEL: Record<OutfitRegion, string> = { suit: 'Suit colour', shirt: 'Shirt colour', tie: 'Tie colour' };
/** The visible label names the garment (trousers, blouse, top); the radiogroup keeps the stable region name. */
function regionLabel(id: AvatarId, region: OutfitRegion): string {
  const def = avatarDef(id);
  const garment = region === 'suit' ? def.suitLabel : region === 'shirt' ? def.shirtLabel : undefined;
  return garment ? `${garment} colour` : REGION_LABEL[region];
}

/**
 * The hire dialog's "Outfit" option: default corporate attire unless the owner picks an avatar, and optionally
 * suit, shirt and tie colours (tie only on avatars that wear one). A turntable preview appears once an avatar is
 * chosen; it owns a WebGL context, so `dispose` must run when the dialog closes.
 */
export function outfitPicker() {
  let avatar: AvatarId | null = null;
  const colors: Partial<Record<OutfitRegion, string>> = {};
  let preview: Preview | null = null;

  const summaryText = h('span.outfit-sum', {}, 'Default corporate attire');
  const canvas = h('canvas', { 'aria-label': 'Outfit preview, drag to spin' }) as HTMLCanvasElement;
  const stage = h('div.outfit-stage', { hidden: true }, canvas);
  const avatarRow = h('div.seg.outfit-avatars', { role: 'radiogroup', 'aria-label': 'Attire' });
  const colourRows = h('div.outfit-colours');
  const details = h(
    'details.outfit-pick',
    {},
    h('summary', {}, h('strong', {}, '👔 Outfit'), summaryText),
    h('div.outfit-body', {}, stage, h('div.outfit-opts', {}, h('label', {}, 'Attire'), avatarRow, colourRows)),
  ) as HTMLDetailsElement;

  const radio = (label: string, on: boolean, choose: () => void, extra: Record<string, string> = {}, ...kids: (Node | string)[]) =>
    h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : '', onclick: choose, ...extra }, ...kids);

  const value = (): Outfit | undefined => (avatar ? sanitizeOutfit({ avatar, ...colors }) : undefined);

  const paint = () => {
    avatarRow.replaceChildren(
      radio('Default', !avatar, () => choose(null), { title: 'A stable default suit for this worker' }, 'Default'),
      ...AVATARS.map((a) =>
        radio(a.label, avatar === a.id, () => choose(a.id), { title: a.label, 'aria-label': a.label }, h('span.suit-chip', { style: `--suit:${a.swatch.suit};--shirt:${a.swatch.shirt};--tie:${a.swatch.tie ?? a.swatch.shirt}`, 'aria-hidden': 'true' }), a.label),
      ),
    );
    colourRows.replaceChildren();
    if (avatar)
      for (const region of avatarDef(avatar).regions) {
        const row = h('div.swatches', { role: 'radiogroup', 'aria-label': REGION_LABEL[region] });
        const swatch = (color: string | undefined, name: string) => {
          const on = colors[region] === color;
          return h('button.swatch', {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on),
            class: `${on ? 'sel' : ''}${color ? '' : ' original'}`,
            style: color ? `background:${color}` : '',
            'aria-label': `${REGION_LABEL[region]}: ${name}`,
            title: name,
            onclick: () => { if (color) colors[region] = color; else delete colors[region]; changed(); },
          });
        };
        row.append(swatch(undefined, 'Original'), ...OUTFIT_SWATCHES[region].map((s) => swatch(s.color, s.name)));
        colourRows.append(h('label', {}, regionLabel(avatar, region)), row);
      }
    const o = value();
    summaryText.textContent = o ? `${avatarDef(o.avatar).label}${o.suit || o.shirt || o.tie ? ' · custom colours' : ''}` : 'Default corporate attire';
  };

  const changed = () => {
    const o = value();
    stage.hidden = !o;
    if (o) {
      if (!preview) preview = new Preview(canvas, { name: 'New hire', color: '#567b70', look: lookFromSeed('outfit-preview') }, o);
      else preview.person.setOutfit(o);
      preview.cheer();
    }
    paint();
  };
  const choose = (id: AvatarId | null) => {
    avatar = id;
    // Colours chosen for a region the new avatar lacks (a tie) are dropped by sanitizeOutfit; keep the rest.
    changed();
  };
  paint();

  return {
    element: details,
    value,
    dispose() {
      preview?.dispose();
      preview = null;
    },
  };
}
