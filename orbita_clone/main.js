const { app, BrowserWindow } = require('electron');
const path = require('path');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Start backend server
  require('./server.js');

  let mainWindow = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1300,
      height: 820,
      minWidth: 1000,
      minHeight: 650,
      backgroundColor: '#0f1117',
      title: 'Orbita Anti-Detect Browser Manager',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      },
      autoHideMenuBar: true
    });

    const loadUI = (retries = 15) => {
      mainWindow.loadURL('http://localhost:3030').catch(() => {
        if (retries > 0) setTimeout(() => loadUI(retries - 1), 300);
      });
    };

    setTimeout(() => loadUI(), 350);

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
