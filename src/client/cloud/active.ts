// FREE-07: the cloud connection, for panels that write intents (inbox, research, memory) without threading it through
// main.ts. Set once by installCloudChrome; null in server mode.
import type { CloudNet } from './net';

let active: CloudNet | null = null;
export const setActiveCloudNet = (net: CloudNet | null) => { active = net; };
export const activeCloudNet = () => active;
