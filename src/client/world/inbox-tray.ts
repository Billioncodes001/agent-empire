import * as THREE from 'three';
import { mesh, roundedBox, toon } from './toon';
import type { Interactable } from './office';

/**
 * ORG-03: the CEO's inbox tray on the founder's desk. A walnut-and-brass letter tray whose paper stack grows with
 * the pending approvals, and a small dot-matrix plaque that shows the count. Pressing E beside it opens the inbox.
 * Its dynamic parts use their own materials so the office's static batching never merges them.
 */
export interface InboxTray {
  interactable: Interactable;
  group: THREE.Group;
  setCount(n: number | null): void;
  update(t: number, reduceMotion: boolean): void;
  readonly count: number | null;
}

const W = 128;
const H = 64;

function drawPlaque(ctx: CanvasRenderingContext2D, n: number | null) {
  ctx.fillStyle = '#17120c';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#a07a3c';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  const text = n === null ? '--' : n > 99 ? '99+' : String(n);
  // Dot-matrix: draw the digits, then sample them onto a grid of round dots.
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const s = scratch.getContext('2d')!;
  s.fillStyle = '#fff';
  s.font = 'bold 46px ui-monospace, Menlo, monospace';
  s.textAlign = 'center';
  s.textBaseline = 'middle';
  s.fillText(text, W / 2, H / 2 + 2);
  const px = s.getImageData(0, 0, W, H).data;
  const lit = n ? '#ffcf6b' : '#7f8b84';
  for (let y = 6; y < H - 4; y += 5) {
    for (let x = 6; x < W - 4; x += 5) {
      const on = px[(y * W + x) * 4 + 3] > 100;
      ctx.fillStyle = on ? lit : '#2a2117';
      ctx.beginPath();
      ctx.arc(x, y, on ? 2 : 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Built in desk-local space: `desk` is the founder desk group (its top at y 0.83, the sitter on +z). */
export function buildInboxTray(desk: THREE.Group, world: { x: number; z: number; y: number }): InboxTray {
  const group = new THREE.Group();
  group.name = 'CEO inbox tray';
  const walnut = toon('#4a2f1e');
  const brass = toon('#b08a45');
  // Tray: base, three low walls, and a brass lip at the front.
  group.add(mesh(roundedBox(0.44, 0.025, 0.32, 0.01), walnut, 0, 0.0125, 0));
  group.add(mesh(new THREE.BoxGeometry(0.44, 0.07, 0.02), walnut, 0, 0.045, -0.15));
  for (const sx of [-1, 1]) group.add(mesh(new THREE.BoxGeometry(0.02, 0.07, 0.32), walnut, sx * 0.21, 0.045, 0));
  group.add(mesh(new THREE.BoxGeometry(0.44, 0.03, 0.02), brass, 0, 0.03, 0.15));
  // Paper stack: its own material, scaled to the pending count (hidden at zero).
  const paper = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.01, 0.26), new THREE.MeshLambertMaterial({ color: '#f4efe4' }));
  paper.position.set(0, 0.03, 0);
  paper.visible = false;
  group.add(paper);
  // A red tab on the top sheet when anything waits: shape and colour, never colour alone (the plaque has the number).
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.06), new THREE.MeshLambertMaterial({ color: '#c8553d' }));
  tab.visible = false;
  group.add(tab);
  // Count plaque standing behind the tray, facing the sitter and the aisle.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  drawPlaque(ctx, null);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.12), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  plaque.position.set(0, 0.16, -0.17);
  plaque.name = 'Inbox count';
  group.add(plaque);
  group.add(mesh(new THREE.BoxGeometry(0.26, 0.14, 0.015), brass, 0, 0.16, -0.18));
  group.position.set(0.58, 0.83, 0.08);
  desk.add(group);

  const interactable: Interactable = { kind: 'inbox', x: world.x, z: world.z, y: world.y, radius: 1.15 };
  group.userData.interact = interactable;
  for (const child of group.children) child.userData.interact = interactable;

  let count: number | null = null;
  return {
    interactable,
    group,
    get count() { return count; },
    setCount(n) {
      if (n === count) return;
      count = n;
      drawPlaque(ctx, n);
      tex.needsUpdate = true;
      const sheets = Math.min(n ?? 0, 8);
      paper.visible = sheets > 0;
      paper.scale.y = Math.max(1, sheets * 1.6);
      paper.position.y = 0.025 + (0.01 * paper.scale.y) / 2;
      tab.visible = sheets > 0;
      tab.position.set(0.14, paper.position.y + (0.01 * paper.scale.y) / 2 + 0.006, 0.1);
    },
    update(t, reduceMotion) {
      // A slow brass glow on the plaque while something waits; still under reduced motion.
      const pulse = !reduceMotion && (count ?? 0) > 0 ? 0.88 + 0.12 * Math.sin(t * 2.4) : 1;
      (plaque.material as THREE.MeshBasicMaterial).color.setScalar(pulse);
    },
  };
}
