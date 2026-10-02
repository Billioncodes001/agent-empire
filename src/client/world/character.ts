import { Human, type HumanActivity, type VehiclePose } from './human';
import * as THREE from 'three';
import { SKIN_TONES, type Look } from '../../shared/avatar';
import { ceoAvatar, sameOutfit, type Outfit } from '../../shared/outfit';
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

/** The suit a profile wears: the CEO catalog entry its look's style selects. */
export const profileOutfit = (look: Look): Outfit => ({ avatar: ceoAvatar(look.style) });

/** Adult, skinned avatar in corporate attire: a profile's suit, or an explicit outfit (chief of staff, staff). */
export class Person {
  readonly root = new THREE.Group();
  private human: Human;
  private label: THREE.Sprite | null = null;
  private look: Look;
  private outfit: Outfit;
  /** Set when the outfit was given explicitly; a look change then never re-dresses the person. */
  private fixedOutfit: boolean;
  pose: Pose = 'stand';
  constructor(private name: string, color: string, look: Look, outfit?: Outfit) {
    this.look={...look};this.fixedOutfit=!!outfit;this.outfit={...(outfit??profileOutfit(look))};
    this.human=new Human(this.outfit);this.root.add(this.human.root);this.setLabel(name,false);
  }
  /** The avatar and colours being worn. */
  get wearing():Outfit{return {...this.outfit};}
  get ready(){return this.human.ready;}
  /** Loaded with every texture decoded; see Human.materialsReady. */
  get materialsReady(){return this.human.materialsReady;}
  /** The clip or procedural state the body is showing (airborne, landing, walk_neutral…), for headless checks. */
  get motion(){return this.human.root.userData.motion as string|undefined;}
  setColor(color:string) { this.root.userData.accent=color; }
  get skinColor(){return SKIN_TONES[this.look.skin];}
  setLook(look:Look){
    this.look={...look};
    if(!this.fixedOutfit)this.dress(profileOutfit(look));
  }
  /** Re-dresses the person (an explicit outfit sticks across later look changes). */
  setOutfit(outfit:Outfit){this.fixedOutfit=true;this.dress(outfit);}
  private dress(outfit:Outfit){
    if(sameOutfit(outfit,this.outfit))return;
    this.outfit={...outfit};
    this.root.remove(this.human.root);this.human.dispose();this.human=new Human(this.outfit);this.root.add(this.human.root);
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
  setVehiclePose(pose:VehiclePose|null){this.human.setVehiclePose(pose);}
  /**
   * `airborne` selects the held flight pose (never the idle clip) and, on touchdown, a landing dip.
   * `landingGrace` (s) keeps an interpolated peer airborne through brief false "grounded" frames at the apex.
   */
  update(dt:number,t:number,moving:boolean,airborne:boolean,speed=1.65,landingGrace=0){
    this.human.setAirborne(airborne,landingGrace);
    this.human.update(dt,moving&&!airborne?speed:0,this.pose==='sit'||this.pose==='type'||this.pose==='drive',this.pose==='type',this.pose==='drive');
  }
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
  unknown: ['❔ UNKNOWN', '#dee2e6', '#2b2d42'],
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
  /** Set from typingPose(): only a fresh, running agent turn types. */
  typing = false;
  /** False while the server's evidence is stale: the cached status is then only last-known. */
  private live = true;
  private reasonTag: THREE.Sprite | null = null;
  private reasonKey = '';
  /** Body state, set by the routine controller (worker-life.ts) from the worker's real server state. */
  readonly motion: { speed: number; seated: boolean; activity: HumanActivity; detail: boolean; transition: string | null; progress: number } =
    { speed: 0, seated: true, activity: 'none', detail: true, transition: null, progress: 0 };
  private outfit: Outfit;
  constructor(name: string, color: string, outfit: Outfit) {
    this.outfit = { ...outfit };
    this.human = new Human(this.outfit);
    this.root.add(this.human.root);
    this.root.userData.accent=color;
    this.setName(name);
  }

  /** Re-dresses the worker when its saved outfit changes. */
  setOutfit(outfit: Outfit) {
    if (sameOutfit(outfit, this.outfit)) return;
    this.outfit = { ...outfit };
    this.root.remove(this.human.root);
    this.human.dispose();
    this.human = new Human(this.outfit);
    this.root.add(this.human.root);
  }

  get wearing(): Outfit {
    return { ...this.outfit };
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

  setLive(live: boolean) {
    if (this.live === live) return;
    this.live = live;
    this.drawBubble();
  }

  private drawBubble() {
    const { bouncing: bounce, task } = this;
    const status = this.live ? this.status : 'unknown';
    const hot = status === 'needs_input' || (status === 'done' && bounce);
    const bg = hot ? (status === 'done' ? '#caffbf' : '#ffd6e0') : status === 'working' ? '#ffec99' : '#fffaf3';
    const bubble =
      status === 'needs_input' ? '❗ needs you' : status === 'done' && bounce ? '✅ done!' : status === 'working' ? '⌨️ working' : status === 'offline' || status === 'exited' ? '💤' : status === 'unknown' ? '❔ status unknown' : '';
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
      const asleep = status === 'offline' || status === 'exited' || status === 'unknown';
      this.bubble = cardSprite({ chip: { text, bg: chipBg, color }, title: task.name, body: task.summary, bg: asleep ? '#e9ecef' : bg });
    } else if (bubble) this.bubble = textSprite(bubble, { bg, size: 38 });
    if (this.bubble) this.root.add(this.bubble);
  }

  /** Why the worker is where it is (e.g. "Turn finished — on a coffee break"); '' hides it. */
  setReason(text: string) {
    if (text === this.reasonKey) return;
    this.reasonKey = text;
    if (this.reasonTag) {
      this.root.remove(this.reasonTag);
      disposeSprite(this.reasonTag);
      this.reasonTag = null;
    }
    if (!text) return;
    this.reasonTag = textSprite(text, { bg: '#fffaf3', color: '#2b2d42', size: 26 });
    this.reasonTag.scale.multiplyScalar(0.8);
    this.root.add(this.reasonTag);
  }

  update(dt: number, t: number) {
    const m = this.motion;
    this.human.setTransition(m.transition, m.progress);
    this.human.setActivity(m.activity, m.detail);
    // Typing only ever happens seated at the desk; the routine controller clears `seated` everywhere else it matters.
    this.human.update(dt, m.speed, m.seated, this.typing && m.seated);
    // Labels ride higher over a standing body than a seated one.
    const lift = m.seated && !m.transition ? 0 : 0.42;
    // The reason line sits just above the name; the bubble or task card moves up to make room.
    const reason = this.reasonTag ? 0.27 : 0;
    if (this.bubble) this.bubble.position.y = (this.bubbleIsCard ? 1.74 : 1.95) + lift + reason;
    if (this.nameTag) this.nameTag.position.y = 1.55 + lift;
    if (this.reasonTag) this.reasonTag.position.y = 1.55 + lift + reason;
  }

  dispose() {
    this.human.dispose();
    if (this.bubble) disposeSprite(this.bubble);
    if (this.nameTag) disposeSprite(this.nameTag);
    if (this.reasonTag) disposeSprite(this.reasonTag);
  }
}
