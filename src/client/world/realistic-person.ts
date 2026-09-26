import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Licensed Rocketbox character, converted by Tidewater. Procedural fallback stays until loaded. */
export function loadChief(parent: THREE.Group, fallback: THREE.Object3D) {
  let mixer: THREE.AnimationMixer | undefined;
  const anchor = new THREE.Group();
  parent.add(anchor);
  new GLTFLoader().load('/models/chief-of-staff.glb', gltf => {
    const model = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    model.scale.setScalar(1.72 / Math.max(size.y,.01));
    const scaled = new THREE.Box3().setFromObject(model);
    model.position.y -= scaled.min.y;
    model.traverse(obj => { if (obj instanceof THREE.Mesh) { obj.castShadow=true;obj.receiveShadow=true; } });
    anchor.add(model);
    if(gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(gltf.animations.find(a=>/idle/i.test(a.name))??gltf.animations[0]).play();
    }
    fallback.visible=false;
  },undefined,()=> { /* The procedural chief remains usable when asset loading fails. */ });
  return {update(dt:number){anchor.position.copy(fallback.position);anchor.rotation.copy(fallback.rotation);mixer?.update(dt);}};
}
