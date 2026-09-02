import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConversationSnapshot,
  DesktopStateSnapshot,
  DesktopWebuiStatusSnapshot,
  DesktopWebuiCommand,
  WrongStackDesktopApi,
} from '../shared/types.js';
import { IPC } from './ipc.js';

const api: WrongStackDesktopApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  getConversation: (runtimeId: string) => ipcRenderer.invoke(IPC.getConversation, runtimeId),
  getWebuiStatus: () => ipcRenderer.invoke(IPC.getWebuiStatus),
  openProject: (root?: string) => ipcRenderer.invoke(IPC.openProject, root),
  registerProject: (root?: string) => ipcRenderer.invoke(IPC.registerProject, root),
  unregisterProject: (root: string) => ipcRenderer.invoke(IPC.unregisterProject, root),
  openProjectSession: (runtimeId?: string) => ipcRenderer.invoke(IPC.openProjectSession, runtimeId),
  activateRuntime: (id: string) => ipcRenderer.invoke(IPC.activateRuntime, id),
  closeRuntime: (id: string) => ipcRenderer.invoke(IPC.closeRuntime, id),
  navigateWebui: (command: DesktopWebuiCommand) => ipcRenderer.invoke(IPC.navigateWebui, command),
  reloadWebui: () => ipcRenderer.invoke(IPC.reloadWebui),
  setShellSidebarCollapsed: (collapsed: boolean) =>
    ipcRenderer.invoke(IPC.setShellSidebarCollapsed, collapsed),
  openSettings: () => ipcRenderer.invoke(IPC.openSettings),
  sendMessage: (runtimeId: string, content: string) =>
    ipcRenderer.invoke(IPC.sendMessage, runtimeId, content),
  abortRuntime: (runtimeId: string) => ipcRenderer.invoke(IPC.abortRuntime, runtimeId),
  openRuntimeInBrowser: (id: string) => ipcRenderer.invoke(IPC.openRuntimeInBrowser, id),
  revealRuntimeRoot: (id: string) => ipcRenderer.invoke(IPC.revealRuntimeRoot, id),
  onStateChanged: (cb: (state: DesktopStateSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopStateSnapshot) => cb(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.off(IPC.stateChanged, handler);
  },
  onConversationChanged: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      conversation: DesktopConversationSnapshot,
    ) => cb(conversation);
    ipcRenderer.on(IPC.conversationChanged, handler);
    return () => ipcRenderer.off(IPC.conversationChanged, handler);
  },
  onWebuiStatusChanged: (cb: (status: DesktopWebuiStatusSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopWebuiStatusSnapshot) =>
      cb(status);
    ipcRenderer.on(IPC.webuiStatusChanged, handler);
    return () => ipcRenderer.off(IPC.webuiStatusChanged, handler);
  },
  onShellSidebarCollapsedChanged: (cb: (collapsed: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, collapsed: boolean) => cb(collapsed);
    ipcRenderer.on(IPC.shellSidebarCollapsedChanged, handler);
    return () => ipcRenderer.off(IPC.shellSidebarCollapsedChanged, handler);
  },
  setLocale: (locale: string) => {
    ipcRenderer.send(IPC.setLocale, locale);
  },
  onLocaleChanged: (cb: (locale: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, locale: string) => cb(locale);
    ipcRenderer.on(IPC.localeChanged, handler);
    return () => ipcRenderer.off(IPC.localeChanged, handler);
  },
};

contextBridge.exposeInMainWorld('wrongstackDesktop', api);
