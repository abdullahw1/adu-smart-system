import { authorize } from '@/server/security.mjs';
import { withCameraLock } from "@/lib/serial";
import { cameraCredentials } from "@/lib/cameraConfig";
import { readPrefs, updatePrefs, zoneOffsetMinutes } from "@/lib/cameraPrefs";
import {
  getSettings,
  setFlip,
  setImage,
  setTime,
  type Credentials,
  type ImageSettings,
  type TimeUpdate,
} from "@/lib/onvif";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const denied = await authorize(request, "admin"); if (denied) return denied;
  const { id } = await params;
  const cam = cameraCredentials(id);
  if (!cam) return notConfigured(id);
  try {
    return Response.json(await describe(id, cam));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

// Body: any of
//   time:  { zone: "America/Los_Angeles", mode: "manual" | "ntp", ntpServer? }
//   image: { brightness?, contrast?, saturation?, sharpness?, dayNight?, wdr?, backlight? }
//   flip:  boolean
// Returns the settings as read back afterwards, so the page shows what stuck.
export async function PATCH(request: Request, { params }: Ctx) {
  const denied = await authorize(request, "admin"); if (denied) return denied;
  const { id } = await params;
  const cam = cameraCredentials(id);
  if (!cam) return notConfigured(id);

  let body: { time?: unknown; image?: unknown; flip?: unknown };
  try {
    body = (await request.json()) ?? {};
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const time = body.time === undefined ? undefined : parseTime(body.time);
  const image = body.image === undefined ? undefined : parseImage(body.image);
  if (time === null || image === null || (body.flip !== undefined && typeof body.flip !== "boolean")) {
    return Response.json({ error: "Invalid settings" }, { status: 400 });
  }

  try { return await withCameraLock(id, async () => {
    if (time) {
      await setTime(cam, time);
      await updatePrefs(id, { zone: time.zone });
    }
    if (image) await setImage(cam, image);
    if (typeof body.flip === "boolean") {
      await setFlip(cam, body.flip);
      await updatePrefs(id, { flip: body.flip });
    }
    return Response.json(await describe(id, cam));
  }); } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

async function describe(id: string, cam: Credentials) {
  const [settings, prefs] = await Promise.all([getSettings(cam), readPrefs(id)]);
  const expected = prefs.zone ? zoneOffsetMinutes(prefs.zone) : null;
  const { utc } = settings.time;
  return {
    ...settings,
    time: {
      ...settings.time,
      zone: prefs.zone ?? null,
      // Daylight saving started/ended since the zone was applied, or the
      // clock has drifted: either way, re-apply.
      needsSync:
        (expected !== null && settings.time.offsetMinutes !== expected) ||
        (utc !== null && Math.abs(Date.parse(utc) - Date.now()) > 2 * 60_000),
    },
    flip: prefs.flip ?? null, // null: never set from this app, so unknown
  };
}

function notConfigured(id: string) {
  return Response.json(
    { error: `No address configured for ${id} (set CAM${id.replace(/\D/g, "").padStart(2, "0")}_HOST in .env)` },
    { status: 404 },
  );
}

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

function parseTime(v: unknown): (TimeUpdate & { zone: string }) | null {
  const t = v as { zone?: unknown; mode?: unknown; ntpServer?: unknown } | null;
  if (!t || (t.mode !== "manual" && t.mode !== "ntp") || typeof t.zone !== "string") return null;
  const offsetMinutes = zoneOffsetMinutes(t.zone);
  if (offsetMinutes === null) return null;
  const ntpServer = typeof t.ntpServer === "string" ? t.ntpServer.trim() : "";
  if (t.mode === "ntp" && !HOST_RE.test(ntpServer)) return null;
  return { zone: t.zone, mode: t.mode, offsetMinutes, ntpServer };
}

const LEVELS = ["brightness", "contrast", "saturation", "sharpness"] as const;
const FLAGS = ["wdr", "backlight"] as const;

function parseImage(v: unknown): Partial<ImageSettings> | null {
  if (!v || typeof v !== "object") return null;
  const i = v as Record<string, unknown>;
  const out: Partial<ImageSettings> = {};
  for (const k of LEVELS) {
    if (i[k] === undefined) continue;
    const n = i[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 255) return null;
    out[k] = n;
  }
  for (const k of FLAGS) {
    if (i[k] === undefined) continue;
    if (typeof i[k] !== "boolean") return null;
    out[k] = i[k];
  }
  if (i.dayNight !== undefined) {
    if (i.dayNight !== "auto" && i.dayNight !== "day" && i.dayNight !== "night") return null;
    out.dayNight = i.dayNight;
  }
  return out;
}
