import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captionsToAss, startGapMs, loadCaptions, CaptionRenderer } from '../lib/captioned';
const exec = promisify(execFile);

const frames = [
  { t: 0, objects: [] },
  { t: 1000, objects: [{ label: 'person', caption: 'Person {at} door\\N', box: [0.25, 0.5, 0.1, 0.25] }] },
  { t: 3000, objects: [{ label: 'car', caption: 'Car', box: [0.1, 0.02, 0.2, 0.2] }] },
];

test('ASS script draws each box and caption from its frame until the next', () => {
  const ass = captionsToAss(frames, 1280, 720, 5000);
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(events.length, 4);
  assert.match(events[0], /^Dialogue: 0,0:00:01\.00,0:00:03\.00,Box,.*\\pos\(320,360\).*m 0 0 l 128 0 l 128 180 l 0 180/);
  assert.match(events[0], /\\3c&H0AD6FF&/); // person yellow
  assert.match(events[1], /\\an1\\pos\(\d+,\d+\).*\}Person  at  door N$/); // above the box, override syntax removed
  assert.match(events[3], /^Dialogue: 1,0:00:03\.00,0:00:05\.00,Label,.*\\an7.*\\3c&HFFD264&\}Car$/); // inside (top), vehicle blue, to the end
});

test('start gap: a stale first keyframe shifts captions; a normal start does not', () => {
  assert.equal(startGapMs([0, 4.008, 4.048, 4.088]), 3968);
  assert.equal(startGapMs([0, 0.408, 0.448]), 368);
  assert.equal(startGapMs([0, 0.04, 0.08, 0.12]), 0);
  assert.equal(startGapMs([0, 0.04]), 0);
});

test('renders a captioned copy, lined up with the video, and removes it', { timeout: 120000 }, async (t) => {
  try { await exec('ffmpeg', ['-version']); } catch { t.skip('ffmpeg not installed'); return; }
  const dir = await mkdtemp(path.join(tmpdir(), 'captioned-'));
  try {
    const clip = 'cam_01_2026-01-01_00-00-00_x.mp4';
    // 1 frame at 0 s, then live frames from 2 s: like go2rtc's stale keyframe.
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=10:d=4', '-vf', "setpts='if(eq(N,0),0,PTS+2/TB)'", '-c:v', 'libx264', '-g', '100', '-fps_mode', 'passthrough', path.join(dir, clip)]);
    await writeFile(path.join(dir, clip.replace('.mp4', '.captions.jsonl')), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
    const loaded = await loadCaptions(dir, clip);
    assert.equal(loaded[1].t, 3000, "shifted by the start gap");

    const r = new CaptionRenderer({ directory: dir });
    assert.equal((await r.status(clip)).state, 'none');
    await r.request(clip);
    for (let i = 0; i < 200 && !['ready', 'error'].includes((await r.status(clip)).state); i++) await new Promise((x) => setTimeout(x, 100));
    assert.deepEqual(await r.status(clip), { state: 'ready' });
    // Pixel under the person box turns yellow once the caption starts (~3 s).
    const pixel = async (s: number) => (await exec('ffmpeg', ['-v', 'error', '-ss', String(s), '-i', path.join(dir, clip.replace('.mp4', '.captioned.mp4')), '-frames:v', '1', '-vf', 'crop=10:2:75:120', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })).stdout;
    const yellow = (px: Buffer) => { for (let i = 0; i + 2 < px.length; i += 3) if (px[i] > 200 && px[i + 1] > 180 && px[i + 2] < 100) return true; return false; };
    assert.equal(yellow(await pixel(2.5)), false, 'no border before the caption starts');
    assert.equal(yellow(await pixel(3.5)), true, 'yellow border once it has');
    assert.deepEqual((await readdir(dir)).filter((n) => /\.(ass|part)$/.test(n)), []); // temp files cleaned up
    await r.remove(clip);
    assert.equal((await r.status(clip)).state, 'none');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
