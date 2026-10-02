import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drivetrain, vehicleOverlaps } from '../src/client/vehicle';
import { AUDIO_FILES } from '../src/client/world-audio';
import { readFile } from 'node:fs/promises';

test('automatic transmission brakes to rest before reverse, coasts, and stops when disabled', () => {
 const car = new Drivetrain();
 for (let i=0;i<300;i++) car.update(1/60,1,0,false);
 assert.ok(car.speed > 8 && car.speed < 12); assert.ok(car.gear >= 2);
 const before=car.speed;car.update(.05,0,0,false);assert.ok(car.speed<before && car.speed>before-.15);
 let stopped=false;
 for(let i=0;i<240;i++) { car.update(1/60,-1,0,false);if(car.speed===0)stopped=true;if(car.speed<0)assert.ok(stopped); }
 assert.ok(car.speed<-.5 && car.speed>=-4);assert.equal(car.gear,-1);
 for(let i=0;i<240;i++)car.update(1/60,1,0,false,false);
 assert.equal(car.speed,0); assert.equal(car.throttle,0);
});
test('car corners collide at any yaw; a nearby parallel lane stays clear',()=>{
 const wall={minX:-10,maxX:10,minZ:50,maxZ:58};
 assert.equal(vehicleOverlaps(0,60,0,wall),true);
 assert.equal(vehicleOverlaps(0,60.5,0,wall),false);
 assert.equal(vehicleOverlaps(0,60,Math.PI/4,wall),true);
 assert.equal(vehicleOverlaps(12,55,0,wall),false);
 assert.equal(vehicleOverlaps(12,55,Math.PI/2,wall),true);
});
test('shipped recordings decode as non-silent mono PCM with no clipped samples or loop seam discontinuity',async()=>{
 for(const name of AUDIO_FILES){
  const b=await readFile(new URL(`../src/client/public/audio/${name}.wav`,import.meta.url));
  assert.equal(b.toString('ascii',0,4),'RIFF');assert.equal(b.readUInt16LE(20),1);assert.equal(b.readUInt16LE(22),1);assert.equal(b.readUInt32LE(24),24000);
  let offset=12,data:Buffer|undefined;
  while(offset+8<=b.length){const n=b.readUInt32LE(offset+4);if(b.toString('ascii',offset,offset+4)==='data'){data=b.subarray(offset+8,offset+8+n);break;}offset+=8+n+(n%2);}
  assert.ok(data && data.length>2400,name);let peak=0,energy=0;
  for(let i=0;i<data.length;i+=2){const v=data.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(v));energy+=v*v;}
  assert.ok(peak<.95 && peak>.01,`${name}: peak ${peak}`);assert.ok(Math.sqrt(energy/(data.length/2))>.01,name);
  if(['engine-idle','engine-load','road-roll'].includes(name)) assert.ok(Math.abs(data.readInt16LE(0)-data.readInt16LE(data.length-2))/32768<.06,`${name}: seamless loop`);
 }
});
