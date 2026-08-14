const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bambi', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  login: () => ipcRenderer.invoke('launcher:login'),
  logout: () => ipcRenderer.invoke('launcher:logout'),
  play: () => ipcRenderer.invoke('launcher:play'),
  saveSettings: (settings) => ipcRenderer.invoke('launcher:save-settings', settings),
  chooseInstallation: () => ipcRenderer.invoke('launcher:choose-installation'),
  getServerStatus: () => ipcRenderer.invoke('launcher:server-status'),
  listContent: () => ipcRenderer.invoke('launcher:list-content'),
  pickContent: (type) => ipcRenderer.invoke('launcher:pick-content', type),
  addDroppedFiles: (files, type) => ipcRenderer.invoke('launcher:add-content-paths', Array.from(files).map(file => webUtils.getPathForFile(file)).filter(Boolean), type),
  toggleContent: (id, enabled) => ipcRenderer.invoke('launcher:toggle-content', id, enabled),
  removeContent: (id) => ipcRenderer.invoke('launcher:remove-content', id),
  searchModrinth: (query, type, offset = 0) => ipcRenderer.invoke('launcher:search-modrinth', query, type, offset),
  installModrinth: (projectId, type) => ipcRenderer.invoke('launcher:install-modrinth', projectId, type),
  openMap: () => ipcRenderer.invoke('launcher:open-map'),
  openFolder: () => ipcRenderer.invoke('launcher:open-folder'),
  onStatus: (callback) => ipcRenderer.on('launcher:status', (_event, value) => callback(value))
});

contextBridge.exposeInMainWorld('bambiWindow', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close')
});
