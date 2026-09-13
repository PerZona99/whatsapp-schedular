// electron-main.js
// This is what turns Dispatch into a double-clickable desktop app.
// It does two things:
//   1. Points the server's data/session folders at a writable, per-user
//      location (Program Files isn't writable, and two people installing
//      this app must never share a WhatsApp session).
//   2. Opens a window pointed at the server, instead of a browser tab.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const userDataDir = app.getPath('userData'); // e.g. %APPDATA%\Dispatch on Windows

process.env.DISPATCH_DATA_DIR = userDataDir;
process.env.DISPATCH_AUTH_DIR = path.join(userDataDir, 'wwebjs_auth');
process.env.PORT = process.env.PORT || '3000';

fs.mkdirSync(userDataDir, { recursive: true });

if (app.isPackaged) {
    // Puppeteer's Chromium is bundled alongside the app (see the
    // "extraResources" entry in package.json's build config). Setting
    // this before whatsapp-web.js/puppeteer gets required below makes
    // puppeteer resolve its executable from the bundled copy instead of
    // looking for a system install or trying to download one.
    process.env.PUPPETEER_CACHE_DIR = path.join(process.resourcesPath, 'pptr-cache');
}

// Starts Express + the whatsapp-web.js client immediately.
require('./server.js');

let win;

function createWindow() {
    win = new BrowserWindow({
        width: 1150,
        height: 820,
        minWidth: 760,
        minHeight: 600,
        autoHideMenuBar: true,
        title: 'Dispatch'
    });

    const url = `http://localhost:${process.env.PORT}`;

    // The server takes a moment to bind its port on first launch, so
    // retry the load a few times instead of showing Electron's default
    // "can't reach this page" error.
    function tryLoad() {
        win.loadURL(url).catch(() => setTimeout(tryLoad, 400));
    }
    tryLoad();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
