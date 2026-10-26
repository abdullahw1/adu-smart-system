// Server-only. Settings the app has to remember itself because the camera
// can't tell us: which time zone it should follow (the camera only stores a
// fixed offset) and whether it's flipped (never reported back over ONVIF).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), "data", "camera-settings.json");

export type CameraPrefs = { zone?: string; flip?: boolean };

export async function readPrefs(id: string): Promise<CameraPrefs> {
  return (await readAll())[id] ?? {};
}

export async function updatePrefs(id: string, patch: CameraPrefs): Promise<void> {
  const all = await readAll();
  all[id] = { ...all[id], ...patch };
  // Write-then-rename so a crash mid-write can't leave a half-written file.
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2) + "\n");
  await rename(tmp, FILE);
}

async function readAll(): Promise<Record<string, CameraPrefs>> {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

// Current UTC offset of an IANA zone in minutes (e.g. -420 for Los Angeles in
// summer), or null if the zone name isn't valid.
export function zoneOffsetMinutes(zone: string, at = new Date()): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name ?? "");
    if (!m) return null;
    return m[1] ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  } catch {
    return null;
  }
}
