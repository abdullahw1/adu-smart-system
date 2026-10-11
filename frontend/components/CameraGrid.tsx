"use client";

import { useCallback, useEffect, useState } from "react";
import { LivePlayer, type PlayerStatus } from "@/components/LivePlayer";
import { fetchCameras, go2rtcBase, type Camera } from "@/lib/go2rtc";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; cameras: Camera[] };

export function CameraGrid() {
  const [base, setBase] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [expanded, setExpanded] = useState<Camera | null>(null);

  const refresh = useCallback(async (b: string) => {
    setLoad({ state: "loading" });
    try {
      setLoad({ state: "ready", cameras: await fetchCameras(b) });
    } catch {
      setLoad({ state: "error", message: `Can't reach the stream server at ${b}` });
    }
  }, []);

  useEffect(() => {
    const b = go2rtcBase();
    setBase(b);
    refresh(b);
  }, [refresh]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (!base || load.state === "loading") {
    return <p className="notice">Loading cameras…</p>;
  }

  if (load.state === "error") {
    return (
      <div className="notice">
        <p>{load.message}</p>
        <button onClick={() => refresh(base)}>Retry</button>
      </div>
    );
  }

  if (load.cameras.length === 0) {
    return <p className="notice">No cameras configured in go2rtc yet.</p>;
  }

  return (
    <>
      <div className="grid">
        {load.cameras.map((cam) => (
          <Tile key={cam.id} base={base} camera={cam} onOpen={() => setExpanded(cam)} />
        ))}
      </div>
      {expanded && (
        <Expanded base={base} camera={expanded} onClose={() => setExpanded(null)} />
      )}
    </>
  );
}

function Tile({ base, camera, onOpen }: { base: string; camera: Camera; onOpen: () => void }) {
  const [status, setStatus] = useState<PlayerStatus>("connecting");
  return (
    <div
      className="tile"
      role="button"
      tabIndex={0}
      aria-label={`Open ${camera.label}`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
    >
      <LivePlayer base={base} src={camera.gridSrc} onStatus={setStatus} />
      <span className="tile-label">{camera.label}</span>
      <StatusBadge status={status} />
    </div>
  );
}

function Expanded({ base, camera, onClose }: { base: string; camera: Camera; onClose: () => void }) {
  // Main stream is H.265; browsers without HEVC support (e.g. Firefox) never
  // get a frame. Drop to the sub stream rather than show a black box.
  const [src, setSrc] = useState(camera.mainSrc);
  const [status, setStatus] = useState<PlayerStatus>("connecting");

  const handleStatus = (s: PlayerStatus) => {
    setStatus(s);
    if (s === "no-signal" && src !== camera.gridSrc) setSrc(camera.gridSrc);
  };

  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-label={camera.label}>
      <div className="expanded" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{camera.label}</h2>
          <span className="muted">{src === camera.mainSrc ? "Full quality" : "Low quality"}</span>
          <StatusBadge status={status} inline />
          <button className="close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <LivePlayer key={src} base={base} src={src} controls muted onStatus={handleStatus} />
      </div>
    </div>
  );
}

function StatusBadge({ status, inline = false }: { status: PlayerStatus; inline?: boolean }) {
  const text = { connecting: "Connecting", live: "Live", "no-signal": "No signal" }[status];
  return <span className={`badge badge-${status}${inline ? " badge-inline" : ""}`}>{text}</span>;
}
