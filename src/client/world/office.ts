import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { desksOnFloor, deskIndex, FLOOR_RISE } from '../../shared/layout';
import { buildElevator } from './elevator';
import { batchStaticMeshes } from './batching';
import { slidingDoor } from './doors';
import * as THREE from 'three';
import { SURFACE, boxMesh } from './materials';
import { Vegetation } from './vegetation';
import { BOARDS, DESKS, DESK_SIZE, FLOOR, LOFT, STAIRS, TV, WALL_HEIGHT, deskSeat, type DeskDef } from '../../shared/layout';
import { wallFacing, type WallId, type WallRect } from '../../shared/decor';
import { mesh, roundedBox, textPlane, toon } from './toon';
import { deskAccessories, furnishOffice } from './furnishing';
import { FOUNDER_DESK, FURNISHING_FIXTURES, LOFT_COUCH, LOFT_PLANT } from './furnishing-layout';
import { buildExecutiveDesks } from './executives';
import { buildInboxTray, type InboxTray } from './inbox-tray';
import type { ExecutiveRole } from '../../shared/org';
import { buildAmenities } from './amenities';

export interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
  /** Underside, for things you walk beneath (the loft). Defaults to the floor. */
  bottom?: number;
}

export type InteractKind = 'desk' | 'issues' | 'pulls' | 'services' | 'queue' | 'tv' | 'coffee' | 'gym' | 'cafeteria' | 'decor' | 'elevator' | 'executive' | 'inbox';

/** Something you can use. Its scene object carries it as `userData.interact`, for clicking. */
export interface Interactable {
  kind: InteractKind;
  x: number;
  z: number;
  radius: number;
  deskId?: string;
  decorId?: string;
  /** An executive's office in the loft (ORG-01). */
  role?: ExecutiveRole;
  /** Floor height it is used from (the loft); absent means the ground floor of the office group. */
  y?: number;
}

export interface DeskView {
  def: DeskDef;
  group: THREE.Group;
  /** Local-space anchor for the laptop (on the desk top). */
  laptopAnchor: THREE.Object3D;
  /** Local-space anchor where the worker sits. */
  seatAnchor: THREE.Object3D;
  chair: THREE.Group;
  vacancy: THREE.Group;
  screens: THREE.Mesh[];
  setScreen(texture?: THREE.Texture): void;
  screenTexture?: THREE.Texture;
}

export interface Office {
  group: THREE.Group;
  colliders: Collider[];
  interactables: Interactable[];
  /** The loft's executive desks; only HQ's ground-floor office has executives. */
  executiveInteractables: Interactable[];
  /** ORG-03: the CEO's inbox tray on the founder's desk in the loft. */
  inboxTray: InboxTray;
  desks: Map<string, DeskView>;
  boardMeshes: Record<keyof typeof BOARDS, THREE.Mesh>;
  tvScreen: THREE.Mesh;
  /** What's already on the walls (boards, the TV, windows…), so pictures don't hang over it. */
  fixtures(): WallRect[];
  setProjectName(name: string): void;
  update(t: number): void;
  entranceDoor: ReturnType<typeof slidingDoor>;
  elevator: ReturnType<typeof buildElevator>;
  floor: number;
  setFloor(floor: number, capacity: number): void;
  setElevation(y: number): void;
}

const PALETTE = {
  floor: '#afa28c',
  floorAlt: '#998e7d',
  wall: '#dedbd3',
  wallTrim: '#353e41',
  desk: '#c9c4b7',
  deskLeg: '#272e30',
  wood: '#806c54',
  cork: '#d8a86a',
  chairs: ['#475555', '#3f4a50', '#566058', '#454f52', '#485859', '#4a5050'],
  rugs: ['#62665e', '#656963', '#6b6c62', '#5e6462'],
  plant: '#5fb760',
  plantDark: '#3f8f45',
  pot: '#737568',
  glass: '#bfe6ff',
  ink: '#2b2d42',
};

function floorTexture(width = FLOOR.maxX - FLOOR.minX, depth = FLOOR.maxZ - FLOOR.minZ, kind='color'): THREE.Texture {
  const t = new THREE.TextureLoader().load(`/textures/oak-${kind}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(width/3.4, depth/3.4);
  if(kind==='color')t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function box(w: number, h: number, d: number) {
  return new THREE.BoxGeometry(w, h, d);
}

function plant(scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.5, 12), toon(PALETTE.pot), 0, 0.25, 0));
  const leaves = new Vegetation(52);
  leaves.palm(0,0,6);leaves.finish();leaves.group.position.y=.4;
  leaves.group.scale.set(.16,.22,.16);g.add(leaves.group);
  g.scale.setScalar(scale);
  return g;
}

function pendant(): THREE.Group {
  const lamp = new THREE.Group();
  lamp.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.6, 4), toon(PALETTE.ink), 0, 0.3, 0, false));
  lamp.add(mesh(new THREE.ConeGeometry(0.5, 0.45, 16, 1, true), toon('#343a3c'), 0, 0, 0, false));
  lamp.add(mesh(new THREE.SphereGeometry(0.16, 10, 8), toon('#fff7d6', { emissive: '#ffe08a' }), 0, -0.15, 0, false));
  lamp.scale.setScalar(0.8);
  return lamp;
}

/** An outside window: frame, sky-blue glass and a mullion, facing +z (or +x when `side`). */
function outsideWindow(x: number, y: number, z: number, side = false): THREE.Group {
  const glass = SURFACE.glass.clone();glass.opacity=.28;glass.color.set('#b8cdd1');glass.roughness=.12;
  const frameMat = toon('#ffffff');
  const w = new THREE.Group();
  for(const y of [-1,1])w.add(mesh(box(3.2,.10,.12),frameMat,0,y,0,false));
  for(const x of [-1.55,1.55])w.add(mesh(box(.10,2,.12),frameMat,x,0,0,false));
  w.add(mesh(box(3.02,1.9,.025),glass,0,0,0,false));
  w.add(mesh(box(0.08, 1.7, 0.14), frameMat, 0, 0, 0, false));
  w.position.set(x, y, z);
  if (side) w.rotation.y = Math.PI / 2;
  return w;
}

function chair(color: string): THREE.Group {
  const g = new THREE.Group();
  const mat = toon(color);
  g.add(mesh(roundedBox(0.62, 0.1, 0.58, 0.12), mat, 0, 0.5, 0));
  const back = mesh(roundedBox(0.62, 0.1, 0.6, 0.12), mat, 0, 0.86, 0.27);
  back.rotation.x = Math.PI / 2 - 0.12;
  g.add(back);
  g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8), toon(PALETTE.deskLeg), 0, 0.26, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = mesh(box(0.05, 0.04, 0.32), toon(PALETTE.deskLeg), Math.sin(a) * 0.15, 0.05, Math.cos(a) * 0.15);
    leg.rotation.y = a;
    g.add(leg);
  }
  return g;
}

function buildDesk(def: DeskDef, index: number): DeskView {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const { width, depth, height } = DESK_SIZE;
  group.add(mesh(roundedBox(width - 0.06, 0.08, depth - 0.04, 0.08), toon(PALETTE.desk), 0, height - 0.04, 0));
  const legMat = toon('#8d99ae');
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, height - 0.08, 8), legMat, sx * (width / 2 - 0.14), (height - 0.08) / 2, sz * (depth / 2 - 0.12)));
    }
  }
  // Modesty panel facing away from the worker
  group.add(mesh(box(width - 0.3, 0.32, 0.03), toon(PALETTE.wallTrim), 0, height - 0.26, -depth / 2 + 0.06));
  // Little desk decorations
  const deco = index % 3;
  if (deco === 0) {
    const mug = mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.12, 10), toon(PALETTE.chairs[index % 6]), width / 2 - 0.25, height + 0.06, -0.2);
    group.add(mug);
  } else if (deco === 1) {
    const p = plant(0.35);
    p.position.set(-width / 2 + 0.25, height, -0.25);
    group.add(p);
  } else {
    const books = new THREE.Group();
    ['#e63946', '#457b9d', '#f4a261'].forEach((c, i) => books.add(mesh(box(0.08, 0.24, 0.18), toon(c), i * 0.09, 0.12, 0)));
    books.position.set(width / 2 - 0.35, height, -0.3);
    group.add(books);
  }
  deskAccessories(group, index, height);

  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(0, height, 0.02);
  group.add(laptopAnchor);

  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0, 0.85);
  group.add(seatAnchor);

  const ch = chair(PALETTE.chairs[index % PALETTE.chairs.length]);
  ch.position.set(0, 0, 0.9);
  group.add(ch);

  // A desk nameplate identifies a free workstation at a believable physical scale.
  const vacancy = new THREE.Group();
  vacancy.add(mesh(box(.42,.14,.025),SURFACE.frame,0,0,0,false));
  const available=textPlane('AVAILABLE',{color:'#d6dfcf',size:32});
  available.scale.setScalar(.35/available.geometry.parameters.width);
  available.position.z=.016;vacancy.add(available);
  vacancy.position.set(0,height+.075,-.35);
  group.add(vacancy);

  const view: DeskView = { def, group, laptopAnchor, seatAnchor, chair: ch, vacancy, screens: [],
    setScreen(texture?: THREE.Texture) {
      view.screenTexture = texture;
      for (const screen of view.screens) {
        if (screen.material !== screen.userData.standby) (screen.material as THREE.Material).dispose();
        screen.material = texture ? new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }) : screen.userData.standby;
      }
    },
  };
  return view;
}

/** A framed board on a wall; the face gets a canvas texture (cork, chalk or whiteboard). */
function wallBoard(width: number, height: number, frameColor: string): { group: THREE.Group; face: THREE.Mesh } {
  const group = new THREE.Group();
  const frame = mesh(roundedBox(width + 0.3, 0.12, height + 0.3, 0.1), toon(frameColor), 0, 0, 0);
  frame.rotation.x = Math.PI / 2;
  group.add(frame);
  const faceMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), faceMat);
  face.position.z = 0.07;
  group.add(face);
  return { group, face };
}

export function buildOffice(): Office {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const interactables: Interactable[] = [];
  const fixtures: WallRect[] = [];
  const fixture = (wall: WallId, u: number, y: number, w: number, h: number) => fixtures.push({ wall, u0: u - w / 2, u1: u + w / 2, y0: y - h / 2, y1: y + h / 2 });
  const width = FLOOR.maxX - FLOOR.minX;
  const depth = FLOOR.maxZ - FLOOR.minZ;
  const cx = (FLOOR.maxX + FLOOR.minX) / 2;
  const cz = (FLOOR.maxZ + FLOOR.minZ) / 2;

  const fill = new THREE.HemisphereLight('#e9edea', '#776955', 1.15);
  group.add(fill);
  for(const x of [-11,-2,7]) for(const z of [-5,5]) {
    const light = new THREE.PointLight('#fff2dc',12,11,2);
    light.position.set(x,3.3,z);group.add(light);
  }
  // Enclose the main workspace; the elevated stair/loft bay has its own higher ceiling.
  const ceiling=(minX:number,maxX:number,minZ:number,maxZ:number,y:number)=>{
    boxMesh(group,maxX-minX,.15,maxZ-minZ,SURFACE.plaster,(minX+maxX)/2,y+.075,(minZ+maxZ)/2);
    colliders.push({minX,maxX,minZ,maxZ,bottom:y,top:y+.15});
  };
  ceiling(FLOOR.minX,3,FLOOR.minZ,FLOOR.maxZ,4.2);
  ceiling(3,FLOOR.maxX,FLOOR.minZ,8,4.2);
  ceiling(3,FLOOR.maxX,8,FLOOR.maxZ,5.8);
  boxMesh(group,6,1.6,.04,SURFACE.glass,6,5,13.1);
  for(const y of [4.2,5.8])boxMesh(group,6,.12,.14,SURFACE.frame,6,y,13.1);
  for(const x of [3,6,9])boxMesh(group,.09,1.6,.14,SURFACE.frame,x,5,13.1);
  const strip=new THREE.MeshStandardMaterial({color:'#ffeed6',emissive:'#ffeed6',emissiveIntensity:2});
  for(const x of [-13,-6,1,8])for(const z of [-8,0,7]) {
    boxMesh(group,3.8,.03,.09,strip,x,4.12,z);
  }
  for(let x=-17;x<18;x+=2.8)boxMesh(group,.03,.04,20,SURFACE.frame,x,4.15,-2.5);
  // Floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshStandardMaterial({map:floorTexture(),normalMap:floorTexture(width,depth,'normal'),roughnessMap:floorTexture(width,depth,'rough'),roughness:.66,normalScale:new THREE.Vector2(.22,.22)}));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  group.add(floor);

  // Outside ground so windows don't look into the void
  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), SURFACE.concrete);
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.y = -0.02;
  group.add(lawn);

  // Rugs under each desk cluster
  [
    [-10.5, -4],
    [-1.5, -4],
    [-10.5, 4],
    [-1.5, 4],
  ].forEach(([x, z], i) => {
    const rug = mesh(roundedBox(6.2, 0.02, 4.6, 0.6), toon(PALETTE.rugs[i]), x, 0.011, z, false);
    group.add(rug);
  });

  // Walls
  const wallMat = toon(PALETTE.wall);
  const trimMat = toon(PALETTE.wallTrim);
  const T = 0.3;
  const walls: [number, number, number, number][] = [
    // x, z, w, d
    [cx, FLOOR.minZ - T / 2, width + T * 2, T],
    [-9.85, FLOOR.maxZ + T / 2, 16.9, T],
    [9.85, FLOOR.maxZ + T / 2, 16.9, T],
    [FLOOR.minX - T / 2, cz, T, depth],
    [FLOOR.maxX + T / 2, cz, T, depth],
  ];
  for (const [x, z, w, d] of walls) {
    const horizontal=d<w;
    const openings=z>FLOOR.maxZ&&x<0?[-14,-9,-5]:x<FLOOR.minX?[-9,-3,3]:[];
    const put=(length:number,center:number,y:number,height:number)=>group.add(mesh(box(horizontal?length:w,height,horizontal?d:length),wallMat,horizontal?center:x,y,horizontal?z:center));
    if(!openings.length)put(horizontal?w:d,horizontal?x:z,WALL_HEIGHT/2,WALL_HEIGHT);
    else {
      put(horizontal?w:d,horizontal?x:z,.6,1.2);
      put(horizontal?w:d,horizontal?x:z,3.2+(WALL_HEIGHT-3.2)/2,WALL_HEIGHT-3.2);
      let cursor=(horizontal?x-w/2:z-d/2);const end=horizontal?x+w/2:z+d/2;
      for(const center of openings){const a=center-1.62,b=center+1.62;if(a>cursor)put(a-cursor,(a+cursor)/2,WALL_HEIGHT/2,WALL_HEIGHT);cursor=b;}
      if(cursor<end)put(end-cursor,(end+cursor)/2,WALL_HEIGHT/2,WALL_HEIGHT);
    }
    group.add(mesh(box(w + 0.02, 0.25, d + 0.04), trimMat, x, 0.125, z, false));
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: 99 });
  }

  boxMesh(group,2.8,1.3,.3,SURFACE.plaster,0,3.55,13.15);
  const entranceDoor = slidingDoor(group,0,12.95,2.8);
  const exitSign=textPlane('EXIT / WATERFRONT', {size:48,color:'#c6d9cc'});
  exitSign.position.set(0,3.18,12.9);exitSign.rotation.y=Math.PI;group.add(exitSign);
  boxMesh(group,3,.08,3,SURFACE.stone,0,-.01,14);
  fixture('south',0,1.8,3.2,3.6);
  for(const x of [-2.6,2.6]) {
    boxMesh(group,1.4,3.9,.12,SURFACE.wood,x,1.95,12.91);
    for(let dx=-.6;dx<.7;dx+=.18)boxMesh(group,.045,3.9,.09,SURFACE.frame,x+dx,1.95,12.81);
  }


  // Windows on the south and west walls (none behind the loft's stairs)
  for (const x of [-14,-9,-5]) {
    if (x + 1.6 > STAIRS.fromX) continue;
    group.add(outsideWindow(x, 2.2, FLOOR.maxZ - 0.02));
    fixture('south', x, 2.2, 3.2, 2);
  }
  for (let z = -9; z <= 6; z += 6) {
    group.add(outsideWindow(FLOOR.minX + 0.02, 2.2, z, true));
    fixture('west', z, 2.2, 3.2, 2);
  }

  // A planted terrace and adjacent facades give the real window openings spatial depth.
  const terrace=new Vegetation(131);group.add(terrace.group);
  for(const z of [-11,-2,8])terrace.tree(-24,z,6.5);
  for(const x of [-12,-5,7])terrace.palm(x,21,7);
  terrace.finish();
  for(const z of [-10,4,18]) {
    boxMesh(group,10,9,9,SURFACE.concrete,-37,4.5,z);
    boxMesh(group,.04,7.8,8.7,SURFACE.glass,-31.97,4.5,z);
    for(let dz=-4;dz<=4;dz+=1.4)boxMesh(group,.1,8,.05,SURFACE.frame,-31.9,4.5,z+dz);
    for(const y of [1,4,7,9])boxMesh(group,.3,.14,9.3,SURFACE.stone,-31.9,y,z);
  }
  boxMesh(group,4,.1,38,SURFACE.wood,-21,-.03,0);

  // Desks
  const deskColliders: Collider[] = [];
  const deskInteractions: Interactable[] = [];
  const desks = new Map<string, DeskView>();
  DESKS.forEach((def, i) => {
    const view = buildDesk(def, i);
    group.add(view.group);
    desks.set(def.id, view);
    const hw = DESK_SIZE.width / 2 - 0.05;
    const hd = DESK_SIZE.depth / 2 - 0.02;
    const obstacle = { minX: def.x - hw, maxX: def.x + hw, minZ: def.z - hd, maxZ: def.z + hd, top: DESK_SIZE.height };
    colliders.push(obstacle); deskColliders.push(obstacle);
    const seat = deskSeat(def, 1.25);
    const it: Interactable = { kind: 'desk', deskId: def.id, x: seat.x, z: seat.z, radius: 1.3 };
    interactables.push(it); deskInteractions.push(it);
    view.group.userData.interact = it;
  });

  // Original Blender-authored monitor arms, two displays and a ventilated desktop computer.
  new GLTFLoader().load('/models/workstation.glb', asset => {
    for (const desk of views) {
      const accessories = asset.scene.clone(true);
      accessories.traverse(o => { if (o instanceof THREE.Mesh) {
        o.castShadow = true; o.receiveShadow = true;
        if (o.name.startsWith('MonitorScreen')) { o.userData.standby = o.material; desk.screens.push(o); }
      } });
      desk.setScreen(desk.screenTexture);
      desk.group.add(accessories);
    }
  }, undefined, error => console.warn('Workstation accessories unavailable', error));
  const elevator = buildElevator(); group.add(elevator.group);
  colliders.push(...elevator.colliders);
  const elevatorInteraction: Interactable = { kind: 'elevator', x: 7, z: -6.4, radius: 3 };
  elevator.group.userData.interact = elevatorInteraction;
  interactables.push(elevatorInteraction);
  // A support slab is needed above ground level for physics and camera collision.
  colliders.push({ ...FLOOR, top: 0, bottom: -.2 });

  // Cork boards on the walls
  const boardMeshes = {} as Office['boardMeshes'];
  for (const key of Object.keys(BOARDS) as (keyof typeof BOARDS)[]) {
    const b = BOARDS[key];
    // Out from the wall, the way the board faces.
    const nx = Math.sin(b.rotY);
    const nz = Math.cos(b.rotY);
    // The queue is a whiteboard in an aluminium frame; the others hang in wood.
    const { group: bg, face } = wallBoard(b.width, b.height, key === 'queue' ? '#aab4be' : PALETTE.wood);
    bg.position.set(b.x + nx * 0.08, b.y, b.z + nz * 0.08);
    bg.rotation.y = b.rotY;
    group.add(bg);
    boardMeshes[key] = face;
    const label = textPlane(b.label, { color: '#303b3e', size: 64 });
    label.scale.multiplyScalar(1.3);
    label.position.set(b.x + nx * 0.04, b.y + b.height / 2 + 0.5, b.z + nz * 0.04);
    label.rotation.y = b.rotY;
    group.add(label);
    const it: Interactable = { kind: key, x: b.x + nx * 1.6, z: b.z + nz * 1.6, radius: 2.4 };
    interactables.push(it);
    bg.userData.interact = it;
    // The board and its label above it, up to the ceiling.
    const wall = wallFacing(b.rotY);
    const bottom = b.y - (b.height + 0.3) / 2;
    fixture(wall, wall === 'north' || wall === 'south' ? b.x : b.z, (bottom + WALL_HEIGHT) / 2, b.width + 0.3, WALL_HEIGHT - bottom);
  }

  // Lounge: TV, couch, coffee table, beanbags
  const tvGroup = new THREE.Group();
  tvGroup.add(mesh(roundedBox(TV.width + 0.3, 0.14, TV.height + 0.3, 0.12), toon(PALETTE.ink), 0, 0, 0));
  (tvGroup.children[0] as THREE.Mesh).rotation.x = Math.PI / 2;
  const tvScreen = new THREE.Mesh(new THREE.PlaneGeometry(TV.width, TV.height), new THREE.MeshBasicMaterial({ color: '#1b1d2e' }));
  tvScreen.position.z = 0.08;
  tvGroup.add(tvScreen);
  tvGroup.position.set(TV.x - 0.1, TV.y, TV.z);
  tvGroup.rotation.y = -Math.PI / 2;
  group.add(tvGroup);
  const tv: Interactable = { kind: 'tv', x: TV.x - 4.5, z: TV.z, radius: 3.2 };
  interactables.push(tv);
  tvGroup.userData.interact = tv;
  fixture('east', TV.z, TV.y, TV.width + 0.3, TV.height + 0.3);

  const couch = new THREE.Group();
  const couchMat = SURFACE.fabric;
  couch.add(mesh(roundedBox(1, 0.45, 4.2, 0.2), couchMat, 0, 0.3, 0));
  couch.add(mesh(roundedBox(0.35, 0.9, 4.2, 0.15), couchMat, -0.45, 0.55, 0));
  couch.add(mesh(roundedBox(1, 0.7, 0.35, 0.15), couchMat, 0, 0.45, -2.0));
  couch.add(mesh(roundedBox(1, 0.7, 0.35, 0.15), couchMat, 0, 0.45, 2.0));
  ['#b1a18a', '#7c8f88'].forEach((c, i) => couch.add(mesh(roundedBox(0.2, 0.45, 0.5, 0.1), toon(c), -0.2, 0.75, i ? 0.9 : -0.9)));
  couch.position.set(10.5, 0, 0);
  group.add(couch);
  colliders.push({ minX: 10, maxX: 11, minZ: -2.2, maxZ: 2.2, top: 0.55 });

  const table = new THREE.Group();
  table.add(mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.08, 24), toon(PALETTE.wood), 0, 0.42, 0));
  table.add(mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.4, 12), toon(PALETTE.deskLeg), 0, 0.2, 0));
  table.position.set(13, 0, 0);
  group.add(table);
  colliders.push({ minX: 12.2, maxX: 13.8, minZ: -0.8, maxZ: 0.8, top: 0.46 });
  const lounge = mesh(roundedBox(7, 0.02, 7, 1.2), toon('#626a68'), 13.4, 0.011, 0, false);
  group.add(lounge);

  [
    ['#536969', 12.5, 3.5],
    ['#343a3c', 14.5, -3.4],
  ].forEach(([c, x, z]) => {
    const bean = mesh(new THREE.SphereGeometry(0.6, 16, 12), toon(c as string), x as number, 0.35, z as number);
    bean.scale.y = 0.6;
    group.add(bean);
    colliders.push({ minX: (x as number) - 0.5, maxX: (x as number) + 0.5, minZ: (z as number) - 0.5, maxZ: (z as number) + 0.5, top: 0.6 });
  });

  // Kitchen corner: counter + coffee machine + fridge
  const kitchen = new THREE.Group();
  kitchen.add(mesh(box(5, 0.95, 1), toon('#647474'), 0, 0.475, 0));
  kitchen.add(mesh(box(5.1, 0.08, 1.1), toon(PALETTE.desk), 0, 0.99, 0));
  const coffee = new THREE.Group();
  coffee.add(mesh(roundedBox(0.6, 0.7, 0.5, 0.08), toon('#343a40'), 0, 0.35, 0));
  coffee.add(mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.14, 10), toon('#ffffff'), 0, 0.1, 0.12));
  coffee.add(mesh(new THREE.SphereGeometry(0.05, 8, 8), toon('#ef476f', { emissive: '#ef476f' }), 0.18, 0.55, 0.26));
  coffee.position.set(-1.2, 1.03, 0);
  kitchen.add(coffee);
  kitchen.add(mesh(roundedBox(1.1, 2.2, 1, 0.1), toon('#f8f9fa'), 3.2, 1.1, 0));
  kitchen.add(mesh(box(0.06, 0.5, 0.06), toon('#adb5bd'), 2.75, 1.4, 0.52));
  kitchen.position.set(-14.5, 0, 12.2);
  group.add(kitchen);
  colliders.push({ minX: -17, maxX: -12, minZ: 11.7, maxZ: 12.7, top: 1.03 });
  colliders.push({ minX: -11.85, maxX: -10.75, minZ: 11.7, maxZ: 12.7, top: 2.2 });
  const cup: Interactable = { kind: 'coffee', x: -15.7, z: 10.9, radius: 1.4 };
  interactables.push(cup);
  coffee.userData.interact = cup;
  // Counter, coffee machine and fridge, in front of the south wall.
  fixture('south', -14.5, 0.55, 5.1, 1.1);
  fixture('south', -15.7, 0.9, 0.6, 1.8);
  fixture('south', -11.3, 1.1, 1.1, 2.2);

  // Plants around the room
  const plants: [number, number, number][] = [
    [-17.2, -12.2, 1.4],
    [17.2, -12.2, 1.5],
    [17.2, 12.2, 1.3],
    [-17.2, 8.5, 1.2],
    [5.5, -12.2, 1.1],
    [-6, 0, 1],
    [3.5, 0, 0.9],
    [8.5, 5, 1.1],
  ];
  for (const [x, z, s] of plants) {
    const p = plant(s);
    p.position.set(x, 0, z);
    group.add(p);
    const r = 0.3 * s;
    colliders.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, top: 0.5 * s });
  }

  // Ceiling lamps (floating cartoon pendants)
  for (const [x, z] of [
    [-10.5, -4],
    [-1.5, -4],
    [-10.5, 4],
    [-1.5, 4],
    [13, 0],
  ]) {
    const lamp = pendant();
    lamp.position.set(x, WALL_HEIGHT - 0.15, z);
    group.add(lamp);
  }

  // Meeting area, reception, kitchen details, storage and print corner; pushed before elevation offsets are captured.
  colliders.push(...furnishOffice(group));
  // Gym corner, cafeteria and the expanded coffee bar (their footprints are in FURNISHING_COLLIDERS).
  interactables.push(...buildAmenities(group));
  for (const f of FURNISHING_FIXTURES) fixture(...f);

  const { interactables: executiveInteractables, tray: inboxTray } = buildLoft(group, colliders);
  // Pictures stay clear of the stairs (step by step, so they can hang above them) and of what's on
  // the loft's walls upstairs, as buildLoft places it: a window on each wall, the couch, the sign.
  const run = (STAIRS.toX - STAIRS.fromX) / STAIRS.steps;
  const rise = LOFT.y / STAIRS.steps;
  for (let i = 1; i <= STAIRS.steps; i++) fixture('south', STAIRS.fromX + (i - 0.5) * run, (i * rise) / 2, run, i * rise);
  const loftZ = (LOFT.minZ + LOFT.maxZ) / 2;
  fixture('south', LOFT.minX + 2, LOFT.y + 1.5, 3.2, 2);
  fixture('east', loftZ, LOFT.y + 1.5, 3.2, 2);
  fixture('east', LOFT_COUCH.z, LOFT.y + 0.5, 2.4, 1);
  fixture('south', LOFT.maxX - 3, LOFT.y + 1.9, 2.6, 0.6);

  let nameSign: ReturnType<typeof textPlane> | null = null;
  let signRect: WallRect | null = null;
  const setProjectName = (name: string) => {
    if (nameSign) {
      group.remove(nameSign);
      nameSign.material.map?.dispose();
      nameSign.material.dispose();
      nameSign.geometry.dispose();
    }
    nameSign = textPlane(name.toUpperCase(), { color: '#303b3e', size: 64 });
    nameSign.position.set(8, 2.6, FLOOR.minZ + 0.06);
    nameSign.scale.multiplyScalar(1.3);
    group.add(nameSign);
    const { width: sw, height: sh } = nameSign.geometry.parameters;
    signRect = { wall: 'north', u0: 8 - (sw * 2.2) / 2, u1: 8 + (sw * 2.2) / 2, y0: 2.6 - (sh * 2.2) / 2, y1: 2.6 + (sh * 2.2) / 2 };
  };

  const update = (t: number) => {
    for (const d of desks.values()) {
      if (!d.vacancy.visible) continue;
      d.vacancy.position.y = DESK_SIZE.height + .075;
      d.vacancy.rotation.y = 0;
    }
  };

  // Merge only stationary siblings, preserving desk, fixture and sliding-leaf groups.
  const optimize=(node:THREE.Group)=>{for(const child of [...node.children])if(child instanceof THREE.Group)optimize(child);batchStaticMeshes(node);};
  optimize(group);

  const views = [...desks.values()];
  const baseColliders = colliders.map(c => ({ c, top: c.top, bottom: c.bottom ?? 0 }));
  const staticInteractions = interactables.filter(i => i.kind !== 'desk');
  const office: Office = { floor: 0, elevator,
    setElevation(y: number) {
      group.position.y = y;
      for (const { c, top, bottom } of baseColliders) { c.top = top + y; c.bottom = bottom + y; }
      // Unfurnished workstations have neither geometry nor invisible collisions.
      views.forEach((desk, i) => { if (!desk.group.visible) deskColliders[i].top = deskColliders[i].bottom = y; });
    },
    setFloor(floor: number, capacity: number) {
      const changed = office.floor !== floor;
      office.floor = floor;
      if (changed) views.forEach(d => { d.vacancy.visible = true; d.setScreen(); });
      desks.clear(); interactables.splice(0, interactables.length, ...staticInteractions);
      desksOnFloor(floor).forEach((def, i) => {
        const desk = views[i]; desk.def = def; desk.group.visible = deskIndex(def.id) < capacity;
        deskInteractions[i].deskId = def.id;
        if (desk.group.visible) { desks.set(def.id, desk); interactables.push(deskInteractions[i]); }
      });
      office.setElevation(floor * FLOOR_RISE);
      elevator.setFloor(floor);
    }, group, colliders, interactables, executiveInteractables, inboxTray, desks, boardMeshes, tvScreen, entranceDoor, fixtures: () => (signRect ? [...fixtures, signRect] : fixtures), setProjectName, update };
  return office;
}

/**
 * The upstairs office: a loft on posts in the south-east corner, with glass on the two sides that
 * face the desks, reached by stairs along the south wall.
 */
function buildLoft(group: THREE.Group, colliders: Collider[]): { interactables: Interactable[]; tray: InboxTray } {
  const { minX, maxX, minZ, maxZ, y: floorY, height } = LOFT;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const roofY = floorY + height;
  const SLAB = 0.25;
  const T = 0.12; // glass wall thickness
  const wallMat = toon(PALETTE.wall);
  const trimMat = toon(PALETTE.wallTrim);
  const frameMat = toon('#ffffff');
  const woodMat = toon(PALETTE.wood);

  // Floor slab, planked like downstairs, with a trim fascia you see from below.
  group.add(mesh(box(w, SLAB, d), trimMat, cx, floorY - SLAB / 2, cz));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: floorTexture(w, d), roughness: .65 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, floorY + 0.005, cz);
  floor.receiveShadow = true;
  group.add(floor);
  colliders.push({ minX, maxX, minZ, maxZ, bottom: floorY - SLAB, top: floorY });

  // Posts holding up the open corner.
  for (const x of [minX + 0.15, cx]) {
    group.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, floorY - SLAB, 12), trimMat, x, (floorY - SLAB) / 2, minZ + 0.15));
    colliders.push({ minX: x - 0.14, maxX: x + 0.14, minZ: minZ + 0.01, maxZ: minZ + 0.29, top: floorY - SLAB });
  }

  // The outside walls carry on up past the roofline behind the loft; the sun shines through them and the roof.
  const upper = roofY + 0.2 - WALL_HEIGHT;
  const south = mesh(box(w + 0.3, upper, 0.3), wallMat, cx + 0.15, WALL_HEIGHT + upper / 2, maxZ + 0.15, false);
  const east = mesh(box(0.3, upper, d + 0.3), wallMat, maxX + 0.15, WALL_HEIGHT + upper / 2, cz + 0.15, false);
  const roof = mesh(box(w + 0.3, 0.2, d + 0.3), wallMat, cx + 0.15, roofY + 0.1, cz + 0.15, false);
  group.add(south, east, roof);
  group.add(mesh(box(w + 0.34, 0.24, 0.04), trimMat, cx + 0.15, roofY + 0.1, minZ - 0.02, false));
  group.add(mesh(box(0.04, 0.24, d + 0.34), trimMat, minX - 0.02, roofY + 0.1, cz + 0.15, false));
  colliders.push({ minX, maxX, minZ, maxZ, bottom: roofY, top: roofY + 0.2 });
  group.add(mesh(box(w, 0.25, 0.04), trimMat, cx, floorY + 0.125, maxZ - 0.02, false));
  group.add(mesh(box(0.04, 0.25, d), trimMat, maxX - 0.02, floorY + 0.125, cz, false));
  group.add(outsideWindow(minX + 2, floorY + 1.5, maxZ - 0.02));
  group.add(outsideWindow(maxX - 0.02, floorY + 1.5, cz, true));

  // Floor-to-ceiling glass on the north and west sides, so you can look down on everyone working.
  const glass = new THREE.MeshBasicMaterial({ color: '#d6f1ff', transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide });
  const shine = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  const doorZ = STAIRS.minZ;
  const pane = (len: number, px: number, pz: number, rotY: number) => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.PlaneGeometry(len, height), glass, 0, 0, 0, false));
    // A couple of cartoon glints, so it reads as glass.
    for (const [gx, gw] of [
      [-len * 0.2, 0.18],
      [-len * 0.2 + 0.32, 0.08],
    ]) {
      const glint = mesh(new THREE.PlaneGeometry(gw, height * 0.55), shine, gx, 0.2, 0.01, false);
      glint.rotation.z = -0.5;
      g.add(glint);
    }
    g.position.set(px, floorY + height / 2, pz);
    g.rotation.y = rotY;
    group.add(g);
  };
  const bar = (bw: number, bh: number, bd: number, x: number, y: number, z: number) => group.add(mesh(box(bw, bh, bd), frameMat, x, y, z, false));
  const northZ = minZ + T / 2;
  const westX = minX + T / 2;
  for (let i = 0; i < 6; i++) pane(w / 6, minX + (i + 0.5) * (w / 6), northZ, 0);
  for (let i = 0; i <= 6; i++) bar(0.1, height, T + 0.04, minX + i * (w / 6), floorY + height / 2, northZ);
  bar(w, 0.12, T + 0.06, cx, floorY + 0.06, northZ);
  bar(w, 0.12, T + 0.06, cx, roofY - 0.06, northZ);
  const westLen = doorZ - minZ;
  for (let i = 0; i < 2; i++) pane(westLen / 2, westX, minZ + (i + 0.5) * (westLen / 2), Math.PI / 2);
  for (let i = 0; i <= 2; i++) bar(T + 0.04, height, 0.1, westX, floorY + height / 2, minZ + i * (westLen / 2));
  bar(T + 0.06, 0.12, westLen, westX, floorY + 0.06, minZ + westLen / 2);
  bar(T + 0.06, 0.12, westLen, westX, roofY - 0.06, minZ + westLen / 2);
  colliders.push({ minX, maxX, minZ, maxZ: minZ + T, bottom: floorY, top: 99 });
  colliders.push({ minX, maxX: minX + T, minZ, maxZ: doorZ, bottom: floorY, top: 99 });
  // Over the door at the top of the stairs.
  const doorTop = floorY + 2.3;
  group.add(mesh(box(T + 0.04, roofY - doorTop, maxZ - doorZ), wallMat, westX, (roofY + doorTop) / 2, (doorZ + maxZ) / 2, false));
  colliders.push({ minX, maxX: minX + T, minZ: doorZ, maxZ, bottom: doorTop, top: roofY });

  // Stairs: a solid run of steps up the south wall, wood treads, a handrail on the open side.
  const { fromX, toX, steps } = STAIRS;
  const sw = STAIRS.maxZ - STAIRS.minZ;
  const run = (toX - fromX) / steps;
  const rise = floorY / steps;
  const profile = new THREE.Shape();
  profile.moveTo(0, 0);
  for (let i = 0; i < steps; i++) {
    profile.lineTo(i * run, (i + 1) * rise - 0.04);
    profile.lineTo((i + 1) * run, (i + 1) * rise - 0.04);
  }
  profile.lineTo(toX - fromX, 0);
  profile.closePath();
  const stairs = mesh(new THREE.ExtrudeGeometry(profile, { depth: sw, bevelEnabled: false }), wallMat, fromX, 0, STAIRS.minZ);
  group.add(stairs);
  for (let i = 1; i <= steps; i++) {
    // A 2 cm lip over the open side, so the tread's face isn't coplanar with the stair body (z-fighting).
    group.add(mesh(box(run + 0.04, 0.06, sw + 0.02), woodMat, fromX + (i - 0.5) * run - 0.02, i * rise - 0.03, STAIRS.minZ + sw / 2 - 0.01, false));
    colliders.push({ minX: fromX + (i - 1) * run, maxX: fromX + i * run, minZ: STAIRS.minZ, maxZ: STAIRS.maxZ, top: i * rise });
  }
  const railZ = STAIRS.minZ + 0.06;
  const railH = 0.9;
  const inkMat = toon(PALETTE.deskLeg);
  for (let i = 1; i <= steps; i += 2) {
    group.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, railH, 6), inkMat, fromX + (i - 0.5) * run, i * rise + railH / 2, railZ, false));
  }
  const x0 = fromX + 0.5 * run;
  const x1 = fromX + (steps - 0.5) * run;
  const handrail = mesh(box(Math.hypot(x1 - x0, (x1 - x0) * (rise / run)) + 0.1, 0.07, 0.07), woodMat, (x0 + x1) / 2, (rise + floorY) / 2 + railH, railZ, false);
  handrail.rotation.z = Math.atan2(rise, run);
  group.add(handrail);
  // You can't step off the side of the stairs, or climb on from it.
  colliders.push({ minX: fromX, maxX: toX, minZ: STAIRS.minZ - 0.1, maxZ: STAIRS.minZ, top: 99 });

  // Inside: the big desk facing the glass, a comfy couch, a telescope aimed at the desks.
  // The founder's desk sits back toward the south wall; the executives' row faces the glass (ORG-01).
  const deskX = FOUNDER_DESK.x;
  const deskZ = FOUNDER_DESK.z;
  const desk = new THREE.Group();
  desk.add(mesh(roundedBox(2.6, 0.1, 1.2, 0.1), woodMat, 0, 0.78, 0));
  desk.add(mesh(box(2.4, 0.66, 0.08), toon('#8a5a3b'), 0, 0.4, -0.5));
  for (const sx of [-1, 1]) desk.add(mesh(box(0.1, 0.72, 1.0), toon('#8a5a3b'), sx * 1.15, 0.37, 0));
  desk.add(mesh(roundedBox(0.9, 0.55, 0.06, 0.03), toon(PALETTE.ink), 0, 1.18, -0.2));
  desk.add(mesh(box(0.08, 0.2, 0.08), toon(PALETTE.ink), 0, 0.93, -0.2));
  desk.add(mesh(new THREE.PlaneGeometry(0.8, 0.45), new THREE.MeshBasicMaterial({ color: '#4cc9f0' }), 0, 1.18, -0.165, false));
  desk.add(mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.12, 10), toon('#343a3c'), 0.9, 0.89, 0.15));
  const plate = textPlane('FOUNDER', { bg: '#343a3c', size: 48 });
  plate.scale.multiplyScalar(0.55);
  plate.position.set(0, 0.5, -0.55);
  plate.rotation.y = Math.PI;
  desk.add(plate);
  const bossChair = chair('#2b2d42');
  bossChair.scale.setScalar(1.2);
  bossChair.position.set(0, 0, 0.85);
  desk.add(bossChair);
  desk.position.set(deskX, floorY, deskZ);
  group.add(desk);
  // ORG-03: the inbox tray on the desk's east end; you use it from the CEO's side, beside the chair.
  const tray = buildInboxTray(desk, { x: deskX + 1.1, z: deskZ + 0.95, y: floorY });
  colliders.push({ minX: deskX - 1.3, maxX: deskX + 1.3, minZ: deskZ - 0.6, maxZ: deskZ + 0.6, bottom: floorY, top: floorY + 0.8 });

  const couch = new THREE.Group();
  const couchMat = SURFACE.fabric;
  couch.add(mesh(roundedBox(1, 0.45, 2.4, 0.2), couchMat, 0, 0.3, 0));
  couch.add(mesh(roundedBox(0.35, 0.9, 2.4, 0.15), couchMat, 0.45, 0.55, 0));
  for (const sz of [-1, 1]) couch.add(mesh(roundedBox(1, 0.7, 0.3, 0.15), couchMat, 0, 0.45, sz * 1.1));
  couch.add(mesh(roundedBox(0.2, 0.45, 0.5, 0.1), toon('#343a3c'), 0.2, 0.75, 0.4));
  couch.position.set(LOFT_COUCH.x, floorY, LOFT_COUCH.z);
  group.add(couch);
  colliders.push({ minX: maxX - 1.15, maxX, minZ: LOFT_COUCH.z - 1.2, maxZ: LOFT_COUCH.z + 1.2, bottom: floorY, top: floorY + 0.55 });

  const rug = mesh(roundedBox(6.6, 0.02, 1.0, 0.3), toon('#66716b'), 13.7, floorY + 0.015, 10.35, false);
  group.add(rug);

  const scope = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6), inkMat, Math.sin(a) * 0.2, 0.52, Math.cos(a) * 0.2);
    leg.rotation.set(Math.cos(a) * -0.35, 0, Math.sin(a) * 0.35);
    scope.add(leg);
  }
  const tube = new THREE.Group();
  const tubeGeo = new THREE.CylinderGeometry(0.1, 0.06, 0.9, 14);
  tubeGeo.rotateX(Math.PI / 2);
  tube.add(mesh(tubeGeo, toon('#343a3c'), 0, 0, 0.1));
  tube.add(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 14).rotateX(Math.PI / 2), toon(PALETTE.ink), 0, 0, 0.55));
  tube.position.y = 1.08;
  scope.add(tube);
  scope.position.set(minX + 0.9, floorY, minZ + 0.9);
  group.add(scope);
  tube.lookAt(-6, 0.8, 0);
  colliders.push({ minX: minX + 0.65, maxX: minX + 1.15, minZ: minZ + 0.65, maxZ: minZ + 1.15, bottom: floorY, top: floorY + 1.3 });

  for (const [px, pz, s] of [
    [LOFT_PLANT.x, LOFT_PLANT.z, LOFT_PLANT.scale],
  ]) {
    const p = plant(s);
    p.position.set(px, floorY, pz);
    group.add(p);
    const r = 0.3 * s;
    colliders.push({ minX: px - r, maxX: px + r, minZ: pz - r, maxZ: pz + r, bottom: floorY, top: floorY + 0.5 * s });
  }

  const lamp = pendant();
  lamp.position.set(13.7, roofY - 0.4, 10.3);
  group.add(lamp);

  // Signs: one on the back wall inside, one over the glass for everyone downstairs.
  const inside = textPlane('EXECUTIVE OFFICE', { bg: '#fffaf3', size: 64 });
  inside.scale.multiplyScalar(0.8);
  inside.position.set(maxX - 3, floorY + 1.9, maxZ - 0.04);
  inside.rotation.y = Math.PI;
  group.add(inside);
  const outside = textPlane('EXECUTIVE OFFICE', { bg: '#2b2d42', color: '#fffaf3', size: 64, border: '#fffaf3' });
  outside.scale.multiplyScalar(1.4);
  outside.position.set(cx, roofY + 0.2, minZ - 0.06); // in front of the fascia and the glass rail
  outside.rotation.y = Math.PI;
  group.add(outside);

  return { interactables: [...buildExecutiveDesks(group, colliders), tray.interactable], tray };
}
