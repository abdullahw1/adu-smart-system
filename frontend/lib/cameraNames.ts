// Custom display names, served by the app itself (app/api/camera-names).
// Keyed by go2rtc stream id; a missing entry means "use the default label".

export type CameraNames = Record<string, string>;

export async function fetchCameraNames(): Promise<CameraNames> {
  try {
    const res = await fetch("/api/camera-names", { cache: "no-store" });
    return res.ok ? await res.json() : {};
  } catch {
    return {}; // names are cosmetic; never block the live view on them
  }
}

export async function saveCameraName(id: string, name: string): Promise<CameraNames> {
  const res = await fetch("/api/camera-names", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  if (!res.ok) throw new Error(`Rename failed (${res.status})`);
  return res.json();
}
