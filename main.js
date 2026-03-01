const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, ipcMain, screen, desktopCapturer, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

// Native NSPanel module — converts Electron's NSWindow to a real NSPanel
// with nonactivatingPanel style mask. This prevents app activation when shown.
let panelModule = null;
if (process.platform === 'darwin') {
  try { panelModule = require('@ashubashir/electron-panel-window'); } catch (e) {}
}

// Global error handlers - log but don't crash
process.on('uncaughtException', (err) => {
  console.error('[teus-quick] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[teus-quick] Unhandled rejection:', reason);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let tray = null;
let win = null;
let lastScreenshot = null;
let pendingAuthUrl = null;

// --- Window bounds persistence ---
const boundsFile = path.join(app.getPath('userData'), 'window-bounds.json');

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(boundsFile, JSON.stringify(win.getBounds()));
  } catch (e) {}
}

// Register custom protocol (must be before ready)
app.setAsDefaultProtocolClient('teus-quick');

// macOS: open-url can fire before app is ready
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (win && !win.isDestroyed()) {
    handleProtocolUrl(url);
  } else {
    pendingAuthUrl = url;
  }
});

// Accessory policy: no dock icon, no Cmd+Tab, no app activation
app.setActivationPolicy('accessory');

app.whenReady().then(() => {
  createTray();
  createWindow();
  registerShortcut();
  ipcMain.on('hide-window', () => hideWindow());
  ipcMain.on('open-external', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://teuss.app')) {
      require('electron').shell.openExternal(url);
    }
  });
  ipcMain.handle('check-screen-permission', () => {
    if (process.platform === 'darwin') {
      return systemPreferences.getMediaAccessStatus('screen');
    }
    return 'granted';
  });
  ipcMain.handle('get-screenshot', () => lastScreenshot);

  // Trigger screen recording permission prompt on first launch
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});

  // Process pending auth URL (macOS: open-url may have fired before ready)
  if (pendingAuthUrl) {
    handleProtocolUrl(pendingAuthUrl);
    pendingAuthUrl = null;
  }

  // Windows: check argv for protocol URL on first launch
  const protocolArg = process.argv.find(a => a.startsWith('teus-quick://'));
  if (protocolArg) handleProtocolUrl(protocolArg);
});

function createTray() {
  const isMac = process.platform === 'darwin';
  const shortcut = isMac ? '⌘L' : 'Ctrl+L';

  let icon;
  if (isMac) {
    const iconPath = path.join(__dirname, 'assets', 'iconTemplate.png');
    icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  }

  tray = new Tray(icon);
  tray.setToolTip(`Quick by TEUS (${shortcut})`);
  tray.on('click', () => toggleWindow());

  const contextMenu = Menu.buildFromTemplate([
    { label: `Abrir (${shortcut})`, click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Reiniciar', click: () => {
      if (win && !win.isDestroyed()) win.loadURL('https://teuss.app/exam');
    }},
    { type: 'separator' },
    { label: 'Salir', click: () => app.exit(0) },
  ]);
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
}

function getDefaultPosition() {
  const display = screen.getPrimaryDisplay();
  const { height: sh } = display.workAreaSize;
  return { x: 20, y: sh - 300 };
}

async function captureScreenshot() {
  try {
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'denied') return null;
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (!sources || sources.length === 0) return null;
    const img = sources[0].thumbnail;
    if (img.isEmpty()) return null;
    const buf = img.toJPEG(70);
    if (buf.length < 5000) return null;
    // 5MB size limit
    if (buf.length > 5 * 1024 * 1024) return null;
    return buf.toString('base64');
  } catch (e) {
    return null;
  }
}

function createWindow() {
  const saved = loadBounds();
  const defaults = getDefaultPosition();
  const bounds = saved || { x: defaults.x, y: defaults.y, width: 340, height: 280 };
  const isWin = process.platform === 'win32';

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 300,
    minHeight: 220,
    maxWidth: 600,
    maxHeight: 500,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#141414',
    roundedCorners: true,
    // macOS: titleBarStyle required by electron-panel-window module
    // Windows: toolbar type for no taskbar entry
    ...(process.platform === 'darwin' ? { titleBarStyle: 'customButtonsOnHover', closable: false } : {}),
    ...(isWin ? { type: 'toolbar', thickFrame: false } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // macOS: convert to real NSPanel with nonactivatingPanel style mask.
  // This is what makes the window truly invisible to focus tracking.
  if (panelModule) {
    panelModule.makePanel(win);
    win.setContentProtection(true); // hide from screen capture APIs
  }

  // Always start on /exam directly — never show the full website
  win.loadURL('https://teuss.app/exam');

  // After each page load, ensure we stay on /exam or show connect screen
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(0.85);
    injectUI();
    ensureExamOnly();
  });

  // Intercept navigations away from /exam (e.g. auth redirects)
  win.webContents.on('will-navigate', (event, url) => {
    // Allow /exam and /exam?quick_auth=... navigations
    if (url.includes('/exam')) return;
    // Block everything else (login page, main page, etc.) — show connect screen instead
    event.preventDefault();
    showConnectScreen();
  });

  // Also catch SPA navigations
  win.webContents.on('did-navigate-in-page', (event, url) => {
    if (!url.includes('/exam')) {
      showConnectScreen();
    }
  });

  // Send last screenshot when window becomes visible (fallback for tray click, etc.)
  win.on('show', () => {
    if (lastScreenshot && !win.isDestroyed()) {
      win.webContents.send('screenshot-captured', lastScreenshot);
    }
  });

  // Let /exam links navigate inside the window; everything else opens in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('teuss.app/exam')) {
      win.loadURL(url);
    } else {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Save bounds when moved or resized
  win.on('moved', () => saveBounds());
  win.on('resized', () => saveBounds());

  win.on('close', (e) => {
    e.preventDefault();
    saveBounds();
    win.hide();
  });
}

function ensureExamOnly() {
  if (!win || win.isDestroyed()) return;
  const currentURL = win.webContents.getURL();
  // If we ended up somewhere other than /exam, show connect screen
  if (!currentURL.includes('/exam')) {
    showConnectScreen();
  }
}

function showConnectScreen() {
  if (!win || win.isDestroyed()) return;
  const isMac = process.platform === 'darwin';
  const shortcut = isMac ? '⌘L' : 'Ctrl+L';
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #141414;
    color: #fff;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    -webkit-app-region: drag;
    user-select: none;
  }
  .logo { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
  .logo span { color: #0033A0; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 32px; }
  .instructions {
    -webkit-app-region: no-drag;
    text-align: center;
    padding: 0 24px;
  }
  .step {
    font-size: 13px;
    color: #aaa;
    margin-bottom: 12px;
    line-height: 1.5;
  }
  .step strong { color: #0033A0; }
  .link {
    display: inline-block;
    margin-top: 8px;
    padding: 8px 20px;
    background: #0033A0;
    color: #000;
    border-radius: 8px;
    text-decoration: none;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .link:hover { background: #002266; }
  .shortcut { font-size: 11px; color: #555; margin-top: 24px; }
</style>
</head>
<body>
  <div class="logo"><span>quick</span></div>
  <div class="subtitle">by TEUS</div>
  <div class="instructions">
    <div class="step">Para conectar tu cuenta:</div>
    <div class="step">1. Abre <strong>teuss.app</strong> en tu navegador</div>
    <div class="step">2. Haz clic en <strong>"Conectar mi cuenta"</strong></div>
    <div class="step">3. Quick se conectara automaticamente</div>
    <a class="link" href="https://teuss.app" target="_blank">Abrir teuss.app</a>
  </div>
  <div class="shortcut">${shortcut} para abrir/cerrar</div>
</body>
</html>
  `)}`);
}

function injectUI() {
  if (!win || win.isDestroyed()) return;

  win.webContents.executeJavaScript(`
    (function() {
      // --- Drag bar (just for moving, no buttons) ---
      if (!document.getElementById('teus-bar')) {
        var bar = document.createElement('div');
        bar.id = 'teus-bar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:24px;-webkit-app-region:drag;z-index:99999;background:transparent;cursor:grab';
        document.body.prepend(bar);
      }

      // --- Escape to hide ---
      if (!window._teusKeys) {
        window._teusKeys = true;
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape' && window.teus) window.teus.hide();
        });
      }

      // --- Drag & drop images ---
      if (!window._teusDrop) {
        window._teusDrop = true;

        document.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.stopPropagation();
        });

        document.addEventListener('drop', function(e) {
          e.preventDefault();
          e.stopPropagation();

          var files = e.dataTransfer && e.dataTransfer.files;
          if (!files || files.length === 0) return;

          var file = files[0];
          if (!file.type.startsWith('image/')) return;

          var fileInput = document.querySelector('input[type="file"][accept="image/*"]');
          if (fileInput) {
            var dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });

        document.addEventListener('dragenter', function(e) {
          e.preventDefault();
          if (!document.getElementById('teus-drop-overlay')) {
            var overlay = document.createElement('div');
            overlay.id = 'teus-drop-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,51,160,0.1);border:2px dashed rgba(0,51,160,0.5);border-radius:16px;display:flex;align-items:center;justify-content:center;pointer-events:none';
            overlay.innerHTML = '<div style="background:rgba(0,0,0,0.7);padding:8px 16px;border-radius:10px;color:#0033A0;font-size:13px;font-weight:600">Suelta la imagen aqui</div>';
            document.body.appendChild(overlay);
          }
        });

        document.addEventListener('dragleave', function(e) {
          if (e.relatedTarget === null || e.relatedTarget === document.documentElement) {
            var ov = document.getElementById('teus-drop-overlay');
            if (ov) ov.remove();
          }
        });

        document.addEventListener('drop', function() {
          var ov = document.getElementById('teus-drop-overlay');
          if (ov) ov.remove();
        });
      }
    })();
  `).catch(() => {});
}

function hideWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
  }
}

async function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
  }

  if (win.isVisible()) {
    win.hide();
    return;
  }

  // 1. Capture screenshot BEFORE showing (user's window is still in foreground)
  const screenshot = await captureScreenshot();
  lastScreenshot = screenshot;

  // 2. Now show the TEUS window at saved position (or default)
  const saved = loadBounds();
  const defaults = getDefaultPosition();
  const bounds = saved || { x: defaults.x, y: defaults.y, width: 340, height: 280 };
  win.setBounds(bounds);

  if (panelModule) {
    // showInactive() displays without activating, makeKeyWindow() gives
    // keyboard focus WITHOUT activating the app — browser keeps focus.
    win.showInactive();
    panelModule.makeKeyWindow(win);
  } else {
    win.show();
    win.focus();
    // Windows DPI workaround: re-apply bounds after show
    win.setBounds(bounds);
    win.setSkipTaskbar(true);
  }

  // 3. Send the pre-captured screenshot
  if (win && !win.isDestroyed()) {
    win.webContents.send('screenshot-captured', screenshot);
  }
}

function registerShortcut() {
  globalShortcut.register('CommandOrControl+L', () => toggleWindow());
}

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Convert panel back to window before quitting to prevent crashes
  if (panelModule && win && !win.isDestroyed()) {
    try { panelModule.makeWindow(win); } catch (e) {}
  }
});
app.on('second-instance', (_event, argv) => {
  // Windows: protocol URL comes in argv of second instance
  const protocolArg = argv.find(a => a.startsWith('teus-quick://'));
  if (protocolArg) {
    handleProtocolUrl(protocolArg);
  } else {
    toggleWindow();
  }
});

function handleProtocolUrl(url) {
  try {
    if (typeof url !== 'string' || !url.startsWith('teus-quick://')) {
      console.warn('[teus-quick] Invalid protocol URL format');
      return;
    }

    const parsed = new URL(url);
    if (parsed.protocol !== 'teus-quick:') return;

    const refreshToken = parsed.searchParams.get('rt');
    if (!refreshToken || refreshToken.length < 10 || refreshToken.length > 4096) {
      console.warn('[teus-quick] Invalid or missing refresh token');
      return;
    }

    if (!win || win.isDestroyed()) createWindow();

    // Whitelist: only allow alphanumeric, hyphens, underscores, dots
    const sanitized = refreshToken.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!sanitized || sanitized.length < 10) {
      console.warn('[teus-quick] Token failed sanitization');
      return;
    }

    win.loadURL(`https://teuss.app/exam?quick_auth=${encodeURIComponent(sanitized)}`);
    if (panelModule) {
      win.showInactive();
      panelModule.makeKeyWindow(win);
    } else {
      win.show();
      win.focus();
    }
  } catch (e) {
    console.error('[teus-quick] Protocol handler error:', e.message);
  }
}
