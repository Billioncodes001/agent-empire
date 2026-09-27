import * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';

export type GraphicsQuality = 'low' | 'medium' | 'high';
export const GRAPHICS = {
  low: { label: 'Low', description: 'Best performance · native 1× resolution, no dynamic shadows or ocean reflections.', pixelRatio: 1, shadows: 0, ao: false, reflections: false, citizens: 2 },
  medium: { label: 'Medium', description: 'Balanced · 1.25× resolution and dynamic shadows. Recommended for laptops.', pixelRatio: 1.25, shadows: 1024, ao: false, reflections: false, citizens: 4 },
  high: { label: 'High', description: 'Full detail · 2× resolution, contact shading, sharper shadows and ocean reflections.', pixelRatio: 2, shadows: 2048, ao: true, reflections: true, citizens: 8 },
} as const;
export const sanitizeQuality = (value: unknown): GraphicsQuality => value === 'low' || value === 'high' ? value : 'medium';

/** Reconfigure existing GPU targets instead of recreating the scene or resetting the player. */
export function applyGraphics(quality: GraphicsQuality, renderer: THREE.WebGLRenderer, composer: EffectComposer, ao: SSAOPass, sun: THREE.DirectionalLight, scene: THREE.Scene) {
  const profile = GRAPHICS[quality];
  const pixelRatio = Math.min(window.devicePixelRatio || 1, profile.pixelRatio);
  renderer.setPixelRatio(pixelRatio);
  composer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = profile.shadows > 0;
  const size = profile.shadows || 512;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.map?.dispose(); sun.shadow.map = null;
    sun.shadow.mapSize.set(size, size);
  }
  renderer.shadowMap.needsUpdate = true;
  ao.enabled = profile.ao;
  scene.traverse(object => {
    if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.needsUpdate = true;
  });
  renderer.domElement.dataset.quality = quality;
}
