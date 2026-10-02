import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { avatarDef, type AvatarId, type Outfit, type OutfitRegion } from '../../shared/outfit';

/**
 * Corporate avatar assets (built by tools/avatars/build-avatars.ts). Each avatar is a mesh-only GLB with external
 * WebP textures; animation comes from one shared clip file per body (clips-male.glb / clips-female.glb), so a
 * clip is loaded once however many people wear it. Everything loads lazily on first use and is cached: clones
 * share geometry, textures and (unless recoloured) materials.
 */
export const AVATAR_BASE = '/models/avatars';
export const avatarUrl = (id: AvatarId) => `${AVATAR_BASE}/${id}.glb`;
export const clipsUrl = (body: 'male' | 'female') => `${AVATAR_BASE}/clips-${body}.glb`;

/** What the build recorded about an avatar's recolour regions (scene extras). */
export interface AvatarExtras { avatar: AvatarId; body: 'male' | 'female'; height: number; pelvisHeight: number; clipPelvisHeight: number; regions: Partial<Record<OutfitRegion, { lum: number; color: string; area: number }>> }

/** Phones and Save-Data get the 512² texture set; everything else 1024². */
export function avatarTextureSize(): 512 | 1024 {
  if (typeof navigator === 'undefined' || typeof matchMedia !== 'function') return 1024;
  const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  return saveData || phone ? 512 : 1024;
}

let sized = false;
/**
 * A GLTFLoader on three's default loading manager (the splash counts and names its files, see ui/loading.ts), whose
 * URL modifier swaps avatar textures to this device's size. Only avatar texture URLs are touched.
 */
export function avatarLoader(): GLTFLoader {
  if (!sized) {
    sized = true;
    const size = avatarTextureSize();
    const avatarTexture = new RegExp(`^(.*${AVATAR_BASE}/[^?#]+)-1024\\.webp$`);
    if (size !== 1024) THREE.DefaultLoadingManager.setURLModifier((url) => url.replace(avatarTexture, `$1-${size}.webp`));
  }
  return new GLTFLoader();
}

/**
 * Shares one in-flight load per key, but forgets a failed one so the next caller fetches again: a single dropped
 * request on a phone changing networks must not leave every later body of that kind invisible until a reload.
 */
export function sharedLoad<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = load().catch((error) => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}

const clipLoads = new Map<string, Promise<THREE.AnimationClip[]>>();
export function loadClips(body: 'male' | 'female'): Promise<THREE.AnimationClip[]> {
  return sharedLoad(clipLoads, body, () => avatarLoader().loadAsync(clipsUrl(body)).then((gltf) => gltf.animations));
}

const masks = new Map<AvatarId, THREE.Texture>();
function maskTexture(id: AvatarId): THREE.Texture {
  let t = masks.get(id);
  if (!t) {
    t = new THREE.TextureLoader().load(`${AVATAR_BASE}/${id}/mask-512.webp`);
    t.flipY = false; // glTF texture space
    t.colorSpace = THREE.NoColorSpace;
    masks.set(id, t);
  }
  return t;
}

export const hasTint = (o: Outfit) => !!(o.suit || o.shirt || o.tie);

/**
 * A recoloured copy of an avatar's body material. The mask's channels select suit, shirt and tie texels; each is
 * replaced by the chosen colour, shaded by the texel's brightness relative to the region's average so folds,
 * seams and stripes survive. One shader program serves every recoloured worker; only the uniforms differ.
 */
export function tintedMaterial(source: THREE.MeshStandardMaterial, outfit: Outfit, extras: AvatarExtras): THREE.MeshStandardMaterial {
  const m = source.clone();
  m.name = source.name;
  const def = avatarDef(outfit.avatar);
  const on = (r: OutfitRegion) => (def.regions.includes(r) && outfit[r] && extras.regions[r] ? 1 : 0);
  const tint = (r: OutfitRegion) => new THREE.Color(outfit[r] ?? '#ffffff'); // Color converts sRGB hex to linear
  const lum = (r: OutfitRegion) => Math.max(0.002, extras.regions[r]?.lum ?? 0.2);
  const uniforms = {
    outfitMask: { value: maskTexture(outfit.avatar) },
    outfitSuit: { value: tint('suit') },
    outfitShirt: { value: tint('shirt') },
    outfitTie: { value: tint('tie') },
    outfitLum: { value: new THREE.Vector3(lum('suit'), lum('shirt'), lum('tie')) },
    outfitOn: { value: new THREE.Vector3(on('suit'), on('shirt'), on('tie')) },
  };
  m.userData.outfit = { ...outfit };
  m.userData.outfitUniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_pars_fragment>',
        '#include <map_pars_fragment>\nuniform sampler2D outfitMask;\nuniform vec3 outfitSuit, outfitShirt, outfitTie, outfitLum, outfitOn;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
#ifdef USE_MAP
{
  vec3 region = texture2D(outfitMask, vMapUv).rgb * outfitOn;
  float weight = min(1.0, region.r + region.g + region.b);
  if (weight > 0.0) {
    float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 shade = clamp(pow(vec3(l) / outfitLum, vec3(0.65)), 0.35, 1.7);
    vec3 dyed = outfitSuit * shade.x * region.r + outfitShirt * shade.y * region.g + outfitTie * shade.z * region.b;
    diffuseColor.rgb = diffuseColor.rgb * (1.0 - weight) + dyed;
  }
}
#endif`,
      );
  };
  m.customProgramCacheKey = () => 'outfit-tint-v1';
  return m;
}

export type { GLTF };
