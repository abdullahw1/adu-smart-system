import { authorize } from '@/server/security.mjs';
import { frigateFetch, historySelection } from '@/lib/frigate';
export async function GET(request: Request) {
  const denied = await authorize(request); if (denied) return denied;
  if (!process.env.FRIGATE_API_URL) return Response.json({ configured: false, segments: [] });
  let selection;
  try { selection = await historySelection(request, 90000); }
  catch { return Response.json({ error: 'Choose a camera and up to one day of history' }, { status: 400 }); }
  try {
    const { camera, start, end } = selection;
    const response = await frigateFetch(`/api/${camera}/recordings?after=${start}&before=${end}`, request);
    if (!response.ok) throw new Error();
    const records = await response.json();
    return Response.json({ configured: true, segments: records.map((record: { start_time: number; end_time: number }) => ({ start: record.start_time, end: record.end_time })) });
  } catch { return Response.json({ error: 'Continuous recorder is unavailable' }, { status: 502 }); }
}
