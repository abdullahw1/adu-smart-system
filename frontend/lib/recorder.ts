// Server-only. On-demand recording until the edge server's HDD arrives and
// Frigate takes over 24/7 recording. ffmpeg pulls the camera from go2rtc's RTSP
// restream (never from the camera directly) and copies the video as-is into an
// MP4 on this machine's disk.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ?? path.join(process.cwd(), "data", "recordings");
const GO2RTC_RTSP = (process.env.GO2RTC_RTSP_URL ?? "rtsp://127.0.0.1:8554").replace(/\/+$/, "");
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

// Someone will forget to press Stop. Cap each recording so it can't fill the disk.
const MAX_DURATION_MS = 60 * 60_000;

export const CAMERA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const FILE_RE = /^[A-Za-z0-9_-]{1,128}\.mp4$/;

export type ActiveRecording = { file: string; startedAt: number };
export type RecordingFile = { file: string; camera: string; size: number; createdAt: number };

type Session = ActiveRecording & { proc: ChildProcess; timer: ReturnType<typeof setTimeout> };

// Kept on globalThis so dev-mode hot reloads don't orphan running ffmpegs.
const g = globalThis as typeof globalThis & { __recordings?: Map<string, Session> };
const sessions = (g.__recordings ??= new Map());

export function activeRecordings(): Record<string, ActiveRecording> {
  return Object.fromEntries(
    [...sessions].map(([id, { file, startedAt }]) => [id, { file, startedAt }]),
  );
}

export async function startRecording(id: string): Promise<ActiveRecording> {
  const existing = sessions.get(id);
  if (existing) return { file: existing.file, startedAt: existing.startedAt };

  const src = `${GO2RTC_RTSP}/${id}`;
  const codec = await probeVideoCodec(src);
  await mkdir(RECORDINGS_DIR, { recursive: true });

  const startedAt = Date.now();
  const file = `${id}_${timestamp(new Date(startedAt))}.mp4`;
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy",
    // hvc1 (not hev1) so Safari/QuickTime will play H.265 files.
    ...(codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    // Camera audio is G.711, which MP4 can't hold.
    "-c:a", "aac", "-b:a", "64k",
    // Fragmented MP4: the file stays playable even if the server dies mid-recording.
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    path.join(RECORDINGS_DIR, file),
  ];

  const proc = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
  proc.stderr?.on("data", (d) => console.error(`[record ${id}] ${String(d).trim()}`));

  await new Promise<void>((resolve, reject) => {
    proc.once("spawn", resolve);
    proc.once("error", (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === "ENOENT" ? "ffmpeg is not installed on the server" : err.message)),
    );
  });

  const timer = setTimeout(() => stopRecording(id), MAX_DURATION_MS);
  sessions.set(id, { file, startedAt, proc, timer });
  proc.once("exit", () => {
    clearTimeout(timer);
    if (sessions.get(id)?.proc === proc) sessions.delete(id);
  });

  return { file, startedAt };
}

export async function stopRecording(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.timer);

  const { proc } = session;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.stdin?.end("q"); // ask ffmpeg to finish the current fragment and exit
  const forceKill = setTimeout(() => proc.kill("SIGTERM"), 5_000);
  await exited;
  clearTimeout(forceKill);
}

export async function listRecordings(): Promise<RecordingFile[]> {
  let names: string[];
  try {
    names = await readdir(RECORDINGS_DIR);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((name) => FILE_RE.test(name))
      .map(async (file) => {
        const s = await stat(path.join(RECORDINGS_DIR, file));
        return {
          file,
          camera: file.replace(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/, ""),
          size: s.size,
          createdAt: s.birthtimeMs || s.mtimeMs,
        };
      }),
  );
  return files.sort((a, b) => b.createdAt - a.createdAt);
}

// Also confirms the stream is reachable before we start writing a file.
function probeVideoCodec(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE,
      ["-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
       "-show_entries", "stream=codec_name", "-of", "csv=p=0", src],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
          return reject(new Error(missing ? "ffprobe is not installed on the server" : "Camera stream unavailable"));
        }
        resolve(stdout.trim());
      },
    );
  });
}

// Local time, filename-safe: 2026-10-25_17-51-03
function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
