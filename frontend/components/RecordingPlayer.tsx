"use client";
import { useEffect, useRef, useState } from "react";
import { DetectionBoxes } from "@/components/DetectionOverlay";
import { fetchCaptions, framesAt, recordingUrl, type CaptionFrame } from "@/lib/recordings";

// Plays a recording with the detection boxes and captions that were live
// while it was recorded (saved next to the clip; see lib/recorder.ts).
export function RecordingPlayer({ file }: { file: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [frames, setFrames] = useState<CaptionFrame[]>([]);
  const [shown, setShown] = useState<CaptionFrame["objects"]>([]);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => { fetchCaptions(file).then(setFrames).catch(() => setFrames([])); }, [file]);

  // Follow the playhead each animation frame; cheap (binary search).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) setShown((prev) => { const next = framesAt(frames, v.currentTime * 1000); return next === prev ? prev : next; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frames]);

  return (
    <div className="recording-player">
      <div className="video-stage recording-stage">
        <video ref={video} className="recording-video" src={recordingUrl(file)} controls autoPlay />
        {enabled && <DetectionBoxes objects={shown} />}
      </div>
      {frames.length > 0 && (
        <label className="captions-toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Show detection captions
        </label>
      )}
    </div>
  );
}
