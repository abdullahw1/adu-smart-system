import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordCaptions, captionsFile, type CaptionObject } from '../lib/recorder';
import { framesAt, type CaptionFrame } from '../lib/recordings';

const person = (caption: string, box = [0.3, 0.1, 0.1, 0.4]): CaptionObject => ({ id: 'p1', label: 'person', caption, score: 0.9, box });

test('captions sidecar records only changes for the recorded camera, timed from the first frame', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'captions-'));
  try {
    let listener: (s: Record<string, CaptionObject[]>) => void = () => {};
    let unsubscribed = false;
    const feed = { current: () => ({ cam_02: [person('Person')] }), subscribe: (fn: typeof listener) => { listener = fn; return () => { unsubscribed = true; }; } };
    const target = path.join(dir, captionsFile('cam_02_2026-11-23_21-00-00_x.mp4'));
    assert.match(target, /cam_02_2026-11-23_21-00-00_x\.captions\.jsonl$/);
    const t0 = Date.now() - 1000;
    const stop = recordCaptions(feed, 'cam_02', target, t0);
    listener({ cam_02: [person('Person')], cam_01: [person('Car driving past')] }); // no change for cam_02
    listener({ cam_02: [person('Person walking toward camera')] });
    listener({ cam_01: [person('Car')] }); // cam_02 now empty
    stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unsubscribed, true);
    const lines = (await readFile(target, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.objects.map((o: CaptionObject) => o.caption)), [['Person'], ['Person walking toward camera'], []]);
    assert.ok(lines.every((l) => l.t >= 1000 && l.t < 5000));
    assert.ok(lines.every((l) => l.objects.every((o: object) => !('score' in o))));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without a detection feed, recording captions is a no-op', () => {
  assert.doesNotThrow(() => recordCaptions(undefined, 'cam_02', '/nonexistent/x.captions.jsonl')());
});

test('playback shows the last caption frame at or before the playhead', () => {
  const frames: CaptionFrame[] = [
    { t: 0, objects: [] },
    { t: 1000, objects: [{ id: 'a', label: 'person', caption: 'Person', box: [0, 0, 0.1, 0.1] }] },
    { t: 3000, objects: [] },
  ];
  assert.deepEqual(framesAt([], 500), []);
  assert.equal(framesAt(frames, 999).length, 0);
  assert.equal(framesAt(frames, 1000)[0].caption, 'Person');
  assert.equal(framesAt(frames, 2999)[0].caption, 'Person');
  assert.equal(framesAt(frames, 1500), framesAt(frames, 2500)); // same array: no re-render
  assert.equal(framesAt(frames, 10_000).length, 0);
});
