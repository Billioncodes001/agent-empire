import { batchStaticMeshes } from './batching';
import * as THREE from 'three';
import { SURFACE, solid } from './materials';

function leafTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  const gradient = g.createLinearGradient(0, 0, 128, 0);
  gradient.addColorStop(0, '#33522b');
  gradient.addColorStop(0.48, '#769751');
  gradient.addColorStop(0.55, '#506e36');
  gradient.addColorStop(1, '#294322');
  g.fillStyle = gradient;
  g.beginPath();
  g.moveTo(64, 2);
  g.bezierCurveTo(126, 55, 113, 195, 64, 254);
  g.bezierCurveTo(15, 195, 2, 55, 64, 2);
  g.fill();
  g.strokeStyle = '#c1bb7888';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(64, 2);
  g.lineTo(64, 253);
  g.stroke();
  for (let y = 25; y < 225; y += 17) {
    g.strokeStyle = '#a3aa6f66';
    g.beginPath();
    g.moveTo(64, y + 25);
    g.lineTo(23, y);
    g.moveTo(64, y + 25);
    g.lineTo(105, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** Instanced individual leaves, curved fronds, branching trunks and understory. */
export class Vegetation {
  readonly group = new THREE.Group();
  private matrices: THREE.Matrix4[] = [];
  private colors: THREE.Color[] = [];
  private time = { value: 0 };
  private rng: number;
  constructor(seed = 41) {
    this.rng = seed;
  }
  private random() {
    this.rng = (this.rng * 1664525 + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }
  private leaf(pos: THREE.Vector3, scale: THREE.Vector3, rotation: THREE.Euler, color: string) {
    const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(rotation), scale);
    this.matrices.push(m);
    this.colors.push(new THREE.Color(color));
  }
  private branch(points: THREE.Vector3[], radius: number) {
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 9, radius, 6, false), SURFACE.wood);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }
  palm(x: number, z: number, height = 8) {
    const lean = 0.4 + this.random() * 0.7;
    this.branch(
      [new THREE.Vector3(x, 0, z), new THREE.Vector3(x + lean * 0.3, height * 0.45, z), new THREE.Vector3(x + lean, height, z + 0.25)],
      0.16,
    );
    // Bark ring scars on a tapered coconut trunk.
    for (let i = 1; i < 18; i++) {
      const h = (height * i) / 18;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 3, 8), solid('#746b56'));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x + lean * (i / 18) ** 1.5, h, z + (0.25 * i) / 18);
      this.group.add(ring);
    }
    for (let f = 0; f < 11; f++) {
      const a = (f * Math.PI * 2) / 11 + this.random() * 0.2,
        length = 3 + this.random() * 1.2;
      const points: THREE.Vector3[] = [];
      for (let k = 0; k < 8; k++) {
        const u = k / 7;
        points.push(
          new THREE.Vector3(
            x + lean + Math.cos(a) * length * u,
            height + Math.sin(u * Math.PI) * 0.7 - u * u * 1.7,
            z + 0.25 + Math.sin(a) * length * u,
          ),
        );
      }
      this.branch(points, 0.023);
      for (let k = 1; k < 22; k++)
        for (const side of [-1, 1]) {
          const u = k / 23,
            extent = Math.sin(u * Math.PI) * 0.9;
          const p = new THREE.Vector3(
            x + lean + Math.cos(a) * length * u - Math.sin(a) * side * extent * 0.42,
            height + Math.sin(u * Math.PI) * 0.7 - u * u * 1.7 - 0.08,
            z + 0.25 + Math.sin(a) * length * u + Math.cos(a) * side * extent * 0.42,
          );
          this.leaf(
            p,
            new THREE.Vector3(0.14, extent + 0.15, 1),
            new THREE.Euler(-Math.PI / 2 + 0.3, a + side * 0.65, side * 0.3),
            '#a1ad75',
          );
        }
    }
  }
  tree(x: number, z: number, height = 7) {
    this.branch(
      [new THREE.Vector3(x, 0, z), new THREE.Vector3(x + 0.1, height * 0.55, z), new THREE.Vector3(x - 0.15, height * 0.8, z + 0.3)],
      0.2,
    );
    for (let b = 0; b < 7; b++) {
      const a = b * 2.399 + this.random() * 0.2;
      const center = new THREE.Vector3(x + Math.cos(a) * 1.8, height * (0.64 + this.random() * 0.25), z + Math.sin(a) * 1.8);
      this.branch(
        [new THREE.Vector3(x, height * 0.45, z), new THREE.Vector3(x + Math.cos(a), height * 0.68, z + Math.sin(a)), center],
        0.055,
      );
      for (let j = 0; j < 120; j++) {
        const theta = this.random() * Math.PI * 2,
          r = Math.sqrt(this.random()) * 1.7;
        const pos = center.clone().add(new THREE.Vector3(Math.cos(theta) * r, (this.random() - 0.5) * 1.5, Math.sin(theta) * r));
        this.leaf(
          pos,
          new THREE.Vector3(0.32 + this.random() * 0.3, 0.45 + this.random() * 0.35, 1),
          new THREE.Euler(this.random() * Math.PI, this.random() * Math.PI, this.random() * Math.PI),
          ['#6e8b50', '#8a9c61', '#536f3e'][j % 3],
        );
      }
    }
  }
  shrub(x: number, z: number, radius = 1) {
    for (let i = 0; i < 130; i++) {
      const a = this.random() * Math.PI * 2,
        r = Math.sqrt(this.random()) * radius;
      this.leaf(
        new THREE.Vector3(x + Math.cos(a) * r, 0.2 + this.random() * 0.6, z + Math.sin(a) * r),
        new THREE.Vector3(0.2, 0.4, 1),
        new THREE.Euler(this.random() * 2, this.random() * 6, this.random() * 4),
        '#819661',
      );
    }
  }
  finish() {
    const mat = new THREE.MeshStandardMaterial({
      map: leafTexture(),
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.9,
      vertexColors: false,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.foliageTime = this.time;
      shader.vertexShader = 'uniform float foliageTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
      #ifdef USE_INSTANCING
        transformed.x += sin(foliageTime*1.3 + instanceMatrix[3].x*.5 + instanceMatrix[3].z*.4)*.06*uv.y;
      #endif`,
      );
    };
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1, 1, 2), mat, this.matrices.length);
    this.matrices.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, this.colors[i]);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.matrices = [];
    this.colors = [];
    batchStaticMeshes(this.group);
  }
  update(t: number) {
    this.time.value = t;
  }
}
