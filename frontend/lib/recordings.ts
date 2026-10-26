// Client side of app/api/recordings: on-demand recordings saved on the server.

export type ActiveRecording = { file: string; startedAt: number };
export type RecordingFile = { file: string; camera: string; size: number; createdAt: number };
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
