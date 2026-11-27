// Pairs of face identities that probably show the same person.
import { authorize } from '@/server/security.mjs';
import { allSettings } from '@/server/store.mjs';
import { duplicates } from '@/server/faces.mjs';

export async function GET(request: Request) {
  const denied = await authorize(request); if (denied) return denied;
  const dismissed = new Set(Object.keys(allSettings('face-distinct:')));
  return Response.json({ pairs: duplicates(undefined, dismissed) }, { headers: { 'Cache-Control': 'no-store' } });
}
