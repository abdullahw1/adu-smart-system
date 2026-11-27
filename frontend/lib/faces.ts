// Client side of app/api/faces: the face-watch face library.
import type { Duplicate, Identity } from '@/server/faces.mjs';
export type { Duplicate, Identity };

export type FaceAction =
  | { action: 'name'; id: string; name: string }
  | { action: 'merge'; ids: string[]; into: string }
  | { action: 'forget'; ids: string[] }
  | { action: 'forget-all'; confirm: 'all' }
  | { action: 'forget-samples'; id: string; keys: string[] }
  | { action: 'distinct'; a: string; b: string };

export async function fetchFaces(): Promise<{ configured: boolean; identities: Identity[] }> {
  const res = await fetch('/api/faces', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Faces unavailable (${res.status})`);
  return res.json();
}

export async function fetchDuplicates(): Promise<Duplicate[]> {
  const res = await fetch('/api/faces/duplicates', { cache: 'no-store' });
  return res.ok ? (await res.json()).pairs : [];
}

export async function changeFaces(body: FaceAction): Promise<Identity[]> {
  const res = await fetch('/api/faces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Change failed (${res.status})`);
  return data.identities;
}

export const photoUrl = (id: string, key: string) => `/api/faces/${encodeURIComponent(id)}/${encodeURIComponent(key)}.jpg`;
export const label = (f: Pick<Identity, 'id' | 'name'>) => f.name || f.id;

// Which of two identities to keep when merging: a named one, else the one seen more.
export function keeper(a: Identity, b: Identity): Identity {
  if (!!a.name !== !!b.name) return a.name ? a : b;
  return b.sightings > a.sightings ? b : a;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
