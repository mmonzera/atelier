// Builds desktop/app — the self-contained folder electron-builder packages:
//
//   app/main.mjs      Electron main + Hono server + node:sqlite store, bundled by esbuild
//   app/preload.cjs   sandboxed preload bridge
//   app/web/          Vite build of the frontend (served by the in-process server)
//   app/assets/       icons
//   app/node_modules  only runtime deps that cannot be bundled (installed with npm --omit=dev)
//
// Run `npm run build` at the repo root first so web/dist exists.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(desktopDir, '..');
const appDir = path.join(desktopDir, 'app');
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'server', 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

const webDist = path.join(rootDir, 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('web/dist missing — run `npm run build` at the repo root first.');
  process.exit(1);
}

// Runtime deps loaded from node_modules instead of the bundle (they spawn files / ship binaries).
const EXTERNAL_RUNTIME = {
  'playwright-core': serverPkg.dependencies['playwright-core'],
  '@anthropic-ai/claude-agent-sdk': serverPkg.optionalDependencies?.['@anthropic-ai/claude-agent-sdk'],
  'electron-updater': desktopPkg.dependencies['electron-updater'],
};

fs.mkdirSync(appDir, { recursive: true });
for (const entry of ['main.mjs', 'main.mjs.map', 'preload.cjs', 'web', 'assets']) {
  fs.rmSync(path.join(appDir, entry), { recursive: true, force: true });
}

// 1) Bundle main + server.
const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: [path.join(desktopDir, 'src', 'main.ts')],
  outfile: path.join(appDir, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'none',
  external: ['electron', 'bufferutil', 'utf-8-validate', ...Object.keys(EXTERNAL_RUNTIME)],
  alias: { '@atelier/contracts': path.join(rootDir, 'packages', 'contracts', 'src', 'index.ts') },
  // Bundled CommonJS deps (ws, ...) call require(); give the ESM bundle a real one.
  banner: {
    js: "import { createRequire as __atelierCreateRequire } from 'node:module'; const require = __atelierCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

// 2) Static files.
fs.copyFileSync(path.join(desktopDir, 'src', 'preload.cjs'), path.join(appDir, 'preload.cjs'));
fs.cpSync(webDist, path.join(appDir, 'web'), { recursive: true });
fs.cpSync(path.join(desktopDir, 'assets'), path.join(appDir, 'assets'), { recursive: true });

// 3) package.json for the packaged app.
const dependencies = Object.fromEntries(Object.entries(EXTERNAL_RUNTIME).filter(([, v]) => Boolean(v)));
const appPkg = {
  name: 'atelier',
  productName: 'Atelier',
  version: rootPkg.version,
  description: rootPkg.description || 'Atelier: Design-to-Ship Studio',
  author: rootPkg.author || 'Atelier contributors',
  license: rootPkg.license || 'MIT',
  homepage: rootPkg.homepage,
  private: true,
  type: 'module',
  main: 'main.mjs',
  dependencies,
};
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);

// 4) Install runtime deps only when they changed.
const depsHash = crypto.createHash('sha256').update(JSON.stringify(dependencies)).digest('hex');
const stampFile = path.join(appDir, 'node_modules', '.atelier-deps');
const current = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8') : '';
if (current !== depsHash) {
  console.log('Installing desktop runtime dependencies…');
  execSync('npm install --omit=dev --no-package-lock --no-audit --no-fund --ignore-scripts', {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_workspaces: 'false' },
  });
  fs.writeFileSync(stampFile, depsHash);
}

console.log(`Staged desktop app ${appPkg.version} -> ${appDir}`);
