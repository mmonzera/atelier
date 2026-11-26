import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILES = [
  'package.json',
  'packages/contracts/package.json',
  'server/package.json',
  'web/package.json',
  'desktop/package.json',
  'desktop/src-tauri/tauri.conf.json',
  'desktop/src-tauri/Cargo.toml',
];

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, {
    cwd: rootDir,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.cmd$/i.test(cmd),
    ...opts,
  });
}

function parseArgs(argv) {
  let target = 'patch';
  let local = false;
  let notes = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--local') {
      local = true;
    } else if (a === '--notes' && argv[i + 1]) {
      notes = argv[++i];
    } else if (!a.startsWith('-')) {
      target = a;
    }
  }
  return { target, local, notes };
}

function computeNextVersion(current, target) {
  if (/^\d+\.\d+\.\d+$/.test(target)) return target;
  const parts = current.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid current version: ${current}`);
  }
  const [maj, min, pat] = parts;
  if (target === 'major') return `${maj + 1}.0.0`;
  if (target === 'minor') return `${maj}.${min + 1}.0`;
  if (target === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Specify patch | minor | major | X.Y.Z (got "${target}")`);
}

function updateJsonVersion(relPath, nextVersion) {
  const full = path.join(rootDir, relPath);
  const raw = fs.readFileSync(full, 'utf8');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const obj = JSON.parse(raw);
  obj.version = nextVersion;
  fs.writeFileSync(full, `${JSON.stringify(obj, null, 2).replace(/\n/g, newline)}${newline}`, 'utf8');
}

function updateCargoVersion(relPath, nextVersion) {
  const full = path.join(rootDir, relPath);
  const raw = fs.readFileSync(full, 'utf8');
  const next = raw.replace(
    /(\[package\][\s\S]*?\r?\nversion\s*=\s*)"[^"]+"/,
    `$1"${nextVersion}"`,
  );
  if (next === raw) {
    throw new Error(`Could not update version in ${relPath}`);
  }
  fs.writeFileSync(full, next, 'utf8');
}

function main() {
  const { target, local, notes } = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const nextVersion = computeNextVersion(pkg.version, target);
  const tag = `v${nextVersion}`;
  const releaseNotes = notes || `Atelier ${tag}`;

  console.log(`Releasing Atelier ${pkg.version} -> ${nextVersion} (${local ? 'local build + GitHub Release' : 'git tag -> GitHub Actions'})`);

  for (const rel of VERSION_FILES) {
    if (rel.endsWith('.toml')) updateCargoVersion(rel, nextVersion);
    else updateJsonVersion(rel, nextVersion);
  }

  run('git', ['add', '--', ...VERSION_FILES]);
  const stagedDiff = run('git', ['diff', '--cached', '--name-only'], { capture: true }).trim();
  if (stagedDiff) {
    run('git', ['commit', '-m', `chore(release): ${tag}`]);
  }
  const existingTag = run('git', ['tag', '-l', tag], { capture: true }).trim();
  if (!existingTag) {
    run('git', ['tag', tag]);
  }

  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);

  if (!local) {
    console.log(`Tag ${tag} pushed. GitHub Actions will build, sign, and publish the release.`);
    return;
  }

  const keyPath = path.join(os.homedir(), '.tauri', 'atelier-updater.key');
  const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() ||
    (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() : '');
  if (!privateKey) {
    throw new Error(`Missing TAURI_SIGNING_PRIVATE_KEY and ${keyPath} does not exist.`);
  }

  const buildEnv = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  };
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npmCmd, ['run', 'build'], { env: buildEnv });
  run(npmCmd, ['--workspace', '@atelier/desktop', 'run', 'build:release'], { env: buildEnv });

  const nsisDir = path.join(rootDir, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const exeName = `Atelier_${nextVersion}_x64-setup.exe`;
  const exePath = path.join(nsisDir, exeName);
  const sigPath = `${exePath}.sig`;
  if (!fs.existsSync(exePath) || !fs.existsSync(sigPath)) {
    throw new Error(`Expected signed updater artifacts in ${nsisDir} (${exeName} & .sig)`);
  }

  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  const downloadUrl = `https://github.com/mmonzera/atelier/releases/download/${tag}/${exeName}`;
  const latestJsonPath = path.join(nsisDir, 'latest.json');
  const latestPayload = {
    version: nextVersion,
    notes: releaseNotes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': { signature, url: downloadUrl },
      'windows-x86_64-nsis': { signature, url: downloadUrl },
    },
  };
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(latestPayload, null, 2)}\n`, 'utf8');

  let releaseExists = false;
  try {
    run('gh', ['release', 'view', tag], { capture: true });
    releaseExists = true;
  } catch {
    releaseExists = false;
  }

  if (releaseExists) {
    run('gh', ['release', 'upload', tag, exePath, sigPath, latestJsonPath, '--clobber']);
  } else {
    run('gh', [
      'release',
      'create',
      tag,
      exePath,
      sigPath,
      latestJsonPath,
      '--title',
      `Atelier ${tag}`,
      '--notes',
      releaseNotes,
    ]);
  }
  console.log(`Published release ${tag} with latest.json and signed installer!`);
}

main();
