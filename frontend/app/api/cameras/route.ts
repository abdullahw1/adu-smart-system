import { authorize } from '@/server/security.mjs';
import { cameras } from '@/server/cameras.mjs';
export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  try { return Response.json(await cameras()); }
  catch { return Response.json({ error: 'Camera service unavailable' }, { status: 502 }); }
}
