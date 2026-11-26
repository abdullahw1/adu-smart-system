"use client";
import { useEffect, useSyncExternalStore } from "react";

// Box is [left, top, width, height] as 0..1 fractions of the camera frame.
export type LiveObject = { id: string; label: string; caption: string; score: number; box: [number, number, number, number] };
type Snapshot = Record<string, LiveObject[]>;

// One EventSource (/live/detections) shared by the whole page; opened on first
// use, closed when the last user unmounts. EventSource reconnects on its own
// after errors, including while the server restarts.
let source: EventSource | null = null;
let current: Snapshot = {};
let loadedBuild: string | null = null;
const listeners = new Set<() => void>();
const EMPTY: LiveObject[] = [];

// After a deploy the server restarts with a new build id. Reload so the page
// runs the new code, but not while someone is typing into a field.
function reloadForNewBuild() {
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
  if (typing) setTimeout(reloadForNewBuild, 5000);
  else window.location.reload();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!source) {
    source = new EventSource("/live/detections");
    source.addEventListener("build", (event) => {
      let build: string;
      try { build = JSON.parse((event as MessageEvent).data); } catch { return; }
      if (loadedBuild === null) loadedBuild = build;
      else if (build !== loadedBuild) reloadForNewBuild();
    });
    source.onmessage = (event) => {
      try { current = JSON.parse(event.data); } catch { return; }
      listeners.forEach((l) => l());
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) { source.close(); source = null; current = {}; }
  };
}

export function useDetections(camera: string): LiveObject[] {
  return useSyncExternalStore(subscribe, () => current[camera] || EMPTY, () => EMPTY);
}

// Keeps the live feed open (and so the reload-on-deploy check) on any page.
export function useLiveFeed(enabled: boolean) {
  useEffect(() => (enabled ? subscribe(() => {}) : undefined), [enabled]);
}
