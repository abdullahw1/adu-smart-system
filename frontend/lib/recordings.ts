// Client side of app/api/recordings: on-demand recordings saved on the server.

export type ActiveRecording = { file: string; startedAt: number };
export type RecordingFile = { file: string; camera: string; size: number; createdAt: number; captions?: boolean };
export type Recordings = { active: Record<string, ActiveRecording>; files: RecordingFile[] };

export async function fetchRecordings(): Promise<Recordings> {
  const res = await fetch("/api/recordings", { cache: "no-store" });
  if (!res.ok) throw new Error(`Recordings unavailable (${res.status})`);
  return res.json();
}

export async function setRecording(
  id: string,
  action: "start" | "stop",
): Promise<Record<string, ActiveRecording>> {
  const res = await fetch("/api/recordings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Recording ${action} failed (${res.status})`);
  return data.active;
}

export async function deleteRecording(file: string): Promise<void> {
  const res = await fetch(recordingUrl(file), { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Delete failed (${res.status})`);
  }
}

export function recordingUrl(file: string, download = false): string {
  return `/api/recordings/${encodeURIComponent(file)}${download ? "?download" : ""}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

// Detection captions saved alongside a recording: one frame per change, t in
// ms from the clip's first frame. Boxes are [left, top, width, height] 0..1.
export type CaptionFrame = { t: number; objects: { id: string; label: string; caption: string; box: number[] }[] };
const NO_OBJECTS: CaptionFrame["objects"] = [];

export async function fetchCaptions(file: string): Promise<CaptionFrame[]> {
  const res = await fetch(`${recordingUrl(file)}?captions`, { cache: "no-store" });
  if (!res.ok) return [];
  const { frames } = await res.json();
  return Array.isArray(frames) ? frames.filter((f) => typeof f?.t === "number" && Array.isArray(f.objects)) : [];
}

// Objects on screen at playback time `ms`: the last frame at or before it.
// Returns the same array for the same frame, so callers can skip re-renders.
export function framesAt(frames: CaptionFrame[], ms: number): CaptionFrame["objects"] {
  let lo = 0, hi = frames.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? NO_OBJECTS : frames[found].objects;
}

// Copy of a recording with the captions drawn into the picture (made on the
// server on request; see lib/captioned.ts).
export type CaptionedState = { state: "none" | "queued" | "rendering" | "ready" | "error"; progress?: number; error?: string };

export async function captionedStatus(file: string): Promise<CaptionedState> {
  const res = await fetch(`${recordingUrl(file)}?captioned=status`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Status unavailable (${res.status})`);
  return res.json();
}

export async function requestCaptioned(file: string): Promise<CaptionedState> {
  const res = await fetch(recordingUrl(file), { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Could not start (${res.status})`);
  return data;
}

export const captionedUrl = (file: string) => `${recordingUrl(file)}?captioned`;
