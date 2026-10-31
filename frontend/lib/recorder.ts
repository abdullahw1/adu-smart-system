import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, lstat, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { cameras } from '@/server/cameras.mjs';
import { withCameraLock } from '@/lib/serial';
const exec = promisify(execFile);
export const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'data', 'recordings');
export const CAMERA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const FILE_RE = /^[A-Za-z0-9_-]{1,160}\.mp4$/;
export type ActiveRecording = { file: string; startedAt: number };
export type RecordingFile = { file: string; camera: string; size: number; createdAt: number };
type Session = ActiveRecording & { proc: ChildProcess; ready: boolean; stopping?: boolean; exited: Promise<void>; timer?: ReturnType<typeof setInterval> };
type Options = { directory: string; ffmpeg: string; ffprobe: string; rtsp: string; minFreeBytes: number; maxTotalBytes: number; requireMount: boolean; maxDurationSeconds: number; allowed: (id: string) => Promise<boolean> };

export class Recorder {
  private sessions = new Map<string, Session>();
  readonly errors: Record<string, string> = {};
  readonly options: Options;
  constructor(options: Partial<Options> = {}) {
    this.options = {
      directory: RECORDINGS_DIR, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
      rtsp: (process.env.GO2RTC_RTSP_URL || 'rtsp://127.0.0.1:8554').replace(/\/+$/, ''),
      minFreeBytes: Number(process.env.RECORDING_MIN_FREE_BYTES || 1024 ** 3),
      maxTotalBytes: Number(process.env.RECORDING_MAX_BYTES || 100 * 1024 ** 3),
      requireMount: process.env.REQUIRE_RECORDING_MOUNT === '1', maxDurationSeconds: 3600,
      allowed: async id => (await cameras()).some(camera => camera.id === id), ...options,
    };
    for (const value of [this.options.minFreeBytes, this.options.maxTotalBytes, this.options.maxDurationSeconds]) if (!Number.isFinite(value) || value <= 0) throw new Error('Recording limits must be positive numbers');
  }
  active(): Record<string, ActiveRecording> {
    return Object.fromEntries([...this.sessions].filter(([, s]) => s.ready).map(([id, { file, startedAt }]) => [id, { file, startedAt }]));
  }
  busy(file: string) { return [...this.sessions.values()].some(session => session.file === file); }
  async files(): Promise<RecordingFile[]> {
    let names: string[];
    try { names = await readdir(this.options.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const files = await Promise.all(names.filter(file => FILE_RE.test(file)).map(async file => {
      try {
        const s = await lstat(path.join(this.options.directory, file));
        if (!s.isFile()) return null;
        return { file, camera: file.replace(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_[a-f0-9-]+)?\.mp4$/, ''), size: s.size, createdAt: s.birthtimeMs || s.mtimeMs };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
    return files.filter((file): file is RecordingFile => Boolean(file)).sort((a, b) => b.createdAt - a.createdAt);
  }
  async storage() {
    if (this.options.requireMount) await exec('mountpoint', ['-q', this.options.directory], { timeout: 3000 }).catch(() => { throw new Error('Recording drive is not mounted'); });
    await mkdir(this.options.directory, { recursive: true });
    const [s, files] = await Promise.all([statfs(this.options.directory), this.files()]);
    return { availableBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize, recordingBytes: files.reduce((sum, file) => sum + file.size, 0), limitBytes: this.options.maxTotalBytes };
  }
  private async checkStorage() {
    const s = await this.storage();
    if (s.availableBytes < this.options.minFreeBytes) throw new Error('Recording stopped: disk space is low');
    if (s.recordingBytes >= this.options.maxTotalBytes) throw new Error('Recording stopped: clip storage limit reached');
  }
  start(id: string) {
    return withCameraLock('record:' + id, async () => {
      if (!CAMERA_ID_RE.test(id) || !await this.options.allowed(id)) throw new Error('Unknown camera');
      const existing = this.sessions.get(id);
      if (existing) return { file: existing.file, startedAt: existing.startedAt };
      await this.checkStorage();
      const src = this.options.rtsp + '/' + id;
      const { stdout } = await exec(this.options.ffprobe, ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src], { timeout: 10000 }).catch(() => { throw new Error('Camera stream unavailable or ffprobe is not installed'); });
      const startedAt = Date.now();
      const stamp = new Date(startedAt).toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
      const file = `${id}_${stamp}_${randomUUID()}.mp4`;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', ...(stdout.trim() === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-c:a', 'aac', '-b:a', '64k', '-t', String(this.options.maxDurationSeconds), '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', path.join(this.options.directory, file)];
      const proc = spawn(this.options.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let resolveExit!: () => void;
      const exited = new Promise<void>(resolve => { resolveExit = resolve; });
      const session: Session = { file, startedAt, proc, ready: false, exited };
      this.sessions.set(id, session);
      const finish = () => {
        const naturalEnd = proc.exitCode === 0 && Date.now() - startedAt >= (this.options.maxDurationSeconds - 1) * 1000;
        if (session.ready && !session.stopping && !naturalEnd) this.errors[id] = 'Recorder stopped unexpectedly; check the camera and storage';
        clearInterval(session.timer); resolveExit();
        if (this.sessions.get(id) === session) this.sessions.delete(id);
      };
      proc.once('exit', finish); proc.once('error', finish);
      proc.stdin?.on('error', () => {});
      // Do not return camera URLs or FFmpeg diagnostics to clients.
      proc.stderr?.resume();
      try {
        await new Promise<void>((resolve, reject) => {
          let text = '';
          const timeout = setTimeout(() => reject(new Error('No recording frames received')), 12000);
          const fail = () => { cleanup(); reject(new Error('Recorder exited before receiving video')); };
          const progress = (chunk: Buffer) => {
            text = (text + chunk.toString()).slice(-8192);
            if (/frame=\s*[1-9]\d*/.test(text)) { cleanup(); resolve(); }
          };
          const cleanup = () => { clearTimeout(timeout); proc.stdout?.off('data', progress); proc.off('exit', fail); proc.off('error', fail); };
          proc.stdout?.on('data', progress); proc.once('exit', fail); proc.once('error', fail);
        });
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error('Recorder stopped during startup');
        proc.stdout?.resume(); session.ready = true; delete this.errors[id];
        let checking = false;
        session.timer = setInterval(async () => {
          if (checking) return; checking = true;
          try { await this.checkStorage(); }
          catch (error) { this.errors[id] = (error as Error).message; void this.stop(id).catch(() => {}); }
          finally { checking = false; }
        }, 5000);
        return { file, startedAt };
      } catch (error) {
        this.errors[id] = (error as Error).message;
        await this.terminate(session);
        throw error;
      }
    });
  }
  private async terminate(session: Session) {
    session.stopping = true;
    if (session.proc.exitCode !== null || session.proc.signalCode !== null) return;
    session.proc.stdin?.end('q');
    const term = setTimeout(() => session.proc.kill('SIGTERM'), 3000);
    const kill = setTimeout(() => session.proc.kill('SIGKILL'), 5000);
    try { await session.exited; } finally { clearTimeout(term); clearTimeout(kill); }
  }
  async shutdown() { await Promise.all([...this.sessions.keys()].map(id => this.stop(id))); }
  stop(id: string) { return withCameraLock('record:' + id, async () => { const session = this.sessions.get(id); if (session) await this.terminate(session); }); }
}
const state = globalThis as typeof globalThis & { __aduRecorder?: Recorder };
const recorder = state.__aduRecorder ??= new Recorder();
export const activeRecordings = () => recorder.active();
export const startRecording = (id: string) => recorder.start(id);
export const stopRecording = (id: string) => recorder.stop(id);
export const listRecordings = () => recorder.files();
export const recordingBusy = (file: string) => recorder.busy(file);
export const recordingErrors = () => recorder.errors;
export const storageStatus = () => recorder.storage();
