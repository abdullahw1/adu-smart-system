"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCameraNames, type CameraNames } from "@/lib/cameraNames";
import {
  deleteRecording,
  fetchRecordings,
  recordingUrl,
  type Recordings,
} from "@/lib/recordings";

export function RecordingList() {
  const [data, setData] = useState<Recordings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<CameraNames>({});
  const [playing, setPlaying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchRecordings());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    fetchCameraNames().then(setNames);
    refresh();
    const timer = setInterval(refresh, 5_000); // file sizes grow while recording
    return () => clearInterval(timer);
  }, [refresh]);

  const remove = async (file: string) => {
    if (!confirm(`Delete ${file}? This can't be undone.`)) return;
    try {
      await deleteRecording(file);
      if (playing === file) setPlaying(null);
      await refresh();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  if (error && !data) {
    return (
      <div className="notice">
        <p>{error}</p>
        <button onClick={refresh}>Retry</button>
      </div>
    );
  }
  if (!data) return <p className="notice">Loading recordings…</p>;
  if (data.files.length === 0) {
    return <p className="notice">No recordings yet. Open a camera and press Record.</p>;
  }

  const activeFiles = new Set(Object.values(data.active).map((r) => r.file));

  return (
    <ul className="recordings">
      {data.files.map((rec) => {
        const live = activeFiles.has(rec.file);
        return (
          <li key={rec.file}>
            <div className="recording-row">
              <span className="recording-camera">{names[rec.camera] ?? rec.camera}</span>
              <span className="muted">{new Date(rec.createdAt).toLocaleString()}</span>
              <span className="muted">{formatSize(rec.size)}</span>
              {live && <span className="rec-inline">REC</span>}
              <span className="recording-actions">
                <button onClick={() => setPlaying(playing === rec.file ? null : rec.file)}>
                  {playing === rec.file ? "Hide" : "Play"}
                </button>
                <a className="button" href={recordingUrl(rec.file, true)}>
                  Download
                </a>
                <button onClick={() => remove(rec.file)} disabled={live}>
                  Delete
                </button>
              </span>
            </div>
            {playing === rec.file && (
              <video className="recording-video" src={recordingUrl(rec.file)} controls autoPlay />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
