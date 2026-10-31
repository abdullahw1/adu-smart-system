import { allSettings, writeSetting } from '@/server/store.mjs';
import { authorize } from '@/server/security.mjs';
import { cameras } from '@/server/cameras.mjs';
export async function GET(request: Request) {
  const denied = await authorize(request); if (denied) return denied;
  return Response.json(allSettings<string>('name:'));
}
export async function PUT(request: Request) {
  const denied = await authorize(request, 'admin'); if (denied) return denied;
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const { id, name } = body ?? {};
  if (typeof id !== 'string' || typeof name !== 'string' || name.trim().length > 40 || !(await cameras()).some(cam => cam.id === id)) {
    return Response.json({ error: 'Choose a configured camera and a name up to 40 characters' }, { status: 400 });
  }
  writeSetting('name:' + id, name.trim());
  return Response.json(allSettings<string>('name:'));
}
