import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTime, getSettings } from '../lib/onvif';
test('correcting the clock invalidates the cached authentication timestamp', async () => {
  let cameraTime = Date.UTC(2010, 0, 1);
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = String(init?.body);
    if (body.includes('<tds:GetSystemDateAndTime/>')) {
      const d = new Date(cameraTime);
      return new Response(`<UTCDateTime><Date><Year>${d.getUTCFullYear()}</Year><Month>${d.getUTCMonth()+1}</Month><Day>${d.getUTCDate()}</Day></Date><Time><Hour>${d.getUTCHours()}</Hour><Minute>${d.getUTCMinutes()}</Minute><Second>${d.getUTCSeconds()}</Second></Time></UTCDateTime>`);
    }
    const created = /<Created[^>]*>([^<]+)<\/Created>/.exec(body)?.[1];
    if (created && Math.abs(Date.parse(created) - cameraTime) > 60000) return new Response('<Fault>NotAuthorized</Fault>', { status: 401 });
    if (body.includes('<tds:SetSystemDateAndTime>')) cameraTime = Date.now();
    return new Response('<SourceToken>video0</SourceToken>');
  };
  try {
    const cam = { host: 'mock', user: 'test', password: 'test' };
    await setTime(cam, { mode: 'manual', offsetMinutes: 0, ntpServer: '' });
    await assert.doesNotReject(getSettings(cam));
  } finally { globalThis.fetch = original; }
});
