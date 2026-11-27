// go2rtc is the only thing that talks to cameras. The app just asks it which
// streams exist and plays them in the browser — never raw RTSP.

export type Camera = {
  id: string;     // go2rtc stream name, e.g. "cam_01"
  label: string;  // display name, e.g. "Cam 01"
  gridSrc: string; // low-res sub stream for the grid (falls back to main)
  mainSrc: string; // full-res main stream for the expanded view
};

const SUB_SUFFIX = "_sub";

// Streaming stays on the authenticated app origin in development and production.
export function go2rtcBase(): string { return window.location.origin; }
export function streamUrl(base: string, src: string): string {
  const url = new URL('/live/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('src', src);
  return url.toString();
}
export async function fetchCameras(_base?: string): Promise<Camera[]> {
  const res = await fetch('/api/cameras', { cache: 'no-store' });
  if (!res.ok) throw new Error('Camera service unavailable');
  return res.json();
}
