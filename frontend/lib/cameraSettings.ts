// Client side of app/api/cameras/[id]/settings: camera settings over ONVIF.

export type DayNight = "auto" | "day" | "night";

export type CameraSettings = {
  info: { manufacturer: string; model: string; firmware: string };
  time: {
    mode: "manual" | "ntp";
    utc: string | null;
    offsetMinutes: number | null;
    ntpServer: string;
    zone: string | null;
    needsSync: boolean;
  };
  image: {
    brightness: number;
    contrast: number;
    saturation: number;
    sharpness: number;
    dayNight: DayNight;
    wdr: boolean;
    backlight: boolean;
  };
  flip: boolean | null;
};

export type SettingsPatch = {
  time?: { zone: string; mode: "manual" | "ntp"; ntpServer?: string };
  image?: Partial<CameraSettings["image"]>;
  flip?: boolean;
};

export async function fetchCameraSettings(id: string): Promise<CameraSettings> {
  return request(id, { cache: "no-store" });
}

export async function updateCameraSettings(id: string, patch: SettingsPatch): Promise<CameraSettings> {
  return request(id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function request(id: string, init: RequestInit): Promise<CameraSettings> {
  const res = await fetch(`/api/cameras/${encodeURIComponent(id)}/settings`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Camera settings failed (${res.status})`);
  return data;
}

export const TIME_ZONES = [
  { zone: "America/Los_Angeles", label: "Pacific" },
  { zone: "America/Denver", label: "Mountain" },
  { zone: "America/Phoenix", label: "Arizona (no DST)" },
  { zone: "America/Chicago", label: "Central" },
  { zone: "America/New_York", label: "Eastern" },
  { zone: "America/Anchorage", label: "Alaska" },
  { zone: "Pacific/Honolulu", label: "Hawaii" },
  { zone: "UTC", label: "UTC" },
];

// The camera's own clock, shown in its own configured offset.
export function formatCameraClock(utc: string, offsetMinutes: number): string {
  const shifted = new Date(Date.parse(utc) + offsetMinutes * 60_000);
  return shifted.toLocaleString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
