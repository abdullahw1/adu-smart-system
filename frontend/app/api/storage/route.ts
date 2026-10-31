import { authorize } from '@/server/security.mjs';
import { storageStatus, recordingErrors } from '@/lib/recorder';
export async function GET(request: Request) {
  const denied = await authorize(request); if (denied) return denied;
  try { return Response.json({ ...await storageStatus(), errors: recordingErrors() }); }
  catch { return Response.json({ error: 'Recording storage unavailable. Check the drive mount.' }, { status: 503 }); }
}
