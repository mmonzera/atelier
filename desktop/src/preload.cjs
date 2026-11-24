// Sandboxed preload: exposes a tiny, explicit bridge. No Node APIs reach the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atelierDesktop', {
  isDesktop: true,
  pickFolder: (title) => ipcRenderer.invoke('atelier:pick-folder', typeof title === 'string' ? title : undefined),
  getAppInfo: () => ipcRenderer.invoke('atelier:app-info'),
});
