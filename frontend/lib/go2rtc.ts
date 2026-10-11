// go2rtc is the only thing that talks to cameras. The app just asks it which
// streams exist and plays them in the browser — never raw RTSP.

export type Camera = {
  id: string;     // go2rtc stream name, e.g. "cam_01"
  label: string;  // display name, e.g. "Cam 01"
  gridSrc: string; // low-res sub stream for the grid (falls back to main)
  mainSrc: string; // full-res main stream for the expanded view
};

const SUB_SUFFIX = "_sub";

export function go2rtcBase(): string {
  const configured = process.env.NEXT_PUBLIC_GO2RTC_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return `${window.location.protocol}//${window.location.hostname}:1984`;
}

export function streamUrl(base: string, src: string): string {
  return `${base}/api/ws?src=${encodeURIComponent(src)}`;
}

export async function fetchCameras(base: string): Promise<Camera[]> {
  const res = await fetch(`${base}/api/streams`, { cache: "no-store" });
  if (!res.ok) throw new Error(`go2rtc returned ${res.status}`);
  const names = Object.keys((await res.json()) ?? {});
  const all = new Set(names);

  return names
    .filter((name) => !name.endsWith(SUB_SUFFIX))
    .sort()
    .map((id) => ({
      id,
      label: toLabel(id),
      gridSrc: all.has(id + SUB_SUFFIX) ? id + SUB_SUFFIX : id,
      mainSrc: id,
    }));
}

function toLabel(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// go2rtc serves its own player (<video-stream>, MIT). Load it straight from the
// server as a module script so it always matches the server version and the
// bundler never touches it.
let playerReady: Promise<void> | null = null;

export function loadPlayer(base: string): Promise<void> {
  if (!playerReady) {
    playerReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = `${base}/video-stream.js`;
      script.onerror = () => {
        playerReady = null;
        script.remove();
        reject(new Error(`Could not load player from ${base}`));
      };
      document.head.appendChild(script);
      customElements.whenDefined("video-stream").then(() => resolve());
    });
  }
  return playerReady;
}
