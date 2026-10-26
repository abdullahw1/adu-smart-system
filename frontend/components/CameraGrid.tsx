"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LivePlayer, type PlayerStatus } from "@/components/LivePlayer";
import { fetchCameraNames, saveCameraName, type CameraNames } from "@/lib/cameraNames";
import { fetchCameras, go2rtcBase, type Camera } from "@/lib/go2rtc";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; cameras: Camera[] };

export function CameraGrid() {
  const [base, setBase] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [names, setNames] = useState<CameraNames>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async (b: string) => {
    setLoad({ state: "loading" });
    fetchCameraNames().then(setNames);
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
    if (!expandedId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpandedId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedId]);

  const rename = async (id: string, name: string) => setNames(await saveCameraName(id, name));

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

  const cameras = load.cameras.map((cam) => ({ ...cam, label: names[cam.id] ?? cam.label }));
  const expanded = cameras.find((cam) => cam.id === expandedId);

  return (
    <>
      <div className="grid">
        {cameras.map((cam) => (
          <Tile key={cam.id} base={base} camera={cam} onOpen={() => setExpandedId(cam.id)} />
        ))}
      </div>
      {expanded && (
        <Expanded
          base={base}
          camera={expanded}
          onRename={(name) => rename(expanded.id, name)}
          onClose={() => setExpandedId(null)}
        />
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

function Expanded({
  base,
  camera,
  onRename,
  onClose,
}: {
  base: string;
  camera: Camera;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
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
          <CameraTitle label={camera.label} onRename={onRename} />
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

// Click "Rename" to edit in place. Enter saves, Escape cancels; saving an empty
// name restores the default.
function CameraTitle({ label, onRename }: { label: string; onRename: (name: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const cancel = () => {
    setDraft(null);
    setError(null);
  };

  const save = async () => {
    if (draft === null || saving) return;
    if (draft.trim() === label) return cancel();
    setSaving(true);
    try {
      await onRename(draft);
      cancel();
    } catch {
      setError("Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <>
        <h2>{label}</h2>
        <button className="rename" onClick={() => setDraft(label)} aria-label={`Rename ${label}`}>
          Rename
        </button>
      </>
    );
  }

  return (
    <form
      className="rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        ref={inputRef}
        value={draft}
        maxLength={40}
        aria-label="Camera name"
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation(); // cancel the edit, don't close the viewer
          cancel();
        }}
      />
      <button type="submit" disabled={saving}>
        Save
      </button>
      <button type="button" onClick={cancel} disabled={saving}>
        Cancel
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function StatusBadge({ status, inline = false }: { status: PlayerStatus; inline?: boolean }) {
  const text = { connecting: "Connecting", live: "Live", "no-signal": "No signal" }[status];
  return <span className={`badge badge-${status}${inline ? " badge-inline" : ""}`}>{text}</span>;
}
