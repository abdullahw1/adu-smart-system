import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Recorder } from '../lib/recorder';
const dir = await mkdtemp(path.join(os.tmpdir(), 'adu-recorder-'));
const probe = path.join(dir, 'probe'), ffmpeg = path.join(dir, 'ffmpeg'), counter = path.join(dir, 'spawns');
await writeFile(probe, '#!' + process.execPath + '\nsetTimeout(() => console.log("h264"), 50);\n');
await writeFile(ffmpeg, '#!' + process.execPath + '\nconst fs=require("node:fs");fs.appendFileSync(' + JSON.stringify(counter) + ',"start\\n");fs.writeFileSync(process.argv.at(-1),"fake video");setTimeout(()=>console.log("frame=1"),100);process.stdin.on("data",()=>process.exit(0));setInterval(()=>{},1000);\n');
await chmod(probe, 0o700); await chmod(ffmpeg, 0o700);
const recorder = new Recorder({ directory: path.join(dir, 'clips'), ffprobe: probe, ffmpeg, minFreeBytes: 1, allowed: async id => id === 'cam_01' });
after(async () => { await recorder.stop('cam_01'); await rm(dir, { recursive: true, force: true }); });
test('concurrent starts launch exactly one process and stop keeps file busy until exit', async () => {
  const [a, b] = await Promise.all([recorder.start('cam_01'), recorder.start('cam_01')]);
  assert.equal(a.file, b.file);
  assert.equal((await readFile(counter, 'utf8')).trim(), 'start');
  assert.equal(Object.keys(recorder.active()).length, 1);
  const stopping = recorder.stop('cam_01');
  assert.equal(recorder.busy(a.file), true);
  await stopping; assert.equal(recorder.busy(a.file), false);
  assert.equal(Object.keys(recorder.active()).length, 0);
});
test('storage limits and unconfigured cameras fail before recording', async () => {
  const full = new Recorder({ directory: path.join(dir, 'clips'), minFreeBytes: Number.MAX_SAFE_INTEGER, allowed: async () => true });
  await assert.rejects(full.start('cam_01'), /disk space/);
  await assert.rejects(recorder.start('unknown'), /Unknown camera/);
});
test('an encoder that exits early is never reported as recording', async () => {
  const failing = path.join(dir, 'bad-ffmpeg');
  await writeFile(failing, '#!' + process.execPath + '\nprocess.exit(1);\n'); await chmod(failing, 0o700);
  const broken = new Recorder({ directory: path.join(dir, 'clips'), ffprobe: probe, ffmpeg: failing, minFreeBytes: 1, allowed: async () => true });
  await assert.rejects(broken.start('cam_01'), /before receiving video/);
  assert.deepEqual(broken.active(), {});
});
