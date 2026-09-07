import { contextBridge, ipcRenderer } from 'electron'

// Anti-AFK: hidden tabs pretend to stay visible so site timers keep running.
try {
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true })
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true })
} catch {}

// Minimal host API for the injected page script (content.js runs in the page
// context where require('electron') is unavailable, so it cannot talk to main
// directly). Detector only notifies — it never clicks the page.
try {
  contextBridge.exposeInMainWorld('__animeon', {
    storeGet: (key: string) => ipcRenderer.invoke('store:get', key),
    storeSet: (key: string, val: any) => ipcRenderer.invoke('store:set', key, val),
    anomalyDetected: (info: any) => ipcRenderer.invoke('anomaly:detected', info),
    anomalyClaim: () => ipcRenderer.invoke('anomaly:claim'),
    anomalyAction: (action: string) => ipcRenderer.invoke('anomaly:action', action),
    followbackLists: () => ipcRenderer.invoke('followback:lists'),
    followbackNotify: (names: string[]) => ipcRenderer.invoke('followback:notify', names),
    followbackDiag: (msg: string) => ipcRenderer.invoke('followback:diag', msg),
    followbackHeartbeat: (ts: number) => ipcRenderer.invoke('followback:heartbeat', ts),
    followbackClaim: (owner: string, renew: boolean) => ipcRenderer.invoke('followback:claim', owner, renew),
    followbackFinish: (summary: any, claimed: boolean) => ipcRenderer.invoke('followback:finish', summary, claimed),
  })
} catch {}
