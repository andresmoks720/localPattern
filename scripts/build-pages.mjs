import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const outDir = resolve(root, '.pages-dist');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

cpSync(resolve(root, 'sender/dist'), resolve(outDir, 'sender'), { recursive: true });
cpSync(resolve(root, 'receiver/dist'), resolve(outDir, 'receiver'), { recursive: true });

writeFileSync(
  resolve(outDir, 'index.html'),
  `<!doctype html>
<html>
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>QR Data Bridge</title>
  <style>body{font-family:Inter,system-ui,sans-serif;background:#020617;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#111827;border:1px solid #334155;border-radius:12px;padding:1.2rem;min-width:280px}a{display:block;color:#93c5fd;margin:.6rem 0}</style>
  </head>
  <body><div class="card"><h1>QR Data Bridge</h1><a href="./sender/">Open Sender</a><a href="./receiver/">Open Receiver</a></div></body>
</html>`
);

console.log('Prepared .pages-dist with sender/receiver apps.');
