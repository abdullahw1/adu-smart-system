// Face library (face-watch): list identities; admins name, merge and delete them.
import { authorize } from '@/server/security.mjs';
import { writeSetting } from '@/server/store.mjs';
import { ID_RE, NAME_MAX, forget, forgetSamples, listIdentities, merge, pairKey, setName } from '@/server/faces.mjs';

const noStore = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(request: Request) {
  const denied = await authorize(request); if (denied) return denied;
  const identities = listIdentities();
  return Response.json({ configured: identities !== null, identities: identities ?? [] }, noStore);
}

// Body, one of:
//   { action: 'name', id, name }                 name ('' clears it)
//   { action: 'merge', ids: [...], into }        same person: ids join `into`
//   { action: 'forget', ids: [...] }             delete identities, samples and photos
//   { action: 'forget-all', confirm: 'all' }     delete the whole library
//   { action: 'forget-samples', id, keys: [...] } delete single photos of one identity
//   { action: 'distinct', a, b }                 not the same person: stop suggesting the pair
export async function POST(request: Request) {
  const denied = await authorize(request, 'admin'); if (denied) return denied;
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const bad = (error: string) => Response.json({ error }, { status: 400 });
  const ids = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every(v => typeof v === 'string' && ID_RE.test(v));
  switch (body?.action) {
    case 'name':
      if (typeof body.id !== 'string' || typeof body.name !== 'string' || body.name.trim().length > NAME_MAX) return bad(`Use a name up to ${NAME_MAX} characters`);
      if (!setName(body.id, body.name)) return Response.json({ error: 'No such face' }, { status: 404 });
      break;
    case 'merge':
      if (!ids(body.ids) || typeof body.into !== 'string') return bad('Choose the faces to merge and the one to keep');
      if (!merge(body.ids, body.into)) return bad('Nothing merged: check the faces still exist');
      break;
    case 'forget':
      if (!ids(body.ids)) return bad('Choose the faces to delete');
      forget(body.ids);
      break;
    case 'forget-all':
      if (body.confirm !== 'all') return bad('Confirm deleting every face');
      forget('all');
      break;
    case 'forget-samples':
      if (typeof body.id !== 'string' || !Array.isArray(body.keys) || !body.keys.every((k: unknown) => typeof k === 'string')) return bad('Choose the photos to delete');
      forgetSamples(body.id, body.keys);
      break;
    case 'distinct':
      if (typeof body.a !== 'string' || typeof body.b !== 'string' || !ID_RE.test(body.a) || !ID_RE.test(body.b)) return bad('Choose two faces');
      writeSetting('face-distinct:' + pairKey(body.a, body.b), true);
      break;
    default:
      return bad('Unknown action');
  }
  return Response.json({ identities: listIdentities() ?? [] }, noStore);
}
