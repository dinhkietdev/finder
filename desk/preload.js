const { contextBridge, ipcRenderer } = require('electron');

// Keep the renderer isolated from Node while exposing only the two IPC
// operations used by the desktop UI. No arbitrary channel or Node API is
// exposed to the page.
contextBridge.exposeInMainWorld('finderAPI', {
    invoke(channel, ...args) {
        return ipcRenderer.invoke(channel, ...args);
    },
    on(channel, listener) {
        const wrapped = (event, data) => listener(event, data);
        ipcRenderer.on(channel, wrapped);
        return () => ipcRenderer.removeListener(channel, wrapped);
    }
});
