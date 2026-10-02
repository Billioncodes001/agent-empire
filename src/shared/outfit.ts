// Corporate attire. Every person in the empire wears one of the licensed Rocketbox business avatars:
// the CEO (player) picks a suit on the character select screen, the chief of staff follows the CEO,
// and each AI worker gets a stable default unless the owner chose an outfit when hiring it.
// Server and client share this file; an outfit on the wire is an avatar id plus optional colours.

export const AVATAR_IDS = [
  'business-m01',
  'business-m02',
  'business-m03',
  'business-m04',
  'business-m05',
  'business-m06',
  'business-f01',
  'business-f02',
  'business-f03',
  'business-f04',
] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];

/** A recolourable part of an outfit. `tie` exists only on avatars that wear one. */
export type OutfitRegion = 'suit' | 'shirt' | 'tie';
export const OUTFIT_REGIONS: OutfitRegion[] = ['suit', 'shirt', 'tie'];

export interface AvatarDef {
  id: AvatarId;
  /** Short description of the default attire, used for labels and aria text. */
  label: string;
  body: 'male' | 'female';
  /** Regions the build pipeline masked on this avatar (see tools/avatars/masks.ts). */
  regions: OutfitRegion[];
  /** Display colours of the original attire for pickers (sRGB). */
  swatch: { suit: string; shirt: string; tie?: string };
  /** What the `suit` region is called when it is not a jacket (e.g. trousers under shirt sleeves). */
  suitLabel?: string;
  /** What the `shirt` region is called when it is not a shirt (a blouse or a top). */
  shirtLabel?: string;
}

export const AVATARS: AvatarDef[] = [
  { id: 'business-m01', label: 'Black suit, red tie', body: 'male', regions: ['suit', 'shirt', 'tie'], swatch: { suit: '#18181b', shirt: '#ecebe7', tie: '#a3202a' } },
  { id: 'business-m02', label: 'Navy suit', body: 'male', regions: ['suit', 'shirt', 'tie'], swatch: { suit: '#262c40', shirt: '#ecebe7', tie: '#2c3550' } },
  { id: 'business-m03', label: 'Charcoal suit, teal tie', body: 'male', regions: ['suit', 'shirt', 'tie'], swatch: { suit: '#333331', shirt: '#f0f0f0', tie: '#3f7f78' } },
  { id: 'business-m04', label: 'Grey waistcoat', body: 'male', regions: ['suit', 'shirt', 'tie'], swatch: { suit: '#3b3934', shirt: '#9a9c90', tie: '#2a2a26' } },
  { id: 'business-m05', label: 'Check suit, purple shirt', body: 'male', regions: ['suit', 'shirt', 'tie'], swatch: { suit: '#29271f', shirt: '#8d5a99', tie: '#1b1b1b' } },
  { id: 'business-m06', label: 'White shirt, black trousers', body: 'male', regions: ['suit', 'shirt'], swatch: { suit: '#161616', shirt: '#f3f3f3' }, suitLabel: 'Trousers' },
  { id: 'business-f01', label: 'Black trouser suit', body: 'female', regions: ['suit', 'shirt'], swatch: { suit: '#18181b', shirt: '#eceef6' }, shirtLabel: 'Blouse' },
  { id: 'business-f02', label: 'Burgundy jacket, striped top', body: 'female', regions: ['suit', 'shirt'], swatch: { suit: '#5a2621', shirt: '#9a968c' }, shirtLabel: 'Top' },
  { id: 'business-f03', label: 'Taupe skirt suit', body: 'female', regions: ['suit', 'shirt'], swatch: { suit: '#8c7566', shirt: '#3a271c' }, shirtLabel: 'Top' },
  { id: 'business-f04', label: 'Pinstripe suit', body: 'female', regions: ['suit', 'shirt'], swatch: { suit: '#2a2a27', shirt: '#c9c9cc' }, shirtLabel: 'Blouse' },
];
const BY_ID = new Map(AVATARS.map((a) => [a.id, a]));
export const avatarDef = (id: AvatarId): AvatarDef => BY_ID.get(id)!;
export const isAvatarId = (x: unknown): x is AvatarId => typeof x === 'string' && BY_ID.has(x as AvatarId);

/**
 * The CEO's suits, indexed by the profile look's `style`. Male and female alternate so a saved profile keeps its
 * body: before the corporate update an even style was the male founder rig and an odd one the female rig.
 */
export const CEO_AVATARS: AvatarId[] = ['business-m01', 'business-f01', 'business-m02', 'business-f04', 'business-m03', 'business-f03'];
/** Default attire for AI workers, picked per worker by a stable hash of its id. */
export const WORKER_AVATARS: AvatarId[] = ['business-m05', 'business-m04', 'business-m06', 'business-f02', 'business-f01', 'business-m03'];

export const ceoAvatar = (style: number): AvatarId => CEO_AVATARS[((Math.trunc(style) % CEO_AVATARS.length) + CEO_AVATARS.length) % CEO_AVATARS.length];
/** The chief of staff never dresses like the CEO: the taupe skirt suit, or the navy suit when the CEO is a woman. */
export const chiefAvatar = (ceo: AvatarId): AvatarId => (avatarDef(ceo).body === 'female' ? 'business-m02' : 'business-f03');

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export const workerAvatar = (id: string): AvatarId => WORKER_AVATARS[hash(`outfit:${id}`) % WORKER_AVATARS.length];

/** What someone wears. Colours are `#rrggbb`; an absent colour keeps the avatar's own fabric. */
export interface Outfit {
  avatar: AvatarId;
  suit?: string;
  shirt?: string;
  tie?: string;
}

/** Curated swatches for the hire dialog; any `#rrggbb` is accepted on the wire. */
export const OUTFIT_SWATCHES: Record<OutfitRegion, { name: string; color: string }[]> = {
  suit: [
    { name: 'Charcoal', color: '#33363b' },
    { name: 'Navy', color: '#1f2c4a' },
    { name: 'Black', color: '#16171a' },
    { name: 'Slate grey', color: '#6b7178' },
    { name: 'Taupe', color: '#8c7b6b' },
    { name: 'Burgundy', color: '#5e1f2a' },
    { name: 'Forest', color: '#24402f' },
    { name: 'Camel', color: '#a8865a' },
  ],
  shirt: [
    { name: 'White', color: '#f4f3ef' },
    { name: 'Sky blue', color: '#bcd3ea' },
    { name: 'Pink', color: '#efc9cf' },
    { name: 'Lavender', color: '#cfc6e6' },
    { name: 'Cream', color: '#eee3c8' },
    { name: 'Black', color: '#202124' },
  ],
  tie: [
    { name: 'Red', color: '#a3202a' },
    { name: 'Teal', color: '#1f7a78' },
    { name: 'Navy', color: '#1d2a52' },
    { name: 'Gold', color: '#c19a35' },
    { name: 'Green', color: '#2f6b3a' },
    { name: 'Purple', color: '#5b3a7d' },
    { name: 'Black', color: '#141414' },
  ],
};

const HEX = /^#[0-9a-f]{6}$/;
const color = (v: unknown): string | undefined => (typeof v === 'string' && HEX.test(v.toLowerCase()) ? v.toLowerCase() : undefined);

/**
 * A valid outfit or undefined. Unknown avatars are dropped (the wearer falls back to their default), bad colours
 * are dropped individually, and a colour for a region the avatar lacks (a tie on a tieless suit) is ignored.
 */
export function sanitizeOutfit(x: unknown): Outfit | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (!isAvatarId(o.avatar)) return undefined;
  const out: Outfit = { avatar: o.avatar };
  for (const region of avatarDef(o.avatar).regions) {
    const c = color(o[region]);
    if (c) out[region] = c;
  }
  return out;
}

/** The outfit a worker wears: its saved choice, else its stable default. */
export function workerOutfit(w: { id: string; outfit?: Outfit }): Outfit {
  return sanitizeOutfit(w.outfit) ?? { avatar: workerAvatar(w.id) };
}

export function sameOutfit(a: Outfit | undefined, b: Outfit | undefined): boolean {
  return a?.avatar === b?.avatar && a?.suit === b?.suit && a?.shirt === b?.shirt && a?.tie === b?.tie;
}
