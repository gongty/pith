# Node.js Web App → macOS DMG (Electron)

把任意 Node.js HTTP server 包成原生 macOS 桌面应用。

## 原理

```
Electron main process (main.js)
  ├── fork('server.js')          ← 你的 Node.js server，子进程运行
  │     └── 监听 127.0.0.1:PORT
  └── BrowserWindow
        └── loadURL('http://127.0.0.1:PORT')   ← 渲染你的 web UI
```

前端代码零改动，Electron 只是一个"带窗口的浏览器 + 内置 Node"。

---

## 步骤

### 1. 安装依赖

```bash
npm install --save-dev electron electron-builder
# 国内: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

### 2. 创建 `electron/main.js`

```js
delete process.env.ELECTRON_RUN_AS_NODE;  // 防 Claude Code 等工具污染

const { app, BrowserWindow, dialog } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const PORT = 3456;
const SERVER_SCRIPT = path.join(__dirname, '..', 'server.js');

let serverProcess = null;
let mainWindow = null;
let quitting = false;
let ownServer = false;

// ── 数据目录：与安装路径解耦 ──
let dataDir = null;
function getDataDir() {
  // app.getPath() 只有 ready 后可用，不能写在模块顶层
  if (!dataDir) dataDir = path.join(app.getPath('userData'), 'data');
  return dataDir;
}

// ── 首次启动：复制种子数据 ──
function seedDataDir() {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  // 按需复制初始配置文件
  const src = path.join(__dirname, '..', 'data', 'seed.json');
  const dst = path.join(dir, 'seed.json');
  if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
}

// ── 端口检测：避免和已有 server 冲突 ──
function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

// ── 启动 server 子进程 ──
function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = fork(SERVER_SCRIPT, [], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: getDataDir(),     // 你的 server 读这个环境变量
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

    // exit code 143 = SIGTERM = 正常退出，不要弹错误
    serverProcess.on('exit', (code) => {
      if (code && code !== 0 && !quitting && mainWindow) {
        dialog.showErrorBox('Server Crashed', `server.js exited with code ${code}`);
      }
      serverProcess = null;
    });

    waitForPort(PORT, 10000).then(resolve).catch(reject);
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

// ── 窗口 ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860,
    minWidth: 800, minHeight: 600,
    title: 'MyApp',
    titleBarStyle: 'hiddenInset',               // macOS 融合标题栏
    trafficLightPosition: { x: 16, y: 16 },     // 红绿灯位置
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 生命周期 ──
app.whenReady().then(async () => {
  try {
    seedDataDir();
    if (await isPortOpen(PORT)) {
      ownServer = false;    // 复用已有 server
    } else {
      ownServer = true;
      await startServer();
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
  quitting = true;        // 标记主动退出，防 exit handler 弹假崩溃
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
});
```

### 3. 配置 `package.json`

```jsonc
{
  "main": "electron/main.js",
  "scripts": {
    "start": "node server.js",
    "electron": "unset ELECTRON_RUN_AS_NODE && electron .",
    "dist": "unset ELECTRON_RUN_AS_NODE && electron-builder --mac dmg"
  },
  "build": {
    "appId": "com.yourname.appname",
    "productName": "MyApp",
    "mac": {
      "category": "public.app-category.productivity",
      "target": "dmg"
    },
    "files": [
      "server.js",
      "electron/**/*",
      "app/**/*",
      "lib/**/*",
      "node_modules/**/*",
      "package.json"
    ],
    "extraResources": [
      // 需要复制到 app bundle 但不在 files 里的数据文件
      { "from": "data/seed.json", "to": "data/seed.json" }
    ]
  }
}
```

### 4. 前端适配（CSS 拖动 + 红绿灯留空）

`hiddenInset` 标题栏隐藏后窗口不能拖动，需要 CSS 配合：

```js
// app.js 初始化时
if (navigator.userAgent.includes('Electron')) {
  document.body.classList.add('electron-app');
}
```

```css
/* 仅 Electron 生效，浏览器不受影响 */
.electron-app .topbar {
  -webkit-app-region: drag;     /* 整个 topbar 可拖动窗口 */
  margin-top: 6px;              /* 和红绿灯对齐 */
}
.electron-app .topbar button,
.electron-app .topbar a,
.electron-app .topbar input {
  -webkit-app-region: no-drag;  /* 交互元素不拖动 */
}
.electron-app .sidebar-header {
  padding-top: 38px;            /* 给红绿灯让位 */
}
```

### 5. Server 端适配

Server 需要支持数据目录环境变量，让 Electron 和独立运行用不同的 data 路径：

```js
// server.js 顶部
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
// 之后所有 data/ 路径都基于 DATA_ROOT
```

### 6. 构建

```bash
npm run dist
# 产物: dist/MyApp-x.y.z-arm64.dmg
```

---

## 陷阱速查

| 问题 | 现象 | 解法 |
|------|------|------|
| `app` 为 undefined | 启动即崩，`Cannot read properties of undefined` | `app.getPath()` 不能在模块顶层调用，用 lazy getter |
| `require('electron')` 返回路径字符串 | `app`/`BrowserWindow` 全是 undefined | 环境里有 `ELECTRON_RUN_AS_NODE=1`，在 main.js 顶部 `delete` 掉 |
| 退出弹 "Server Crashed code 143" | 每次关窗口都报错 | 143 = SIGTERM = 正常退出，加 `quitting` 标志位跳过弹窗 |
| 端口冲突 code 1 | 进去就弹 crash | 已有 server 占端口，启动前 `isPortOpen()` 检测，已占用则复用 |
| 窗口不能拖动 | `hiddenInset` 但鼠标拖不动 | topbar 加 `-webkit-app-region:drag` |
| 红绿灯盖住内容 | 文字和红绿灯重叠 | sidebar-header 加 `padding-top` |
| Gatekeeper 拦截 | "无法验证开发者" | 未签名/公证，用户需右键→打开或 `xattr -cr App.app` |
| Electron 下载超时 | npm install 卡住 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |

---

## 分发注意

- **签名**：无 Apple Developer 证书时只能 ad-hoc 签名，其他人需手动绕过 Gatekeeper
- **公证**：需要 `electron-builder` 配置 `notarize`，要求 Apple Developer 账号 + app-specific password
- **架构**：默认只打当前架构；`--universal` 打通用包（体积翻倍），`--x64` 单独打 Intel
- **自动更新**：`electron-updater` + GitHub Releases 或自建更新服务器
