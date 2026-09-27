import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** An original architectural illustration. Never a projection of worker or city state. */
export function mountHeadquartersScene(host: HTMLElement, toggle: HTMLButtonElement, status: HTMLElement) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#10191b');
  scene.fog = new THREE.FogExp2('#10191b', 0.011);
  const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 240);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.65;
  room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight('#b9d3db', '#4f3526', 2));
  const sun = new THREE.DirectionalLight('#ffd5a0', 4.5); sun.position.set(-25, 32, 20); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 35, bottom: -28, near: 1, far: 100 });
  sun.shadow.bias = -0.0005; scene.add(sun);
  const rim = new THREE.DirectionalLight('#8baeb8', 2.7); rim.position.set(20, 20, -25); scene.add(rim);
  const materials = {
    glass: new THREE.MeshPhysicalMaterial({ color: '#39545a', roughness: 0.18, metalness: 0.8, clearcoat: 1 }),
    bronze: new THREE.MeshStandardMaterial({ color: '#aa8c67', metalness: 0.7, roughness: 0.35 }),
    concrete: new THREE.MeshStandardMaterial({ color: '#868981', roughness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: '#263235', metalness: 0.35, roughness: 0.55 }),
    road: new THREE.MeshStandardMaterial({ color: '#171f21', roughness: 1 }),
    paving: new THREE.MeshStandardMaterial({ color: '#414c4b', roughness: 0.9 }),
    light: new THREE.MeshStandardMaterial({ color: '#d9b578', emissive: '#ffbf72', emissiveIntensity: 1.25 }),
    window: new THREE.MeshStandardMaterial({ color: '#a58e68', emissive: '#ffb861', emissiveIntensity: 0.45 }),
    leaf: new THREE.MeshStandardMaterial({ color: '#3b5144', roughness: 0.9 }),
    marking: new THREE.MeshStandardMaterial({ color: '#94978b', roughness: 1 }),
  };
  type MaterialName = keyof typeof materials;
  const batches = new Map<MaterialName, THREE.Matrix4[]>();
  const dummy = new THREE.Object3D();
  function box(material: MaterialName, x: number, y: number, z: number, w: number, h: number, d: number) {
    dummy.position.set(x, y, z); dummy.scale.set(w, h, d); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    const list = batches.get(material) ?? []; list.push(dummy.matrix.clone()); batches.set(material, list);
  }
  // Continuous ground, plaza and streets keep the camera grounded in an architectural context.
  box('road', 0, -0.4, 0, 180, 0.5, 180);
  box('paving', 0, -0.03, 0, 32, 0.28, 25);
  box('concrete', 0, 0.1, 0, 29, 0.18, 22);
  box('paving', 0, 0.23, 0, 28.7, 0.12, 21.7);
  for (let i = -8; i <= 8; i++) {
    box('marking', i * 5, -0.12, 17, 2, 0.03, 0.12);
    box('marking', 21, -0.12, i * 5, 0.12, 0.03, 2);
  }
  for (let i = 0; i < 8; i++) box('marking', 11 + i * 0.75, -0.1, 14, 0.4, 0.03, 3);
  for (let i = -6; i <= 6; i++) box('dark', i * 2.1, 0.3, 0, 0.025, 0.01, 21.6);
  for (let i = -4; i <= 4; i++) box('dark', 0, 0.3, i * 2.4, 28.6, 0.01, 0.025);

  function tower(x: number, z: number, width: number, depth: number, floors: number) {
    const base = 2.3, floorHeight = 1.17, height = floors * floorHeight;
    box('glass', x, base + height / 2, z, width, height, depth);
    box('dark', x, 1.18, z, width - 0.9, 2.35, depth - 0.9);
    box('glass', x, 1.25, z + depth / 2 - 0.3, width - 1, 1.9, 0.12);
    for (let f = 0; f <= floors; f++) {
      const y = base + f * floorHeight;
      box('bronze', x, y, z, width + 0.15, 0.075, depth + 0.15);
      for (let c = 0; c < Math.floor(width / 0.8); c++) {
        if ((f * 7 + c * 11) % 9 > 3 && f < floors) {
          const xx = x - width / 2 + 0.45 + c * 0.8;
          box('window', xx, y + 0.53, z + depth / 2 + 0.015, 0.48, 0.64, 0.018);
          if ((c + f) % 3 !== 0) box('window', xx, y + 0.53, z - depth / 2 - 0.015, 0.48, 0.64, 0.018);
        }
      }
      for (let c = 0; c < Math.floor(depth / 0.8); c++) {
        if ((f * 5 + c * 13) % 8 > 3 && f < floors) box('window', x + width / 2 + 0.015, y + 0.53, z - depth / 2 + 0.45 + c * 0.8, 0.018, 0.64, 0.48);
      }
    }
    for (let c = 0; c <= Math.round(width / 0.8); c++) {
      const xx = x - width / 2 + c * width / Math.round(width / 0.8);
      box('bronze', xx, base + height / 2, z + depth / 2 + 0.09, 0.075, height + 0.6, 0.2);
      box('dark', xx, base + height / 2, z - depth / 2 - 0.05, 0.055, height + 0.3, 0.12);
    }
    for (let c = 0; c <= Math.round(depth / 0.8); c++) {
      const zz = z - depth / 2 + c * depth / Math.round(depth / 0.8);
      box('bronze', x + width / 2 + 0.09, base + height / 2, zz, 0.2, height + 0.6, 0.075);
    }
    box('dark', x, base + height + 0.1, z, width + 0.3, 0.3, depth + 0.3);
    box('light', x, base + height - 0.1, z + depth / 2 + 0.13, width + 0.2, 0.06, 0.07);
    box('dark', x, base + height + 0.65, z - 0.6, width * 0.55, 1.2, depth * 0.5);
    for (let i = 0; i < 6; i++) box('bronze', x - width * 0.3 + i * width * 0.12, base + height + 1.3, z - 0.6, 0.1, 0.15, depth * 0.6);
  }
  tower(1, -2.2, 8.4, 7.4, 23);
  tower(-6.9, -1.2, 5.2, 6, 13);
  // Ground-floor lobby, canopy, stairs and a planted roof terrace.
  box('glass', -2.2, 1.35, 3.2, 14, 2.4, 3.6);
  box('dark', -2.2, 2.65, 3.2, 14.5, 0.24, 4);
  box('bronze', 0.4, 2.75, 5.8, 5.5, 0.14, 3.1);
  box('light', 0.4, 2.65, 7.3, 5.4, 0.04, 0.06);
  for (let i = 0; i < 3; i++) box('concrete', 0.4, 0.23 + i * 0.075, 7.2 - i * 0.3, 5.5, 0.15, 0.6);
  for (let i = -1; i < 2; i++) box('bronze', 0.4 + i * 1.4, 1.3, 5.05, 0.08, 2.5, 0.08);
  for (let i = -1; i <= 1; i++) { box('dark', 10, 0.65, i * 4.8, 3, 0.7, 2.5); box('leaf', 10, 1.03, i * 4.8, 2.8, 0.15, 2.3); }
  // Quiet, distant architecture gives depth without fabricating sectors or workers.
  for (let i = 0; i < 13; i++) {
    const x = -48 + i * 8, h = 4 + (i * 7) % 13;
    box('dark', x, h / 2 - 0.2, -30 - (i % 3) * 5, 5 + i % 3, h, 6);
    for (let f = 1; f < h; f += 1.8) box('paving', x, f, -26.9 - (i % 3) * 5, 4.6, 0.05, 0.1);
  }
  const cube = new THREE.BoxGeometry(1, 1, 1);
  for (const [name, transforms] of batches) {
    const mesh = new THREE.InstancedMesh(cube, materials[name], transforms.length);
    transforms.forEach((matrix, i) => mesh.setMatrixAt(i, matrix)); mesh.computeBoundingSphere(); mesh.castShadow = !['road', 'light', 'window', 'marking'].includes(name); mesh.receiveShadow = true; scene.add(mesh);
  }
  const foliageGeometry = new THREE.IcosahedronGeometry(1, 2);
  const foliage = new THREE.InstancedMesh(foliageGeometry, materials.leaf, 18);
  for (let i = 0; i < 18; i++) {
    const x = i < 9 ? -13 : 12.7, z = -9 + (i % 9) * 2.5;
    dummy.position.set(x, 1.65 + (i % 2) * 0.15, z); dummy.scale.set(0.7, 1.25, 0.8); dummy.updateMatrix(); foliage.setMatrixAt(i, dummy.matrix);
  }
  foliage.computeBoundingSphere(); scene.add(foliage);
  const cameraTarget = new THREE.Vector3(-1, 12.2, 0);
  let alive = true, visible = true, paused = reduce.matches, failed = false;
  let frame = 0, previous = 0, phase = 0, pointerX = 0, pointerY = 0, smoothX = 0, smoothY = 0;
  let view = 0, orbit = 0.68;
  const pointerSurface = host.parentElement ?? host;
  const buttons = host.parentElement?.querySelectorAll<HTMLButtonElement>('[data-scene-view]') ?? [];
  const angleByView = [0.68, -0.43, 1.7];
  function updateLabel() {
    toggle.textContent = failed ? '3D unavailable' : paused ? 'Enable camera motion' : 'Pause camera motion';
    toggle.setAttribute('aria-pressed', String(!paused)); toggle.disabled = failed; toggle.removeAttribute('aria-disabled');
    buttons.forEach(button => { button.disabled = failed; });
    status.textContent = failed ? '3D unavailable · architectural illustration' : paused ? '3D architecture · motion paused' : '3D architecture · move your pointer to look around';
  }
  function draw() {
    const wide = host.clientWidth / Math.max(1, host.clientHeight);
    camera.aspect = wide;
    if (wide > 1.65) camera.setViewOffset(host.clientWidth, host.clientHeight, -host.clientWidth * 0.2, 0, host.clientWidth, host.clientHeight);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    const radius = wide < 0.9 ? 76 : 64;
    const theta = orbit + smoothX * 0.085 + (paused ? 0 : Math.sin(phase * 0.16) * 0.018);
    camera.position.set(Math.sin(theta) * radius, 30 + smoothY * 2, Math.cos(theta) * radius);
    camera.lookAt(cameraTarget); renderer.render(scene, camera);
    renderer.shadowMap.autoUpdate = false;
  }
  function tick(now: number) {
    frame = 0;
    if (!alive || !visible || document.hidden || failed) return;
    if (paused || !previous || now - previous >= 1000 / 30) {
      const delta = Math.min((now - previous) / 1000 || 0, 0.05); previous = now;
      phase += delta;
      smoothX += (pointerX - smoothX) * 0.08; smoothY += (pointerY - smoothY) * 0.08;
      orbit += (angleByView[view] - orbit) * 0.07;
      draw();
    }
    if (!paused) frame = requestAnimationFrame(tick);
  }
  function requestDraw() { if (!frame && alive && visible && !document.hidden && !failed) frame = requestAnimationFrame(tick); }
  function resize() { renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false); requestDraw(); }
  function onPointer(e: PointerEvent) {
    if (paused || e.pointerType === 'touch') return;
    const rect = host.getBoundingClientRect(); pointerX = (e.clientX - rect.left) / rect.width * 2 - 1; pointerY = (e.clientY - rect.top) / rect.height * 2 - 1;
  }
  function onLeave() { pointerX = pointerY = 0; }
  function onToggle() { paused = !paused; if (paused) { cancelAnimationFrame(frame); frame = 0; smoothX = smoothY = pointerX = pointerY = 0; } updateLabel(); requestDraw(); }
  function onReduce() { paused = reduce.matches; onLeave(); smoothX = smoothY = 0; updateLabel(); requestDraw(); }
  function onVisibility() { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else { previous = 0; requestDraw(); } }
  function onLoss(e: Event) { e.preventDefault(); failed = true; cancelAnimationFrame(frame); frame = 0; canvas.style.display = 'none'; host.dataset.sceneState = 'fallback'; updateLabel(); }
  const viewHandlers: Array<[HTMLButtonElement, () => void]> = [];
  buttons.forEach((button, i) => {
    const handler = () => { view = Math.min(i, 2); if (paused) orbit = angleByView[view]; buttons.forEach(b => b.setAttribute('aria-pressed', String(b === button))); requestDraw(); };
    button.addEventListener('click', handler); viewHandlers.push([button, handler]);
  });
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
  const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; if (!visible) { cancelAnimationFrame(frame); frame = 0; } else requestDraw(); }); intersection.observe(host);
  pointerSurface.addEventListener('pointermove', onPointer); pointerSurface.addEventListener('pointerleave', onLeave);
  toggle.addEventListener('click', onToggle); reduce.addEventListener('change', onReduce);
  document.addEventListener('visibilitychange', onVisibility); canvas.addEventListener('webglcontextlost', onLoss);
  host.append(canvas); host.dataset.sceneState = 'ready'; toggle.disabled = false; updateLabel(); resize();
  return () => {
    alive = false; cancelAnimationFrame(frame); resizeObserver.disconnect(); intersection.disconnect();
    pointerSurface.removeEventListener('pointermove', onPointer); pointerSurface.removeEventListener('pointerleave', onLeave);
    toggle.removeEventListener('click', onToggle); reduce.removeEventListener('change', onReduce);
    document.removeEventListener('visibilitychange', onVisibility); canvas.removeEventListener('webglcontextlost', onLoss);
    viewHandlers.forEach(([b, handler]) => { b.removeEventListener('click', handler); b.disabled = true; });
    cube.dispose(); foliageGeometry.dispose(); Object.values(materials).forEach(m => m.dispose()); environment.dispose(); renderer.dispose(); canvas.remove(); host.dataset.sceneState = 'fallback';
  };
}
