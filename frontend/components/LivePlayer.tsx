"use client";

import { useEffect, useRef } from "react";
import { loadPlayer, streamUrl } from "@/lib/go2rtc";

export type PlayerStatus = "connecting" | "live" | "no-signal";

// If no frame arrives in this long, call it out. go2rtc's player keeps
// retrying in the background, so the tile recovers on its own.
const NO_SIGNAL_AFTER_MS = 12_000;

type VideoStreamElement = HTMLElement & {
  mode: string;
  src: string;
  visibilityThreshold: number;
  DISCONNECT_TIMEOUT: number;
  video?: HTMLVideoElement;
};

type Props = {
  base: string;
  src: string;
  controls?: boolean;
  muted?: boolean;
  onStatus?: (status: PlayerStatus) => void;
};

export function LivePlayer({ base, src, controls = false, muted = true, onStatus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    let cancelled = false;
    let el: VideoStreamElement | null = null;
    let noSignalTimer: ReturnType<typeof setTimeout> | undefined;
    const report = (s: PlayerStatus) => !cancelled && onStatusRef.current?.(s);

    const armNoSignal = () => {
      clearTimeout(noSignalTimer);
      noSignalTimer = setTimeout(() => report("no-signal"), NO_SIGNAL_AFTER_MS);
    };

    report("connecting");
    armNoSignal();

    loadPlayer(base)
      .then(() => {
        if (cancelled || !hostRef.current) return;
        el = document.createElement("video-stream") as VideoStreamElement;
        // MSE first: plays H.264 everywhere and H.265 in Chrome/Edge/Safari.
        el.mode = "mse,webrtc,hls";
        // Pause tiles scrolled out of view to save bandwidth/decoder.
        el.visibilityThreshold = 0.05;
        hostRef.current.appendChild(el);

        const video = el.video;
        if (video) {
          video.controls = controls;
          video.muted = muted;
          video.addEventListener("playing", () => {
            clearTimeout(noSignalTimer);
            report("live");
          });
          // Stream dropped mid-play (camera unplugged, network blip).
          video.addEventListener("waiting", armNoSignal);
          video.addEventListener("emptied", armNoSignal);
        }
        el.src = streamUrl(base, src);
      })
      .catch(() => report("no-signal"));

    return () => {
      cancelled = true;
      clearTimeout(noSignalTimer);
      if (el) {
        el.DISCONNECT_TIMEOUT = 0; // close the socket now, not after 5s
        el.remove();
      }
    };
  }, [base, src, controls, muted]);

  return <div ref={hostRef} className="player" />;
}
