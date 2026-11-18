// npm run phone
// Starts the app and opens a free HTTPS tunnel so it works on a phone
// (the share sheet and clipboard only work over HTTPS).
// Uses Cloudflare's quick tunnel if `cloudflared` is installed (brew install cloudflared),
// otherwise falls back to localtunnel through npx.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '3000';
const URL_FILE = path.join(ROOT, 'data', 'phone-url.txt');
const children = [];

const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

fs.mkdirSync(path.dirname(URL_FILE), { recursive: true });
try { fs.unlinkSync(URL_FILE); } catch {}

children.push(spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT } }));

let tunnel, pattern, note = '';
if (has('cloudflared')) {
  tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
  pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
} else if (process.env.USE_LOCALTUNNEL !== '1') {
  // No cloudflared installed: fetch it through npm (the "cloudflared" package downloads the binary).
  console.log('  cloudflared not found, fetching it through npx (one time). Faster next time: brew install cloudflared');
  tunnel = spawn(npx, ['-y', 'cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
  pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
} else {
  console.log('  Using localtunnel. It can drop photo uploads; cloudflared is more reliable (brew install cloudflared)');
  tunnel = spawn(npx, ['-y', 'localtunnel', '--port', PORT]);
  pattern = /https:\/\/\S+\.loca\.lt/;
  note = '  localtunnel asks for a password the first time: it is this computer\'s public IP (see https://loca.lt/mytunnelpassword).\n';
}
children.push(tunnel);

let found = false;
const onData = (buf) => {
  const m = !found && String(buf).match(pattern);
  if (!m) return;
  found = true;
  const url = m[0];
  fs.writeFileSync(URL_FILE, url);
  console.log(`\n  📱 Open this on your phone:  ${url}\n${note}`);
  // QR code in the terminal (best effort).
  const qr = spawn(npx, ['-y', 'qrcode-terminal', url], { stdio: 'inherit' });
  qr.on('error', () => {});
};
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);
tunnel.on('exit', (code) => { if (!found) console.log(`  Tunnel stopped (code ${code}). The app still runs at http://localhost:${PORT}`); });

const stop = () => { for (const c of children) try { c.kill(); } catch {} process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
