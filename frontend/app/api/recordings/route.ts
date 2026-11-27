import { authorize } from '@/server/security.mjs';
import {
  CAMERA_ID_RE,
  recordingErrors,
  activeRecordings,
  listRecordings,
  startRecording,
  stopRecording,
} from "@/lib/recorder";

export async function GET(request: Request) {
  const denied = await authorize(request, "viewer"); if (denied) return denied;
  return Response.json({ active: activeRecordings(), files: await listRecordings(), errors: recordingErrors() });
}

// Body: { id: "cam_01", action: "start" | "stop" }
export async function POST(request: Request) {
  const denied = await authorize(request, "admin"); if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id, action } = (body ?? {}) as { id?: unknown; action?: unknown };
  if (typeof id !== "string" || !CAMERA_ID_RE.test(id) || (action !== "start" && action !== "stop")) {
    return Response.json({ error: 'Expected { id, action: "start" | "stop" }' }, { status: 400 });
  }

  try {
    if (action === "start") await startRecording(id);
    else await stopRecording(id);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
  return Response.json({ active: activeRecordings() });
}
