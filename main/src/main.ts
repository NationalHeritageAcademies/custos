import * as path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { buildConnectionManager } from './bootstrap';
import { registerIpc } from './ipc/register';
import type { ConnectionManager } from './engine';

/** Angular dev server URL used in development (see renderer/). */
const DEV_SERVER_URL = process.env.CUSTOS_DEV_SERVER_URL ?? 'http://localhost:4200';

let manager: ConnectionManager | undefined;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12151c' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  if (app.isPackaged) {
    // Renderer is built to renderer/dist/custos/browser by the Angular build.
    void window.loadFile(path.join(__dirname, '..', '..', 'renderer', 'dist', 'custos', 'browser', 'index.html'));
  } else {
    void window.loadURL(DEV_SERVER_URL);
  }
}

app.whenReady().then(() => {
  manager = buildConnectionManager(app.getPath('userData'));
  registerIpc(manager);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void manager?.dispose();
});
