import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameras, allowedStream } from '../server/cameras.mjs';
test('camera discovery strips upstream credentials and validates stream IDs', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ cam_01: { producers: [{ url: 'rtsp://admin:secret@private-camera/stream0' }] }, cam_01_sub: {}, '../admin': {} });
  try {
    const result = await cameras();
    assert.deepEqual(result, [{ id: 'cam_01', label: 'Cam 01', mainSrc: 'cam_01', gridSrc: 'cam_01_sub' }]);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(await allowedStream('cam_01_sub'), true);
    assert.equal(await allowedStream('../admin'), false);
    assert.equal(await allowedStream('unconfigured'), false);
  } finally { globalThis.fetch = original; }
});
