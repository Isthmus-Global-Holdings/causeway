// Builds the extension into extension/dist, the folder to load unpacked at
// chrome://extensions (Developer mode → Load unpacked). After a rebuild, press
// the extension's reload button there.

import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await build({
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background.ts',
    offscreen: 'src/offscreen.ts',
    options: 'src/options.ts',
    popup: 'src/popup.ts',
  },
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  outdir: dist,
  logLevel: 'info',
});
for (const file of ['manifest.json', 'options.html', 'offscreen.html', 'popup.html']) {
  await copyFile(`${root}${file}`, `${dist}/${file}`);
}
