const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teus', {
  hide: () => ipcRenderer.send('hide-window'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onScreenshot: (cb) => ipcRenderer.on('screenshot-captured', (_e, b64) => cb(b64)),
  removeScreenshotListener: () => ipcRenderer.removeAllListeners('screenshot-captured'),
  getScreenshot: () => ipcRenderer.invoke('get-screenshot'),
  checkScreenPermission: () => ipcRenderer.invoke('check-screen-permission'),
});
