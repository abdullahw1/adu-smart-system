// Live object detections from Frigate, turned into short captions for the
// live view ("Person walking toward camera", "Car driving past", ...).
//
// Frigate publishes frigate/events over MQTT when a tracked object appears,
// changes noticeably, or leaves. Updates arrive every second or so, not every
// frame, so captions describe movement across the last few updates.
import mqtt from 'mqtt';

const HISTORY_MS = 6000; // movement is judged over this window
const STALE_MS = 30_000; // drop objects whose "end" we never received
const DEFAULT_FRAME = { width: 640, height: 360 };
const VEHICLES = new Set(['car', 'motorcycle', 'bicycle', 'bus', 'truck']);
const BAGS = new Set(['backpack', 'handbag', 'suitcase']);
const NOUN = { person: 'Person', car: 'Car', motorcycle: 'Motorcycle', bicycle: 'Bicycle', bus: 'Bus', truck: 'Truck', dog: 'Dog', cat: 'Cat' };

// Classify movement from the oldest and newest box in the history window.
// Boxes are [x1, y1, x2, y2] in detect-frame pixels.
export function movement(history, frame = DEFAULT_FRAME) {
  if (history.length < 2) return 'unknown';
  const [first, last] = [history[0].box, history[history.length - 1].box];
  const h0 = first[3] - first[1], h1 = last[3] - last[1];
  const dx = (last[0] + last[2]) / 2 - (first[0] + first[2]) / 2;
  // Height is the most reliable depth cue: objects grow as they approach.
  if (h0 > 0 && h1 / h0 >= 1.12) return 'toward';
  if (h0 > 0 && h1 / h0 <= 0.89) return 'away';
  if (Math.abs(dx) >= frame.width * 0.08) return 'across';
  return 'still';
}

export function describe({ label, stationary, zones = [], history = [] }, frame = DEFAULT_FRAME) {
  const noun = NOUN[label] || label[0].toUpperCase() + label.slice(1);
  const door = zones.find(zone => /door/i.test(zone));
  const where = door ? ' door' : ' camera';
  const move = stationary ? 'still' : movement(history, frame);
  if (BAGS.has(label)) return stationary ? 'Package or bag left here' : 'Bag or package';
  if (label === 'person') {
    if (move === 'toward') return `Person walking toward${where}`;
    if (move === 'away') return `Person walking away from${where}`;
    if (move === 'across') return 'Person walking past';
    if (move === 'still') return door ? 'Person at the door' : 'Person standing';
    return 'Person';
  }
  if (VEHICLES.has(label)) {
    const verb = label === 'car' || label === 'bus' || label === 'truck' ? 'driving' : 'riding';
    if (stationary) return label === 'car' ? 'Parked car' : `Parked ${label}`;
    if (move === 'toward') return `${noun} approaching`;
    if (move === 'away') return `${noun} ${verb} away`;
    if (move === 'across') return `${noun} ${verb} past`;
    return noun;
  }
  return noun;
}

// Keeps the current objects per camera from Frigate event messages.
export class DetectionTracker {
  constructor(frames = {}) { this.frames = frames; this.objects = new Map(); }

  apply(message, now = Date.now()) {
    const a = message?.after;
    if (!a || typeof a.id !== 'string' || typeof a.camera !== 'string' || !Array.isArray(a.box)) return false;
    if (message.type === 'end' || a.false_positive) return this.objects.delete(a.id);
    const previous = this.objects.get(a.id);
    const history = [...(previous?.history || []), { t: now, box: a.box.map(Number) }].filter(h => now - h.t <= HISTORY_MS);
    const object = {
      id: a.id, camera: a.camera, label: String(a.label), score: Number(a.score) || 0,
      box: a.box.map(Number), stationary: Boolean(a.stationary),
      zones: Array.isArray(a.current_zones) ? a.current_zones.map(String) : [], history, seen: now,
    };
    object.caption = describe(object, this.frame(a.camera));
    this.objects.set(a.id, object);
    return true;
  }

  frame(camera) { return this.frames[camera] || DEFAULT_FRAME; }

  prune(now = Date.now()) {
    let changed = false;
    for (const [id, o] of this.objects) if (now - o.seen > STALE_MS) { this.objects.delete(id); changed = true; }
    return changed;
  }

  // Browser-safe view: boxes as 0..1 fractions of the frame, no internals.
  snapshot() {
    const cameras = {};
    for (const o of this.objects.values()) {
      const { width, height } = this.frame(o.camera);
      const [x1, y1, x2, y2] = o.box;
      (cameras[o.camera] ||= []).push({
        id: o.id, label: o.label, caption: o.caption, score: Math.round(o.score * 100) / 100,
        box: [x1 / width, y1 / height, (x2 - x1) / width, (y2 - y1) / height].map(v => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000),
      });
    }
    return cameras;
  }
}

// Detect-frame sizes come from Frigate's config so boxes scale correctly.
async function loadFrames(apiUrl) {
  try {
    const res = await fetch(apiUrl.replace(/\/+$/, '') + '/api/config', { signal: AbortSignal.timeout(5000) });
    const config = await res.json();
    return Object.fromEntries(Object.entries(config.cameras || {}).map(([id, c]) => [id, { width: c.detect?.width || 640, height: c.detect?.height || 360 }]));
  } catch { return {}; }
}

// Captions from the patient-watch service (../patient-watch) for cameras it
// covers: the patient's body, hand gestures and "left the zone" alerts. It
// publishes adu/watch/<camera> several times a second and a retained
// adu/watch/<camera>/status (online | no_video | offline). On those cameras
// its patient box replaces Frigate's person box. If it stops or loses video,
// an alert caption says so: a silent monitor must not look like a calm room.
const WATCH_STALE_MS = 3000;
const WATCH_LABELS = new Set(['patient', 'gesture', 'alert']);

export class PatientWatch {
  constructor() { this.cameras = new Map(); this.live = new Map(); }

  apply(topic, text, now = Date.now()) {
    const match = /^adu\/watch\/([\w-]+)(\/status)?$/.exec(topic);
    if (!match) return false;
    const state = this.cameras.get(match[1]) || { objects: [], seen: 0, status: 'unknown' };
    this.cameras.set(match[1], state);
    if (match[2]) {
      state.status = String(text).trim();
      if (state.status !== 'online') state.objects = [];
      return true;
    }
    let data;
    try { data = JSON.parse(text); } catch { return false; }
    state.objects = (Array.isArray(data?.objects) ? data.objects : [])
      .filter(o => o && WATCH_LABELS.has(o.label) && typeof o.caption === 'string' && Array.isArray(o.box) && o.box.length === 4)
      .map(o => ({ id: `${match[1]}-${String(o.id)}`, label: o.label, caption: o.caption.slice(0, 80), score: Number(o.score) || 1,
        box: o.box.map(v => Math.min(1, Math.max(0, Number(v) || 0))) }));
    state.seen = now;
    state.status = 'online';
    return true;
  }

  isLive(camera, now = Date.now()) {
    const state = this.cameras.get(camera);
    return Boolean(state && state.status === 'online' && now - state.seen <= WATCH_STALE_MS);
  }

  // True when a camera's monitor went quiet or came back since the last tick.
  tick(now = Date.now()) {
    let changed = false;
    for (const camera of this.cameras.keys()) {
      const live = this.isLive(camera, now);
      if (this.live.get(camera) !== live) { this.live.set(camera, live); changed = true; }
    }
    return changed;
  }

  // Merges into a Frigate snapshot ({ camera: objects[] }).
  merge(snapshot, now = Date.now()) {
    const out = { ...snapshot };
    for (const [camera, state] of this.cameras) {
      if (this.isLive(camera, now)) {
        out[camera] = [...(out[camera] || []).filter(o => o.label !== 'person'), ...state.objects];
      } else {
        const caption = state.status === 'no_video' ? 'Patient monitor: no video' : 'Patient monitor offline';
        out[camera] = [...(out[camera] || []), { id: `${camera}-watch-offline`, label: 'alert', caption, score: 1, box: [0, 0, 1, 1] }];
      }
    }
    return out;
  }
}

// Connects to Frigate's MQTT broker and calls onChange(snapshot) when the set
// of objects changes. Reconnects quietly if Frigate isn't running yet.
export function startDetections({ mqttUrl, apiUrl, onChange }) {
  const tracker = new DetectionTracker();
  const watch = new PatientWatch();
  const emit = () => onChange(watch.merge(tracker.snapshot()));
  loadFrames(apiUrl).then(frames => { tracker.frames = frames; });
  const client = mqtt.connect(mqttUrl, { reconnectPeriod: 10_000, connectTimeout: 5000, clientId: 'adu-app-' + process.pid });
  client.on('connect', () => client.subscribe(['frigate/events', 'adu/watch/#']));
  client.on('error', () => {}); // offline Frigate is normal; mqtt keeps retrying
  client.on('message', (topic, payload) => {
    try {
      if (topic === 'frigate/events' ? tracker.apply(JSON.parse(payload.toString())) : watch.apply(topic, payload.toString())) emit();
    } catch { /* ignore malformed */ }
  });
  const timer = setInterval(() => { if (tracker.prune() | watch.tick()) emit(); }, 1000);
  return { tracker, watch, stop: () => { clearInterval(timer); client.end(true); } };
}
