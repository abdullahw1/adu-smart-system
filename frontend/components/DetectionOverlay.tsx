"use client";
import { useDetections, type LiveObject } from "@/lib/detections";

type Drawn = Pick<LiveObject, "id" | "label" | "caption"> & { box: number[] };

// Draws tracked objects over a video: a box plus a caption such as "Person
// walking toward camera". The frame wrapper matches the 16:9 video's
// letterboxed area, so fractional boxes line up with the picture.
export function DetectionBoxes({ objects, compact = false }: { objects: Drawn[]; compact?: boolean }) {
  if (objects.length === 0) return null;
  return (
    <div className="detections" aria-live="polite">
      <div className="detections-frame">
        {objects.map((o) => {
          const [left, top, width, height] = o.box;
          return (
            <div
              key={o.id}
              className={`detection detection-${o.label}${compact ? " detection-compact" : ""}`}
              style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
            >
              <span className={`detection-caption${top < 0.08 ? " detection-caption-inside" : ""}`}>{o.caption}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Live view: boxes from Frigate's current detections for this camera.
export function DetectionOverlay({ camera, compact = false }: { camera: string; compact?: boolean }) {
  return <DetectionBoxes objects={useDetections(camera)} compact={compact} />;
}
