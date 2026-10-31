import { readSetting, writeSetting } from '@/server/store.mjs';
export type CameraPrefs = { zone?: string; flip?: boolean };
export async function readPrefs(id: string): Promise<CameraPrefs> { return readSetting('prefs:' + id, {}); }
export async function updatePrefs(id: string, patch: CameraPrefs): Promise<void> { writeSetting('prefs:' + id, patch, true); }

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
