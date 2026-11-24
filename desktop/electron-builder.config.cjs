// electron-builder config for the Windows installer (NSIS) + portable .exe.
//
// Auto-update uses GitHub Releases (free for open source). Set these when publishing:
//   ATELIER_GH_OWNER=<github user/org>  ATELIER_GH_REPO=<repo>  GH_TOKEN=<token with repo scope>
//   npm run dist:publish --workspace @atelier/desktop
// Without them the build still works; the app simply never checks for updates.
const owner = process.env.ATELIER_GH_OWNER;
const repo = process.env.ATELIER_GH_REPO;
// The app folder (desktop/app) has no electron dependency; pin the version that is installed.
const electronVersion = require('electron/package.json').version;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.atelier.desktop',
  productName: 'Atelier',
  electronVersion,
  copyright: 'Copyright © Atelier contributors',
  directories: {
    app: 'app',
    output: 'release',
    buildResources: 'assets',
  },
  files: ['**/*', '!**/*.map'],
  // Agent SDK and Playwright spawn files from their package folder with an external `node` /
  // browser, which cannot read inside app.asar — ship the app as plain files.
  asar: false,
  npmRebuild: false, // no native modules: node:sqlite is built into Electron's Node
  extraMetadata: { main: 'main.mjs' },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'assets/icon.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false, // per-user install under %LOCALAPPDATA%\Programs — no admin prompt
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Atelier',
    deleteAppDataOnUninstall: false, // user data in %APPDATA%\Atelier survives uninstall/upgrade
    artifactName: 'Atelier-Setup-${version}.${ext}',
  },
  portable: {
    artifactName: 'Atelier-Portable-${version}.${ext}',
  },
  publish: owner && repo ? [{ provider: 'github', owner, repo, releaseType: 'release' }] : null,
};
