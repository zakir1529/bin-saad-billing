'use strict';

// The only door between the screens and the program. Screens can ask; the program decides.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  call: async (method, ...args) => {
    const r = await ipcRenderer.invoke('api', method, args);
    if (!r.ok) {
      const err = new Error(r.error);
      err.userError = !!r.user;
      throw err;
    }
    return r.value;
  },
});
