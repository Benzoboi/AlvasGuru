const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  saveEvent: (data) => ipcRenderer.invoke('save-event', data)
  , listRecordings: () => ipcRenderer.invoke('list-recordings')
  , readRecording: (filename) => ipcRenderer.invoke('read-recording', filename)
  , getDailyReport: () => ipcRenderer.invoke('get-daily-report')
  , getConfig: () => ipcRenderer.invoke('get-config')
  , setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg)
  , exportReportCsv: () => ipcRenderer.invoke('export-report-csv')
  , deleteRecording: (filename) => ipcRenderer.invoke('delete-recording', filename)
  , cleanupNow: () => ipcRenderer.invoke('cleanup-now')
})
