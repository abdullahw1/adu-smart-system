import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { RECORDINGS_DIR, captionsFile } from '@/lib/recorder';
const exec = promisify(execFile);

// "Download with captions": a copy of a recording with the saved detection
// boxes and captions drawn into the picture, for sharing outside the app.
// The original clip is never touched. Copies are made one at a time, on
// request, at low CPU priority, and kept next to the clip until it's deleted.

export const captionedFile = (file: string) => file.replace(/\.mp4$/, '.captioned.mp4');
export type CaptionedState = { state: 'none' | 'queued' | 'rendering' | 'ready' | 'error'; progress?: number; error?: string };

type Frame = { t: number; objects: { label: string; caption: string; box: number[] }[] };

// ASS colours are &HBBGGRR. Same palette as the live overlay (globals.css).
const COLORS: Record<string, string> = { person: '&H0AD6FF&' };
for (const v of ['car', 'motorcycle', 'bicycle', 'bus', 'truck']) COLORS[v] = '&HFFD264&';
const OTHER = '&HF25ABF&';

const assTime = (ms: number) => {
  const cs = Math.max(0, Math.round(ms / 10));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
};
// Caption text comes from our own detector, but keep ASS override syntax out.
const assText = (s: string) => s.replace(/[{}\\]/g, ' ').replace(/[\r\n]+/g, ' ').slice(0, 120);

// Builds an ASS subtitle script that draws each caption frame's boxes and
// labels from its time until the next frame (the last until `durationMs`).
export function captionsToAss(frames: Frame[], width: number, height: number, durationMs: number): string {
  const line = Math.max(2, Math.round(height / 360)); // ~2px at 720p, 4px at 1440p
  const font = Math.round(height / 40);               // ~36px at 1440p
  const out = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Box,DejaVu Sans,${font},&HFF000000,&HFF000000,&H000AD6FF,&HFF000000,0,0,0,0,100,100,0,0,1,${line},0,7,0,0,0,1`,
    // BorderStyle 3 = opaque box behind the text (the coloured label).
    `Style: Label,DejaVu Sans,${font},&H00000000,&H00000000,&H000AD6FF,&HFF000000,1,0,0,0,100,100,0,0,3,${Math.round(font / 5)},0,1,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const sorted = frames.filter((f) => Number.isFinite(f.t) && Array.isArray(f.objects)).sort((a, b) => a.t - b.t);
  sorted.forEach((frame, i) => {
    const start = frame.t, end = i + 1 < sorted.length ? sorted[i + 1].t : Math.max(durationMs, start + 1000);
    if (end <= start) return;
    for (const o of frame.objects) {
      if (!Array.isArray(o.box) || o.box.length !== 4 || !o.box.every(Number.isFinite)) continue;
      const [l, t, w, h] = o.box.map((v) => Math.min(1, Math.max(0, v)));
      const x = Math.round(l * width), y = Math.round(t * height), bw = Math.round(w * width), bh = Math.round(h * height);
      const c = COLORS[o.label] || OTHER;
      const when = `${assTime(start)},${assTime(end)}`;
      out.push(`Dialogue: 0,${when},Box,,0,0,0,,{\\pos(${x},${y})\\3c${c}\\p1}m 0 0 l ${bw} 0 l ${bw} ${bh} l 0 ${bh}{\\p0}`);
      if (!o.caption) continue;
      // Above the box, or inside its top edge when the box touches the top.
      const inside = t < 0.08;
      const pad = Math.round(font / 5);
      const pos = inside ? `\\an7\\pos(${x + pad},${y + pad})` : `\\an1\\pos(${x + pad},${y - pad - line})`;
      out.push(`Dialogue: 1,${when},Label,,0,0,0,,{${pos}\\3c${c}}${assText(o.caption)}`);
    }
  });
  return out.join('\n') + '\n';
}

export function parseCaptions(text: string): Frame[] {
  return text.split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
}

// Recordings start with a stale keyframe from go2rtc's buffer, stamped some
// time (0.4–4 s seen) before the live frames that follow it, although they
// arrive together. Captions are timed from that first frame's arrival, so
// they belong at `t + offset` on the video's timeline.
export function startGapMs(pts: number[]): number {
  const s = pts.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 3) return 0;
  const gap = s[1] - s[0], frame = s[2] - s[1];
  return gap > frame * 2 && gap < 30 ? Math.round((gap - frame) * 1000) : 0;
}
const offsets = new Map<string, number>();
export async function captionOffsetMs(full: string, ffprobe = process.env.FFPROBE_PATH || 'ffprobe'): Promise<number> {
  const cached = offsets.get(full);
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await exec(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#4', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', full], { timeout: 10000 });
    const pts = stdout.split('\n').map((l) => parseFloat(l)).filter(Number.isFinite);
    if (pts.length < 3) return 0; // clip just started: try again next time
    const offset = startGapMs(pts);
    if (offsets.size > 500) offsets.clear();
    offsets.set(full, offset);
    return offset;
  } catch { return 0; }
}

// The saved captions, moved onto the video's timeline.
export async function loadCaptions(directory: string, file: string, ffprobe?: string): Promise<Frame[]> {
  let text: string;
  try { text = await readFile(path.join(directory, captionsFile(file)), 'utf8'); } catch { return []; }
  const frames = parseCaptions(text).filter((f) => typeof f?.t === 'number' && Array.isArray(f.objects));
  if (!frames.length) return frames;
  const offset = await captionOffsetMs(path.join(directory, file), ffprobe);
  return frames.map((f) => ({ ...f, t: f.t + offset }));
}
export const forgetOffset = (full: string) => offsets.delete(full);

type Job = CaptionedState & { promise?: Promise<void>; proc?: ChildProcess };
type Options = { directory: string; ffmpeg: string; ffprobe: string; timeoutMs: number };

export class CaptionRenderer {
  private jobs = new Map<string, Job>();
  private queue: Promise<void> = Promise.resolve();
  readonly options: Options;
  constructor(options: Partial<Options> = {}) {
    this.options = { directory: RECORDINGS_DIR, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe', timeoutMs: 3 * 3600_000, ...options };
  }
  private p(name: string) { return path.join(this.options.directory, name); }

  async status(file: string): Promise<CaptionedState> {
    const job = this.jobs.get(file);
    if (job && job.state !== 'ready') return { state: job.state, progress: job.progress, error: job.error };
    try { if ((await lstat(this.p(captionedFile(file)))).isFile()) return { state: 'ready' }; } catch { /* not made yet */ }
    return { state: 'none' };
  }

  // Starts (or joins) making the copy; resolves once it's queued.
  async request(file: string): Promise<CaptionedState> {
    const current = await this.status(file);
    if (current.state === 'ready' || current.state === 'queued' || current.state === 'rendering') return current;
    const job: Job = { state: 'queued' };
    this.jobs.set(file, job);
    // One at a time: each copy is a full re-encode on a 4-core mini PC.
    job.promise = this.queue = this.queue.then(() => this.render(file, job)).catch((error) => {
      job.state = 'error'; job.error = (error as Error).message;
    });
    return { state: job.state };
  }

  async remove(file: string) {
    this.jobs.get(file)?.proc?.kill('SIGKILL');
    this.jobs.delete(file);
    await unlink(this.p(captionedFile(file))).catch(() => {});
  }

  private async render(file: string, job: Job) {
    if (this.jobs.get(file) !== job) return; // deleted while queued
    job.state = 'rendering'; job.progress = 0;
    const src = this.p(file), out = this.p(captionedFile(file));
    const part = out + '.part', ass = this.p(file.replace(/\.mp4$/, '.captioned.ass'));
    const { stdout } = await exec(this.options.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', src], { timeout: 20000 })
      .catch(() => { throw new Error('Could not read the recording'); });
    const info = JSON.parse(stdout);
    const width = Number(info.streams?.[0]?.width), height = Number(info.streams?.[0]?.height), duration = Number(info.format?.duration) * 1000;
    if (!(width > 0 && height > 0)) throw new Error('Could not read the recording');
    const frames = await loadCaptions(this.options.directory, file, this.options.ffprobe);
    if (!frames.length) throw new Error('This recording has no captions');
    await writeFile(ass, captionsToAss(frames, width, height, duration || 0), { mode: 0o600 });
    try {
      // The ASS path is inside a filter argument: escape it for the filtergraph.
      const assArg = ass.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
      const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', src,
        '-map', '0:v:0', '-map', '0:a:0?', '-vf', `ass='${assArg}'`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
        '-movflags', '+faststart', '-f', 'mp4', part];
      await new Promise<void>((resolve, reject) => {
        const proc = job.proc = spawn(this.options.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        try { if (proc.pid) setPriority(proc.pid, 15); } catch { /* best effort: keep live video smooth */ }
        const timer = setTimeout(() => proc.kill('SIGKILL'), this.options.timeoutMs);
        let err = '';
        proc.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-2000); });
        proc.stdout.on('data', (c: Buffer) => {
          const m = /out_time_us=(\d+)\s*$/m.exec(String(c).split('\n').filter((l) => l.startsWith('out_time_us=')).pop() || '');
          if (m && duration > 0) job.progress = Math.min(99, Math.floor(Number(m[1]) / 1000 / duration * 100));
        });
        proc.once('error', () => { clearTimeout(timer); reject(new Error('ffmpeg is not available')); });
        proc.once('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else { if (err) console.error('[captioned]', file, err.trim().split('\n').pop()); reject(new Error('Making the captioned copy failed')); }
        });
      });
      job.proc = undefined;
      if (this.jobs.get(file) !== job) return; // deleted meanwhile (finally removes the part file)
      await rename(part, out);
      job.state = 'ready'; job.progress = 100;
      this.jobs.delete(file);
    } finally {
      await unlink(ass).catch(() => {});
      await unlink(part).catch(() => {});
    }
  }
}

const state = globalThis as typeof globalThis & { __aduCaptioned?: CaptionRenderer };
const renderer = state.__aduCaptioned ??= new CaptionRenderer();
export const captionedStatus = (file: string) => renderer.status(file);
export const requestCaptioned = (file: string) => renderer.request(file);
export const removeCaptioned = (file: string) => renderer.remove(file);
