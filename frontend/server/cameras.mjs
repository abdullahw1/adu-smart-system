export const CAMERA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function upstreamBase() { return (process.env.GO2RTC_API_URL || 'http://127.0.0.1:1984').replace(/\/+$/, ''); }
export async function cameras() {
  const res = await fetch(upstreamBase() + '/api/streams', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!res.ok) throw new Error('Camera service unavailable');
  const ids = Object.keys(await res.json()).filter(id => CAMERA_ID_RE.test(id));
  const all = new Set(ids);
  return ids.filter(id => !id.endsWith('_sub')).sort().map(id => ({
    id, label: id.split('_').map(s => s[0]?.toUpperCase() + s.slice(1)).join(' '),
    mainSrc: id, gridSrc: all.has(id + '_sub') ? id + '_sub' : id,
  }));
}
export async function allowedStream(id) {
  if (!CAMERA_ID_RE.test(id)) return false;
  return (await cameras()).some(cam => cam.mainSrc === id || cam.gridSrc === id);
}
