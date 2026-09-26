import { Human } from './human';
import * as THREE from 'three';
import { SKIN_TONES, type Look } from '../../shared/avatar';
import type { WorkerTask } from '../../shared/protocol';
import { cardSprite, disposeSprite, textSprite } from './toon';

export type Pose = 'stand' | 'walk' | 'sit' | 'type' | 'drive';

/** Voice loudness (RMS) above which someone counts as speaking. */
const SPEAKING = 0.04;

/** How long reaching out to use something takes, in seconds. */
export const REACH_TIME = 0.42;

/** 0 → 1 → 0 over a reach (p = 0..1): a quick jab out, a beat at full stretch, an easy return. */
export function reachCurve(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < 0.28) return 1 - (1 - p / 0.28) ** 3;
  if (p < 0.5) return 1;
  const u = (p - 0.5) / 0.5;
  return 1 - u * u * (3 - 2 * u);
}

/** Adult, skinned avatar; profile style chooses one of the two licensed human rigs. */
export class Person {
  readonly root = new THREE.Group();
  private human: Human;
  private label: THREE.Sprite | null = null;
  private look: Look;
  pose: Pose = 'stand';
  constructor(private name: string, color: string, look: Look) {
    this.look={...look};this.human=new Human(look.style);this.root.add(this.human.root);this.setLabel(name,false);
  }
  get ready(){return this.human.ready;}
  setColor(color:string) { this.root.userData.accent=color; }
  get skinColor(){return SKIN_TONES[this.look.skin];}
  setLook(look:Look){
    if(look.style%2!==this.look.style%2){this.root.remove(this.human.root);this.human.dispose();this.human=new Human(look.style);this.root.add(this.human.root);}
    this.look={...look};
  }
  setLabel(name:string, muted:boolean|null){
    const visible=this.label?.visible??true;
    if(this.label){this.root.remove(this.label);disposeSprite(this.label);}
    this.label=textSprite(name,{bg:'#151e24',color:'#ece8db',size:28});this.label.position.y=2.05;this.label.scale.multiplyScalar(.65);this.label.visible=visible;this.root.add(this.label);
  }
  setVoiceLevel(level:number){this.root.userData.voiceLevel=level;}
  showLabel(v:boolean){if(this.label)this.label.visible=v;}
  reach(){this.human.reach();}
  setTransition(name:string|null,progress=0){this.human.setTransition(name,progress);}
  update(dt:number,t:number,moving:boolean,airborne:boolean,speed=1.65){this.human.update(dt,moving&&!airborne?speed:0,this.pose==='sit'||this.pose==='type'||this.pose==='drive',this.pose==='type',this.pose==='drive');}
  dispose(){this.human.dispose();if(this.label)disposeSprite(this.label);}
}

const STATUS_BULB: Record<string, string> = {
  starting: '#adb5bd',
  idle: '#8ecae6',
  working: '#ffd166',
  needs_input: '#ef476f',
  done: '#06d6a0',
  exited: '#6c757d',
  offline: '#6c757d',
};

/** Status pill on a worker's task card: [text, background, text color]. */
const TASK_CHIP: Record<string, [string, string, string]> = {
  starting: ['⏳ STARTING', STATUS_BULB.starting, '#2b2d42'],
  idle: ['💬 READY', STATUS_BULB.idle, '#2b2d42'],
  working: ['⌨️ WORKING', STATUS_BULB.working, '#2b2d42'],
  needs_input: ['❗ NEEDS YOU', STATUS_BULB.needs_input, '#ffffff'],
  done: ['✅ DONE', STATUS_BULB.done, '#2b2d42'],
  exited: ['💤 ASLEEP', STATUS_BULB.exited, '#ffffff'],
  offline: ['💤 ASLEEP', STATUS_BULB.offline, '#ffffff'],
};

/** A seated human worker with an independently animated skeleton and live task status. */
export class Worker {
  readonly root = new THREE.Group();
  private human: Human;
  private bubble: THREE.Sprite | null = null;
  private bubbleKey = '';
  /** The bubble is a task card: it hangs from its tail instead of floating. */
  private bubbleIsCard = false;
  private task: WorkerTask | undefined;
  private nameTag: THREE.Sprite | null = null;
  status = 'starting';
  bouncing = false;
  constructor(name: string, color: string) {
    this.human=new Human(name.length);
    this.root.add(this.human.root);
    this.root.userData.accent=color;
    this.setName(name);
  }

  setName(name: string) {
    if (this.nameTag) {
      this.root.remove(this.nameTag);
      disposeSprite(this.nameTag);
    }
    this.nameTag = textSprite(name, { bg: '#2b2d42', color: '#fffaf3', size: 36, border: '#fffaf3' });
    this.nameTag.position.y = 1.55;
    this.root.add(this.nameTag);
  }

  setStatus(status: string, bounce: boolean) {
    this.status = status;
    this.bouncing = bounce;

    this.drawBubble();
  }

  /** What it's working on, shown on a card over its head in place of the status bubble. */
  setTask(task: WorkerTask | undefined) {
    this.task = task;
    this.drawBubble();
  }

  private drawBubble() {
    const { status, bouncing: bounce, task } = this;
    const hot = status === 'needs_input' || (status === 'done' && bounce);
    const bg = hot ? (status === 'done' ? '#caffbf' : '#ffd6e0') : status === 'working' ? '#ffec99' : '#fffaf3';
    const bubble =
      status === 'needs_input' ? '❗ needs you' : status === 'done' && bounce ? '✅ done!' : status === 'working' ? '⌨️ working' : status === 'offline' || status === 'exited' ? '💤' : '';
    const key = task ? `${status}|${bounce}|${task.name}|${task.summary}` : bubble;
    if (key === this.bubbleKey) return;
    this.bubbleKey = key;
    if (this.bubble) {
      this.root.remove(this.bubble);
      disposeSprite(this.bubble);
      this.bubble = null;
    }
    this.bubbleIsCard = !!task;
    if (task) {
      const [text, chipBg, color] = TASK_CHIP[status] ?? TASK_CHIP.idle;
      const asleep = status === 'offline' || status === 'exited';
      this.bubble = cardSprite({ chip: { text, bg: chipBg, color }, title: task.name, body: task.summary, bg: asleep ? '#e9ecef' : bg });
    } else if (bubble) this.bubble = textSprite(bubble, { bg, size: 38 });
    if (this.bubble) this.root.add(this.bubble);
  }

  update(dt: number, t: number) {
    this.human.update(dt,false,true,this.status==='working');
    if (this.bubble) this.bubble.position.y = this.bubbleIsCard ? 1.74 : 1.95;
    if (this.nameTag) this.nameTag.position.y = 1.55;
  }

  dispose() {
    this.human.dispose();
    if (this.bubble) disposeSprite(this.bubble);
    if (this.nameTag) disposeSprite(this.nameTag);
  }
}
