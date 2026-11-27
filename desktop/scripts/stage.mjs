// Prepares everything the Tauri bundle ships next to the Rust exe:
//
//   desktop/server-dist/server.mjs    server + sidecar entry, bundled by esbuild
//   desktop/server-dist/web/          Vite build of the frontend
//   desktop/server-dist/node_modules  runtime deps that cannot be bundled (pruned to Windows x64)
//   src-tauri/binaries/atelier-node-<triple>.exe   Node runtime used to run the server
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
const outDir = path.join(desktopDir, 'server-dist');
const binDir = path.join(desktopDir, 'src-tauri', 'binaries');

function getTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') {
    return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  return 'x86_64-unknown-linux-gnu';
}

const TRIPLE = getTargetTriple();

const serverPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'server', 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const webDist = path.join(rootDir, 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('web/dist missing — run `npm run build` at the repo root first.');
  process.exit(1);
}

// Loaded from node_modules at runtime instead of being bundled (they spawn their own files).
const EXTERNAL = {
  'playwright-core': serverPkg.dependencies['playwright-core'],
  '@anthropic-ai/claude-agent-sdk': serverPkg.optionalDependencies?.['@anthropic-ai/claude-agent-sdk'],
};

fs.mkdirSync(outDir, { recursive: true });
for (const entry of ['server.mjs', 'server.mjs.map', 'web']) {
  fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}

// 1) Bundle the sidecar entry (+ whole server).
const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: [path.join(desktopDir, 'sidecar', 'entry.ts')],
  outfile: path.join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'none',
  external: ['bufferutil', 'utf-8-validate', ...Object.keys(EXTERNAL)],
  alias: { '@atelier/contracts': path.join(rootDir, 'packages', 'contracts', 'src', 'index.ts') },
  banner: {
    js: "import { createRequire as __atelierCreateRequire } from 'node:module'; const require = __atelierCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

// 2) Frontend.
fs.cpSync(webDist, path.join(outDir, 'web'), { recursive: true });

// 3) Runtime node_modules (installed only when the dependency set changed).
const deps = Object.fromEntries(Object.entries(EXTERNAL).filter(([, v]) => Boolean(v)));
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify({ name: 'atelier-server', version: rootPkg.version, private: true, type: 'module', dependencies: deps }, null, 2)}\n`,
);
const stamp = path.join(outDir, 'node_modules', '.atelier-deps');
const hash = crypto.createHash('sha256').update(JSON.stringify(deps)).digest('hex');
if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== hash) {
  console.log('Installing sidecar runtime dependencies…');
  fs.rmSync(path.join(outDir, 'node_modules'), { recursive: true, force: true });
  execSync('npm install --omit=dev --no-package-lock --no-audit --no-fund --ignore-scripts', {
    cwd: outDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_workspaces: 'false' },
  });
  // The Agent SDK ships ripgrep for every OS; keep only the current OS.
  const currentPlatform = process.platform === 'win32'
    ? 'x64-win32'
    : (process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin')
      : (process.arch === 'arm64' ? 'arm64-linux' : 'x64-linux'));
  const vendor = path.join(outDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor');
  if (fs.existsSync(vendor)) {
    for (const tool of fs.readdirSync(vendor)) {
      const toolDir = path.join(vendor, tool);
      if (!fs.statSync(toolDir).isDirectory()) continue;
      for (const platform of fs.readdirSync(toolDir)) {
        const p = path.join(toolDir, platform);
        if (fs.statSync(p).isDirectory() && platform !== currentPlatform) fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }
  fs.writeFileSync(stamp, hash);
}

// 4) Node runtime as the Tauri external binary.
fs.mkdirSync(binDir, { recursive: true });
const ext = process.platform === 'win32' ? '.exe' : '';
fs.copyFileSync(process.execPath, path.join(binDir, `atelier-node-${TRIPLE}${ext}`));

const size = (p) => {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    total += e.isDirectory() ? size(f) : fs.statSync(f).size;
  }
  return total;
};
console.log(
  `Staged sidecar ${rootPkg.version}: server-dist ${(size(outDir) / 1048576).toFixed(0)} MB + node ${(fs.statSync(process.execPath).size / 1048576).toFixed(0)} MB`,
);
