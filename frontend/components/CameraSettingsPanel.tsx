"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LivePlayer } from "@/components/LivePlayer";
import { fetchCameraNames } from "@/lib/cameraNames";
import {
  TIME_ZONES,
  fetchCameraSettings,
  formatCameraClock,
  updateCameraSettings,
  type CameraSettings,
  type DayNight,
  type SettingsPatch,
} from "@/lib/cameraSettings";
import { fetchCameras, go2rtcBase } from "@/lib/go2rtc";

type Save = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "error"; message: string };

const LEVELS = [
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Color" },
  { key: "sharpness", label: "Sharpness" },
] as const;

const IMAGE_DEFAULTS: CameraSettings["image"] = {
  brightness: 128,
  contrast: 128,
  saturation: 128,
  sharpness: 128,
  dayNight: "auto",
  wdr: false,
  backlight: false,
};

export function CameraSettingsPanel({ id }: { id: string }) {
  const [base, setBase] = useState<string | null>(null);
  const [label, setLabel] = useState(id);
  const [settings, setSettings] = useState<CameraSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSettings(await fetchCameraSettings(id));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setBase(go2rtcBase());
    fetchCameraNames().then((names) => names[id] && setLabel(names[id]));
    load();
  }, [id, load]);

  return (
    <div className="settings">
      <div className="settings-head">
        <Link href="/" className="muted-link">
          ← Live
        </Link>
        <h1>{label} settings</h1>
        {settings && (
          <span className="muted">
            {settings.info.model} · firmware {settings.info.firmware}
          </span>
        )}
      </div>

      {base && (
        <div className="settings-preview">
          <LivePlayer base={base} src={`${id}_sub`} />
        </div>
      )}

      {loadError && (
        <div className="notice">
          <p>{loadError}</p>
          <button onClick={load}>Retry</button>
        </div>
      )}
      {!settings && !loadError && <p className="notice">Reading camera settings…</p>}
      {settings && (
        <>
          <TimeSection id={id} base={base} settings={settings} onSaved={setSettings} />
          <ImageSection id={id} settings={settings} onSaved={setSettings} />
        </>
      )}
    </div>
  );
}

function TimeSection({
  id,
  base,
  settings,
  onSaved,
}: {
  id: string;
  base: string | null;
  settings: CameraSettings;
  onSaved: (s: CameraSettings) => void;
}) {
  const { time } = settings;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = TIME_ZONES.some((z) => z.zone === browserZone)
    ? TIME_ZONES
    : [...TIME_ZONES, { zone: browserZone, label: browserZone }];

  const [zone, setZone] = useState(time.zone ?? browserZone);
  const [mode, setMode] = useState(time.mode);
  const [ntpServer, setNtpServer] = useState(time.ntpServer);
  const [save, setSave] = useState<Save>({ state: "idle" });
  const [allResult, setAllResult] = useState<string | null>(null);

  const patch = (): SettingsPatch => ({ time: { zone, mode, ntpServer } });

  const apply = async () => {
    setSave({ state: "saving" });
    setAllResult(null);
    try {
      onSaved(await updateCameraSettings(id, patch()));
      setSave({ state: "saved" });
    } catch (err) {
      setSave({ state: "error", message: (err as Error).message });
    }
  };

  const applyAll = async () => {
    if (!base) return;
    setSave({ state: "saving" });
    setAllResult(null);
    try {
      const cameras = await fetchCameras(base);
      const failed: string[] = [];
      for (const cam of cameras) {
        try {
          const result = await updateCameraSettings(cam.id, patch());
          if (cam.id === id) onSaved(result);
        } catch {
          failed.push(cam.label);
        }
      }
      setSave({ state: "idle" });
      setAllResult(
        failed.length
          ? `Updated ${cameras.length - failed.length} of ${cameras.length}. Failed: ${failed.join(", ")}`
          : `All ${cameras.length} cameras updated`,
      );
    } catch (err) {
      setSave({ state: "error", message: (err as Error).message });
    }
  };

  return (
    <section className="settings-card">
      <h2>Date &amp; time</h2>
      <p className="clock">
        {time.utc && time.offsetMinutes !== null ? formatCameraClock(time.utc, time.offsetMinutes) : "Unknown"}
        {time.needsSync ? (
          <span className="pill pill-warn">Wrong. Apply to fix</span>
        ) : (
          <span className="pill pill-ok">Correct</span>
        )}
      </p>

      <label className="field">
        <span>Time zone</span>
        <select value={zone} onChange={(e) => setZone(e.target.value)}>
          {zones.map((z) => (
            <option key={z.zone} value={z.zone}>
              {z.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Keep time with</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as "manual" | "ntp")}>
          <option value="manual">This computer&apos;s clock (set once)</option>
          <option value="ntp">Time server (NTP)</option>
        </select>
      </label>
      {mode === "ntp" && (
        <label className="field">
          <span>Time server</span>
          <input value={ntpServer} onChange={(e) => setNtpServer(e.target.value)} placeholder="pool.ntp.org" />
        </label>
      )}

      <p className="hint">
        These cameras can&apos;t follow daylight saving on their own. When the clocks change, this page
        shows &ldquo;Wrong&rdquo;; press Apply again.
      </p>

      <div className="actions">
        <button onClick={apply} disabled={save.state === "saving"}>
          Apply
        </button>
        <button onClick={applyAll} disabled={save.state === "saving" || !base}>
          Apply to all cameras
        </button>
        <SaveStatus save={save} />
        {allResult && <span className="muted">{allResult}</span>}
      </div>
    </section>
  );
}

function ImageSection({
  id,
  settings,
  onSaved,
}: {
  id: string;
  settings: CameraSettings;
  onSaved: (s: CameraSettings) => void;
}) {
  const [image, setImage] = useState(settings.image);
  const [flip, setFlip] = useState(settings.flip);
  const [save, setSave] = useState<Save>({ state: "idle" });
  const pending = useRef<SettingsPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Sliders fire on every pixel of movement; batch changes and send once the
  // user pauses so the camera isn't flooded.
  const queue = (patch: SettingsPatch, delayMs = 400) => {
    pending.current = {
      ...pending.current,
      ...patch,
      image: { ...pending.current.image, ...patch.image },
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  };

  const flush = async () => {
    const patch = pending.current;
    pending.current = {};
    if (patch.image && Object.keys(patch.image).length === 0) delete patch.image;
    if (!patch.image && patch.flip === undefined) return;
    setSave({ state: "saving" });
    try {
      onSaved(await updateCameraSettings(id, patch));
      setSave({ state: "saved" });
    } catch (err) {
      setSave({ state: "error", message: (err as Error).message });
      setImage(settings.image);
      setFlip(settings.flip);
    }
  };

  const setLevel = (key: (typeof LEVELS)[number]["key"], value: number) => {
    setImage((i) => ({ ...i, [key]: value }));
    queue({ image: { [key]: value } });
  };

  const setNow = (patch: Partial<CameraSettings["image"]>) => {
    setImage((i) => ({ ...i, ...patch }));
    queue({ image: patch }, 0);
  };

  return (
    <section className="settings-card">
      <h2>Image</h2>

      <label className="toggle">
        <input
          type="checkbox"
          checked={flip === true}
          onChange={(e) => {
            setFlip(e.target.checked);
            queue({ flip: e.target.checked }, 0);
          }}
        />
        <span>Flip vertically (top ↔ bottom)</span>
      </label>
      {flip === null && (
        <p className="hint">The camera doesn&apos;t report this setting, so it shows off until it&apos;s set here.</p>
      )}

      <div className="field">
        <span>Day / night</span>
        <div className="segmented" role="radiogroup" aria-label="Day / night">
          {(
            [
              ["auto", "Auto"],
              ["day", "Always color"],
              ["night", "Always night (B/W)"],
            ] as [DayNight, string][]
          ).map(([value, text]) => (
            <button
              key={value}
              role="radio"
              aria-checked={image.dayNight === value}
              className={image.dayNight === value ? "active" : ""}
              onClick={() => setNow({ dayNight: value })}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {LEVELS.map(({ key, label }) => (
        <label className="field slider" key={key}>
          <span>{label}</span>
          <input
            type="range"
            min={1}
            max={255}
            value={image[key]}
            onChange={(e) => setLevel(key, Number(e.target.value))}
          />
          <output>{image[key]}</output>
        </label>
      ))}

      <label className="toggle">
        <input type="checkbox" checked={image.wdr} onChange={(e) => setNow({ wdr: e.target.checked })} />
        <span>Wide dynamic range (bright sky and dark shade in one shot)</span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={image.backlight} onChange={(e) => setNow({ backlight: e.target.checked })} />
        <span>Backlight compensation (subject in front of a bright light)</span>
      </label>

      <div className="actions">
        <button onClick={() => setNow(IMAGE_DEFAULTS)}>Reset image to defaults</button>
        <SaveStatus save={save} />
      </div>
    </section>
  );
}

function SaveStatus({ save }: { save: Save }) {
  if (save.state === "saving") return <span className="muted">Saving…</span>;
  if (save.state === "saved") return <span className="saved">Saved</span>;
  if (save.state === "error") return <span className="error-text">{save.message}</span>;
  return null;
}
