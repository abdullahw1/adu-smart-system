import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, movement, DetectionTracker } from '../server/detections.mjs';

const event = (type: string, box: number[], extra: Record<string, unknown> = {}) => ({
  type, after: { id: 'p1', camera: 'cam_02', label: 'person', score: 0.8, box, stationary: false, current_zones: [], ...extra },
});

test('movement reads depth from box height and sideways motion from the centre', () => {
  const at = (t: number, box: number[]) => ({ t, box });
  // Real cam_02 boxes: 108px tall growing to 128px is someone approaching.
  assert.equal(movement([at(0, [201, 0, 250, 108]), at(1, [230, 0, 277, 128])]), 'toward');
  assert.equal(movement([at(0, [221, 3, 272, 123]), at(1, [219, 3, 254, 88])]), 'away');
  assert.equal(movement([at(0, [100, 50, 140, 150]), at(1, [200, 50, 240, 150])]), 'across');
  assert.equal(movement([at(0, [100, 50, 140, 150]), at(1, [102, 50, 142, 152])]), 'still');
  assert.equal(movement([at(0, [100, 50, 140, 150])]), 'unknown');
});

test('captions name the object, its movement and a door zone', () => {
  const toward = [{ t: 0, box: [0, 0, 50, 100] }, { t: 1, box: [0, 0, 60, 130] }];
  assert.equal(describe({ label: 'person', history: toward }), 'Person walking toward camera');
  assert.equal(describe({ label: 'person', history: toward, zones: ['front_door'] }), 'Person walking toward door');
  assert.equal(describe({ label: 'person', stationary: true, zones: ['front_door'] }), 'Person at the door');
  assert.equal(describe({ label: 'car', history: [{ t: 0, box: [0, 100, 80, 150] }, { t: 1, box: [200, 100, 280, 150] }] }), 'Car driving past');
  assert.equal(describe({ label: 'car', stationary: true }), 'Parked car');
  assert.equal(describe({ label: 'suitcase', stationary: true }), 'Package or bag left here');
  assert.equal(describe({ label: 'dog' }), 'Dog');
});

test('tracker follows an object from new to end and exposes only fractional boxes', () => {
  const tracker = new DetectionTracker({ cam_02: { width: 640, height: 360 } });
  assert.equal(tracker.apply(event('new', [201, 0, 250, 108]), 0), true);
  tracker.apply(event('update', [230, 0, 277, 128]), 1000);
  const [obj] = tracker.snapshot().cam_02;
  assert.equal(obj.caption, 'Person walking toward camera');
  assert.deepEqual(obj.box, [0.3594, 0, 0.0734, 0.3556]);
  assert.deepEqual(Object.keys(obj).sort(), ['box', 'caption', 'id', 'label', 'score']);
  tracker.apply(event('end', [230, 0, 277, 128]), 2000);
  assert.deepEqual(tracker.snapshot(), {});
});

test('tracker ignores malformed messages and drops objects that never ended', () => {
  const tracker = new DetectionTracker();
  assert.equal(tracker.apply({ type: 'new' }), false);
  assert.equal(tracker.apply({ type: 'new', after: { id: 1, camera: 'x', box: [] } }), false);
  tracker.apply(event('new', [0, 0, 10, 10]), 0);
  assert.equal(tracker.prune(10_000), false);
  assert.equal(tracker.prune(31_000), true);
  assert.deepEqual(tracker.snapshot(), {});
});
