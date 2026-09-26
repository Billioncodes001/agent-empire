import { loadChief } from './realistic-person';
import * as THREE from 'three';
import { SITES, type EmpireState } from '../../shared/empire';
import { lookFromSeed } from '../../shared/avatar';
import { Person } from './character';
import { textSprite } from './toon';
import type { Collider } from './office';

const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(color: string, metalness = 0) {
  const key = color + metalness;
  if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: metalness ? 0.32 : 0.78, metalness }));
  return materials.get(key)!;
}
function box(parent: THREE.Object3D, w: number, h: number, d: number, color: string, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));
  m.position.set(x,y,z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function label(parent: THREE.Object3D, text: string, x: number, y: number, z: number, scale = 3.5) {
  const s = textSprite(text, { size: 38, color: '#f3f5ed', bg: '#203c3d' });
  s.position.set(x,y,z); s.scale.multiplyScalar(scale / s.scale.x); parent.add(s); return s;
}
function tree(parent: THREE.Object3D, x: number, z: number, seed: number) {
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.16,.25,2.9,7),material('#72543c'));
  trunk.position.set(x,1.45,z); trunk.castShadow = true; parent.add(trunk);
  for (let i=0;i<3;i++) {
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5-i*.2,2),material(['#55795d','#74906b','#8da276'][i]));
    crown.position.set(x+Math.sin(seed+i)*.5,3+i*.6,z+Math.cos(seed+i)*.4); crown.castShadow = true; crown.scale.y=.8; parent.add(crown);
  }
}
export function buildCity() {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const siteColliders = new Map<string, Collider>();
  const buildings = new Map<string, THREE.Group>();
  const plots = new Map<string, THREE.Group>();
  box(group,240,.15,240,'#8d9c80',45,-.22,80);
  box(group,112,.2,98,'#91a083',0,-.15,77);
  for(let i=0;i<36;i++) tree(group,58+(i%6)*8,24+Math.floor(i/6)*21,i*3);
  box(group,15,.12,96,'#444f52',0,-.01,77);
  box(group,105,.12,10,'#444f52',0,-.01,62);
  box(group,105,.12,10,'#444f52',0,-.01,90);
  for (const x of [-9,9]) box(group,2,.15,96,'#d8d5c9',x,.02,77);
  for (const z of [55.5,68.5,83.5,96.5]) box(group,104,.15,2,'#d8d5c9',0,.02,z);
  for (let z=33;z<123;z+=5) if (Math.abs(z-62)>6 && Math.abs(z-90)>6) box(group,.14,.025,2,'#e3dcb9',0,.07,z);
  for (const crossing of [57,67,85,95]) for(let x=-6;x<=6;x+=2) box(group,1.2,.025,2,'#e9e7da',x,.08,crossing);
  for (let z=37;z<124;z+=12) for (const x of [-11,11]) {
    tree(group,x+(x<0?-2:2),z,z);
    box(group,.12,4,.12,'#354747',x,2,z+4);
    box(group,1.1,.16,.55,'#e7d8a2',x,4,z+4);
    box(group,1.6,.12,.55,'#aa7954',x+(x<0?-3:3),.5,z+3);
  }
  // Waterfront promenade, gently moving water, distant skyline.
  const water = box(group,35,.08,112,'#739eab',-73,-.11,78);
  (water.material as THREE.MeshStandardMaterial).roughness=.22;
  box(group,3,.25,98,'#d8c5a2',-54,.02,77);
  for(let z=32;z<126;z+=4) box(group,.1,.8,.1,'#e3dfcd',-55,.5,z);
  for(let i=0;i<16;i++) {
    const ht=5+(Math.sin(i*9.2)+1)*6;
    box(group,5,ht,6,['#bdc9c7','#aebdbd','#cbd0c6'][i%3],-49+i*6.5,ht/2,141+(i%3)*5);
  }
  for (const site of SITES) {
    const plot = new THREE.Group(); group.add(plot); plots.set(site.id,plot);
    box(plot,23,.1,19,'#bbc5ac',site.x,.03,site.z);
    for(const dx of [-11,11]) box(plot,.12,.2,19,'#e2d9ac',site.x+dx,.2,site.z);
    const building = new THREE.Group(); building.position.set(site.x,0,site.z); group.add(building); buildings.set(site.id,building);
    const home = site.id==='home';
    const height = site.id==='hq'?9:site.id==='hospital'?7:4;
    if (!home) {
      box(building,18,height,12,site.color,0,height/2,0);
      box(building,18.8,.35,12.8,'#415453',0,height+.15,0);
      for(let floor=0;floor<Math.floor(height/2.7);floor++) for(let x=-7;x<=7;x+=3.5) {
        box(building,2.3,1.5,.1,'#47717b',x,1.7+floor*2.7,6.06);
        box(building,.06,1.5,.15,'#cbd6cd',x,1.7+floor*2.7,6.12);
      }
      // Glazing on every elevation keeps the building legible from the district camera.
      for(let floor=0;floor<Math.floor(height/2.7);floor++) {
        for(let x=-7;x<=7;x+=3.5) box(building,2.3,1.5,.1,'#47717b',x,1.7+floor*2.7,-6.06);
        for(const side of [-1,1]) for(let z=-4;z<=4;z+=4) box(building,.1,1.5,2.4,'#47717b',side*9.06,1.7+floor*2.7,z);
      }
      for(const x of [-5,5]) {box(building,2,.7,2,'#899896',x,height+.65,-2);box(building,2.1,.1,2.1,'#52605d',x,height+1,-2);}
      box(building,2.4,2.6,.2,'#274d57',0,1.3,6.2);
      box(building,5,.2,2.8,site.id==='cafe'?'#b77758':'#526c68',0,3,6.8);
      if(site.id==='hospital') {box(building,2.2,.55,.2,'#c05c53',0,6.5,6.2);box(building,.55,2.2,.2,'#c05c53',0,6.5,6.25);}
      if(site.id==='utilities') for(let i=0;i<4;i++) {const panel=box(building,3,.14,5,'#294f65',-6+i*4,4.7,0);panel.rotation.x=.25;}
      const collider = { minX:site.x-9.2,maxX:site.x+9.2,minZ:site.z-6.2,maxZ:site.z+6.2,top:height };
      siteColliders.set(site.id,collider); colliders.push(collider);
    } else {
      // Open-front residence: accessible living room, research desk and kitchen.
      box(building,18,.16,13,'#c6a37a',0,.05,0);
      box(building,18,3.4,.25,site.color,0,1.7,-6);
      for(const x of [-9,9]) {box(building,.25,3.4,12,site.color,x,1.7,0);colliders.push({minX:site.x+x-.2,maxX:site.x+x+.2,minZ:site.z-6,maxZ:site.z+6,top:3.4});}
      colliders.push({minX:site.x-9,maxX:site.x+9,minZ:site.z-6.2,maxZ:site.z-5.8,top:3.4});
      box(building,4,.55,1.8,'#718d85',-5,.45,-2);
      box(building,4,.8,.4,'#718d85',-5,.95,-2.7);
      box(building,3,.4,1.2,'#946f4f',-5,.3,.5);
      box(building,3,1,1.2,'#9a7858',5,.5,-4);
      box(building,1.5,.95,.1,'#243d48',5,1.6,-4);
      box(building,1.25,.65,.12,'#8cc9c5',5,1.6,-3.93);
      box(building,3.5,.65,2,'#dedcca',4,.45,2);
      box(building,3.5,.15,1.5,'#6c8b93',4,.85,2);
      label(building,'Research desk',5,2.5,-4,2.6);
    }
    label(group,site.name,site.x,home?4.2:height+1.6,site.z+6,5.8);
    for(const x of [-10,10]) tree(group,site.x+x,site.z-7,site.x+x);
  }
  const chief = new Person('Chief of staff','#345f65',lookFromSeed('empire-chief'));
  chief.root.position.set(8,0,9); group.add(chief.root);
  const realisticChief = loadChief(group, chief.root);
  label(group, 'Chief of staff', 5, 2.2, 9, 2.6);
  const citizens = Array.from({length:10},(_,i)=> {
    const p = new Person(['Planner','Nurse','Teacher','Engineer','Chef'][i%5],['#b19a7a','#729696','#627e9d','#c09c6b'][i%4],lookFromSeed(`citizen-${i}`));
    p.showLabel(false); group.add(p.root); return p;
  });
  const car = new THREE.Group();
  box(car,1.85,.6,3.8,'#244f58',0,.65,0);
  box(car,1.65,.65,2,'#426b76',0,1.2,-.15);
  box(car,1.5,.5,.06,'#a5c3c6',0,1.25,.87);
  for(const x of [-.95,.95]) for(const z of [-1.2,1.2]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.38,.38,.22,16),material('#263132'));
    wheel.rotation.z=Math.PI/2;wheel.position.set(x,.4,z);car.add(wheel);
  }
  for(const x of [-.6,.6]) box(car,.38,.18,.1,'#f4e3b1',x,.75,1.95);
  car.position.set(5,0,45); group.add(car);
  return {group,colliders,car,
    sync(state: EmpireState) {
      for(const sector of state.sectors) { buildings.get(sector.id)!.visible=sector.built;plots.get(sector.id)!.visible=!sector.built; const collider=siteColliders.get(sector.id); if(collider)collider.top=sector.built?(sector.id==='hq'?9:sector.id==='hospital'?7:4):0; }
    },
    update(t: number, delegated: boolean) {
      chief.update(.016,t,false,false);
      realisticChief.update(.016);
      chief.root.position.set(delegated?5:8,0,9);
      citizens.forEach((p,i)=> { const z=37+((t*.8+i*8)%82);p.root.position.set(i%2?10:-10,0,z);p.root.rotation.y=0;p.update(.016,t,true,false); });
    }
  };
}
