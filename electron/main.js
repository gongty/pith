delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, dialog } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');
const fs = require('fs');

const BASE_PORT = 3456;
let activePort = BASE_PORT;
const SERVER_SCRIPT = path.join(__dirname, '..', 'server.js');

let dataDir = null;
function getDataDir() {
  if (!dataDir) {
    dataDir = path.join(app.getPath('userData'), 'data');
    // migrate from old "wiki-app" userData path after rename to "pith"
    const oldDir = path.join(path.dirname(app.getPath('userData')), 'wiki-app', 'data');
    if (!fs.existsSync(dataDir) && fs.existsSync(oldDir)) {
      fs.renameSync(oldDir, dataDir);
    }
  }
  return dataDir;
}

let serverProcess = null;
let mainWindow = null;
let quitting = false;
let ownServer = false;

function loadApiKey() {
  if (process.env.WIKI_API_KEY) return process.env.WIKI_API_KEY;
  const devPath = path.join(__dirname, '..', '.api-key');
  try { return fs.readFileSync(devPath, 'utf-8').trim(); } catch {}
  const userPath = path.join(getDataDir(), '.api-key');
  try { return fs.readFileSync(userPath, 'utf-8').trim(); } catch {}
  return '';
}

function seedDataDir() {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, '..', 'data', 'system-sources.json');
  const dst = path.join(dir, 'system-sources.json');
  if (!fs.existsSync(dst) && fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

function isPithServer(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/auth/status`, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve('authRequired' in json && 'authenticated' in json);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function findAvailablePort() {
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    if (!(await isPortOpen(p))) return { port: p, reuse: false };
    if (await isPithServer(p)) return { port: p, reuse: true };
  }
  return { port: BASE_PORT + 20, reuse: false };
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    serverProcess = fork(SERVER_SCRIPT, [], {
      env: {
        ...process.env,
        PORT: String(port),
        WIKI_DATA_DIR: getDataDir(),
        WIKI_API_KEY: loadApiKey(),
        ELECTRON: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(d));
    serverProcess.stderr.on('data', (d) => process.stderr.write(d));

    serverProcess.on('error', (err) => {
      dialog.showErrorBox('Server Error', err.message);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      if (code && code !== 0 && !quitting && mainWindow) {
        dialog.showErrorBox('Server Crashed', `server.js exited with code ${code}`);
      }
      serverProcess = null;
    });

    waitForPort(port, 10000).then(resolve).catch(reject);
  });
}

function waitForPort(port, timeout) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const sock = new net.Socket();
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeout) return reject(new Error('Server start timeout'));
        setTimeout(check, 200);
      });
      sock.connect(port, '127.0.0.1');
    };
    check();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Pith',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${activePort}`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    seedDataDir();
    const found = await findAvailablePort();
    activePort = found.port;
    if (found.reuse) {
      ownServer = false;
    } else {
      ownServer = true;
      await startServer(activePort);
    }
    createWindow();
  } catch (err) {
    dialog.showErrorBox('Startup Failed', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
