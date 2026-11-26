export type Box = [number, number, number, number];
export type HistoryEntry = { t: number; box: Box | number[] };
export type Movement = 'toward' | 'away' | 'across' | 'still' | 'unknown';
export type Frame = { width: number; height: number };
export type LiveObject = { id: string; label: string; caption: string; score: number; box: number[] };
export function movement(history: HistoryEntry[], frame?: Frame): Movement;
export function describe(object: { label: string; stationary?: boolean; zones?: string[]; history?: HistoryEntry[] }, frame?: Frame): string;
export class DetectionTracker {
  constructor(frames?: Record<string, Frame>);
  frames: Record<string, Frame>;
  apply(message: unknown, now?: number): boolean;
  prune(now?: number): boolean;
  snapshot(): Record<string, LiveObject[]>;
}
export class PatientWatch {
  apply(topic: string, text: string, now?: number): boolean;
  isLive(camera: string, now?: number): boolean;
  tick(now?: number): boolean;
  merge(snapshot: Record<string, LiveObject[]>, now?: number): Record<string, LiveObject[]>;
}
export function startDetections(options: { mqttUrl: string; apiUrl: string; onChange: (snapshot: Record<string, LiveObject[]>) => void }): { tracker: DetectionTracker; watch: PatientWatch; stop: () => void };
