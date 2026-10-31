import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Only the app's reverse listener is allowed: no arbitrary forwarding/SOCKS.
const secret = process.env.TUNNEL_SECRET;
if (!/^[a-f0-9]{64}$/.test(secret || '') || !process.env.CHISEL_KEY) {
  throw new Error('Configure TUNNEL_SECRET (64 hex characters) and CHISEL_KEY before starting');
}
const dir = mkdtempSync(join(tmpdir(), 'adu-gateway-'));
const auth = join(dir, 'users.json');
writeFileSync(auth, JSON.stringify({ ['mac:' + secret]: ['^R:127\\.0\\.0\\.1:3001$'] }), { mode: 0o600 });
const child = spawn('chisel', ['server', '--host', '0.0.0.0', '--port', process.env.PORT || '8080',
  '--reverse', '--authfile', auth, '--backend', 'http://127.0.0.1:3001'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
