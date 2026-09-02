import * as path from 'node:path';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { buildConnectionManager } from './bootstrap';
import { registerIpc } from './ipc/register';
import type { ConnectionManager } from './engine';

/**
 * Where the renderer is loaded from:
 *  - If CUSTOS_DEV_SERVER_URL is set (e.g. http://localhost:4200), load that —
 *    use this for live-reload development with `ng serve`.
 *  - Otherwise load the built renderer from disk. So the simple path is:
 *    build the renderer once, then launch — no dev server needed.
 */
const DEV_SERVER_URL = process.env.CUSTOS_DEV_SERVER_URL;

let manager: ConnectionManager | undefined;

/**
 * Last-resort guards for the main process. An Electron main process dies on an
 * unhandled exception — window and all — with nothing on screen to explain it,
 * and a driver (or one of its dependencies) can throw *outside* any request's
 * await chain: tedious during its login handshake, MSAL while refreshing a
 * token, the loopback listener the browser sign-in flow opens. The web host got
 * this same backstop for the same reason (see server.ts); logging and staying up
 * is far better than a silent disappearance, and the call that triggered it
 * still fails on its own path.
 */
function installProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[custos] Uncaught exception in the main process — app kept alive:', err);
  });
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[custos] Unhandled rejection in the main process — app kept alive:', reason);
  });
}

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

  // A renderer that dies, hangs, or fails to load leaves a blank or missing
  // window that looks exactly like a crash. Say so in the terminal instead.
  window.webContents.on('render-process-gone', (_event, details) => {
    // eslint-disable-next-line no-console
    console.error(`[custos] The window's renderer went away: ${details.reason} (exit ${details.exitCode})`);
  });
  window.webContents.on('unresponsive', () => {
    // eslint-disable-next-line no-console
    console.error('[custos] The window stopped responding.');
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    // eslint-disable-next-line no-console
    console.error(`[custos] Failed to load the UI: ${description} (${code}) — ${url}`);
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    // Angular builds the renderer to renderer/dist/custos/browser.
    void window.loadFile(
      path.join(__dirname, '..', '..', 'renderer', 'dist', 'custos', 'browser', 'index.html'),
    );
  }
}

installProcessGuards();

app.whenReady().then(() => {
  manager = buildConnectionManager(app.getPath('userData'), (url) => shell.openExternal(url));
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
