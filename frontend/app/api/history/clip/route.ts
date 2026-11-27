import { authorize } from '@/server/security.mjs';
import { frigateFetch, historySelection } from '@/lib/frigate';
export async function GET(request: Request) {
  const denied = await authorize(request); if (denied) return denied;
  let selection;
  try { selection = await historySelection(request, 3600); }
  catch { return Response.json({ error: 'Choose a camera and a clip up to one hour' }, { status: 400 }); }
  try {
    const { camera, start, end } = selection;
    const upstream = await frigateFetch(`/api/${camera}/start/${start}/end/${end}/clip.mp4`, request);
    if (![200, 206, 416].includes(upstream.status)) return Response.json({ error: 'No recording for this range' }, { status: 404 });
    const headers = new Headers({ 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
    for (const name of ['content-length', 'content-range']) if (upstream.headers.has(name)) headers.set(name, upstream.headers.get(name)!);
    if (new URL(request.url).searchParams.has('download')) headers.set('Content-Disposition', `attachment; filename="${camera}_${start}_${end}.mp4"`);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch { return Response.json({ error: 'Recording unavailable' }, { status: 502 }); }
}
