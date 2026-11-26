"use client";
import { useEffect, useState } from "react";
import { captionedStatus, captionedUrl, requestCaptioned, type CaptionedState } from "@/lib/recordings";

// "With captions" download: asks the server for a copy of the clip with the
// detection boxes and captions drawn in, shows progress, then offers it.
export function CaptionedDownload({ file, disabled }: { file: string; disabled?: boolean }) {
  const [status, setStatus] = useState<CaptionedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = status?.state === "queued" || status?.state === "rendering";

  useEffect(() => { captionedStatus(file).then(setStatus).catch(() => setStatus({ state: "none" })); }, [file]);

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      captionedStatus(file).then((s) => { setStatus(s); if (s.state === "error") setError(s.error ?? "Failed"); }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [file, working]);

  const start = async () => {
    setError(null);
    try { setStatus(await requestCaptioned(file)); }
    catch (err) { setError((err as Error).message); }
  };

  if (status?.state === "ready") {
    return <a className="button" href={captionedUrl(file)} title="Download a copy with the detection captions drawn into the video">Download with captions</a>;
  }
  return (
    <>
      <button onClick={start} disabled={disabled || working || !status}
        title={error ?? "Make a copy with the detection captions drawn into the video, to share outside the app"}>
        {working ? (status?.state === "queued" ? "Waiting…" : `Adding captions… ${status?.progress ?? 0}%`) : error ? "Retry captions" : "With captions"}
      </button>
      {error && <span className="error-text">{error}</span>}
    </>
  );
}
