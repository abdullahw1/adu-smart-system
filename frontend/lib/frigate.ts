import { cameras } from '@/server/cameras.mjs';
export async function historySelection(request: Request, maxSeconds: number) {
  const query = new URL(request.url).searchParams;
  const camera = query.get('camera') || '';
  const start = Number(query.get('start')), end = Number(query.get('end'));
  if (!query.has('start') || !query.has('end') || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > maxSeconds || !(await cameras()).some(cam => cam.id === camera)) throw new Error('Invalid camera or time range');
  return { camera, start: Math.floor(start), end: Math.floor(end) };
}
export async function frigateFetch(route: string, request: Request) {
  const base = process.env.FRIGATE_API_URL;
  if (!base) throw new Error('Continuous recording is not configured yet');
  // This endpoint is only available inside the trusted host/container network.
  const headers: Record<string, string> = {};
  if (request.headers.has('range')) headers.Range = request.headers.get('range')!;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try { return await fetch(base.replace(/\/+$/, '') + route, { headers, signal: controller.signal, cache: 'no-store', redirect: 'error' }); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}
