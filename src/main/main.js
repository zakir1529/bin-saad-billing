'use strict';

// The program that runs on the shop PC: opens the window, keeps the data safe, and talks to the printer.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('../core/store');
const { Service, formatBillNo } = require('../core/service');
const { UserError } = require('../core/errors');
const { buildReceiptHtml, sampleBill } = require('../core/receipt');
const { buildDayReportHtml, buildRangeReportHtml } = require('../core/report');
const { sendMail, gzip } = require('./smtp');

let mainWindow = null;
let store = null;
let service = null;
let lastBackup = { ok: null, at: null, error: '', target: '' };
let backupTimer = null;

const MUTATING = new Set(['createBill', 'cancelBill', 'saveSuit', 'importSuits', 'saveUser', 'saveSettings', 'setupOwner', 'changePassword', 'receiveUdhaar', 'addStock', 'importStock', 'createRecoveryCode', 'resetWithRecovery', 'clearTestData', 'clearTestBefore', 'startRealSales', 'saveSuitSizes', 'setBasePrice', 'deleteSuit', 'saveEmailSettings', 'resetWithEmailCode', 'switchAccount']);

// ---------- a small log file, and nothing is allowed to crash the program ----------
function logLine(text) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1000000) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch (e) { /* logging must never cause a problem of its own */ }
}
process.on('uncaughtException', (e) => logLine('uncaughtException: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => logLine('unhandledRejection: ' + (e && e.stack ? e.stack : e)));

// ---------- start-up ----------
if (!app.requestSingleInstanceLock()) {
  app.quit(); // a second copy must never open the same data file
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start);
}

function start() {
  Menu.setApplicationMenu(null);
  const dataDir = path.join(app.getPath('userData'), 'data');
  try {
    store = new Store(path.join(dataDir, 'data.json'));
  } catch (e) {
    dialog.showErrorBox('Bin Saad Billing cannot start', String(e.message || e));
    app.quit();
    return;
  }
  service = new Service({ store });
  registerIpc();
  createWindow();
  scheduleBackup(2000);
  setupAutoUpdate();
  setInterval(emailTick, 5 * 60000);
  setTimeout(emailTick, 60000);
}

// Checks GitHub for a newer version, downloads it quietly, then asks before installing.
// Never touches the data file. Does nothing when run from source or offline.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { logLine('updater missing: ' + e.message); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('error', (e) => logLine('update check: ' + (e && e.message)));
  autoUpdater.on('update-downloaded', async (info) => {
    const w = BrowserWindow.getAllWindows()[0];
    const r = await dialog.showMessageBox(w || undefined, {
      type: 'info', buttons: ['Install now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready', message: 'A new version of Bin Saad Billing is ready.',
      detail: 'Your bills and data are not touched. Choose Later to install it when you close the program.',
    });
    if (r.response === 0) { runBackup(); autoUpdater.quitAndInstall(); }
  });
  const check = () => { autoUpdater.checkForUpdates().catch((e) => logLine('update check: ' + (e && e.message))); };
  setTimeout(check, 30000);
  setInterval(check, 4 * 3600000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 800,
    minWidth: 1100,
    minHeight: 650,
    title: 'Bin Saad Billing',
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  // If the screen ever freezes or crashes, bring it straight back. Saved bills are on disk, so nothing is lost.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logLine('render-process-gone: ' + JSON.stringify(details));
    if (mainWindow) setTimeout(() => { try { mainWindow.webContents.reload(); } catch (e) { logLine('reload failed: ' + e); } }, 500);
  });
  mainWindow.webContents.on('unresponsive', () => logLine('window unresponsive'));
  mainWindow.webContents.on('responsive', () => logLine('window responsive again'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logLine(`did-fail-load ${code} ${desc}`);
    setTimeout(() => { try { if (mainWindow) mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')); } catch (e) { /* ignore */ } }, 1000);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('before-quit', () => { runBackup(); });
app.on('window-all-closed', () => {
  runBackup(); // a last copy of the data when the program is closed
  app.quit();
});

// ---------- backups ----------
function localBackupDir() {
  return path.join(app.getPath('userData'), 'backups');
}

function runBackup() {
  if (!store) return;
  clearTimeout(backupTimer);
  backupTimer = null;
  const settings = store.data.settings;
  const targets = [localBackupDir()];
  if (settings.backupDir) targets.push(settings.backupDir);
  let error = '';
  let target = '';
  for (const dir of targets) {
    try {
      target = store.backupTo(dir);
    } catch (e) {
      error = `Could not copy to ${dir}: ${e.message}`;
    }
  }
  lastBackup = { ok: !error, at: new Date().toISOString(), error, target };
}

function scheduleBackup(ms) {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(runBackup, ms);
}

// ---------- receipts and printing ----------
async function loadReceiptWindow(html) {
  const tmpDir = path.join(app.getPath('userData'), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, 'receipt.html');
  fs.writeFileSync(file, html, 'utf8');
  const win = new BrowserWindow({ show: false, width: 420, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(file);
  const heightPx = await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');
  return { win, heightPx };
}

function printWindow(win, options) {
  return new Promise((resolve, reject) => {
    win.webContents.print(options, (success, reason) => {
      if (success) resolve();
      else reject(new UserError(reason && reason !== 'Print job canceled' ? `The printer did not print: ${reason}` : 'Printing was cancelled.'));
    });
  });
}

async function printHtml(html) {
  const settings = store.data.settings;
  const { win, heightPx } = await loadReceiptWindow(html);
  try {
    const widthMicrons = settings.paperWidthMm * 1000;
    const heightMicrons = Math.ceil(heightPx * 264.583) + 6000; // pixels to microns, plus a little tail
    await printWindow(win, {
      silent: !!settings.silentPrint,
      deviceName: settings.printerName || '',
      printBackground: true,
      color: false,
      margins: { marginType: 'none' },
      pageSize: { width: widthMicrons, height: heightMicrons },
    });
  } finally {
    win.destroy();
  }
}

function receiptFor(id) {
  const bill = service.getBill(id);
  const settings = service.getSettings();
  return { bill, settings, html: buildReceiptHtml(bill, settings, { duplicate: (bill.printCount || 0) > 0 }) };
}

async function makeDayPdf(dateKey) {
  const { report, bills, html } = service._asOwner(() => {
    const report = service.dailyReport(dateKey);
    const bills = service.searchBills({ from: report.dateKey, to: report.dateKey, limit: 500 });
    return { report, bills, html: buildDayReportHtml(report, bills, service.getSettings()) };
  });
  const tmpDir = path.join(app.getPath('userData'), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, 'day-report.html');
  fs.writeFileSync(tmp, html, 'utf8');
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    return { pdf, report, bills };
  } finally {
    win.destroy();
  }
}

// ---------- email helpers ----------
function emailConfig() {
  const e = store.data.settings.email;
  const blob = service._getEmailSecret();
  if (!e.to || !e.from || !blob) throw new UserError('Email is not set up yet. Fill in the Email card in Settings first.');
  let pass;
  try { pass = safeStorage.decryptString(Buffer.from(blob, 'base64')); } catch (err) { throw new UserError('The saved email password cannot be read on this computer. Save it again in Settings.'); }
  return { e, pass };
}
async function mail(subject, text, attachments = [], toOverride) {
  const { e, pass } = emailConfig();
  await sendMail({ host: e.host || 'smtp.gmail.com', port: e.port || 465, user: e.from, pass, from: `Bin Saad Billing <${e.from}>`, to: toOverride || e.to, subject, text, attachments });
}
const todayKeyMain = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

async function sendDaily(force) {
  const e = store.data.settings.email;
  const key = todayKeyMain();
  const { pdf, report } = await makeDayPdf(key);
  const lines = [`Bin Saad Fabrics: sales for ${key}`, '', `Bills: ${report.bills}`, `Sales: Rs ${Number(report.sales).toLocaleString('en-US')}`];
  if (e.lowStock) {
    const d = service._asOwner(() => service.dashboard());
    lines.push('', d.low.length ? 'Running low or out:' : 'Nothing is running low.');
    for (const x of d.low) lines.push(`  ${x.name}: ${x.stock === 0 ? 'OUT' : x.stock + ' left'}`);
  }
  await mail(`Bin Saad sales ${key}`, lines.join('\n'), e.dailyPdf || force ? [{ filename: `Sales-${key}.pdf`, content: pdf, type: 'application/pdf' }] : []);
  service._markEmailSent('daily', key);
}
async function sendBackupMail() {
  const key = todayKeyMain();
  const buf = gzip(fs.readFileSync(store.file));
  if (buf.length > 20 * 1024 * 1024) throw new UserError('The data file is too large to email. Use the USB drive.');
  await mail(`Bin Saad backup ${key}`, 'A copy of the shop data is attached (compressed). Keep this email private. Only the owner address receives it.', [{ filename: `binsaad-${key}.json.gz`, content: buf, type: 'application/gzip' }]);
  service._markEmailSent('backup', key);
}
let emailRetryAt = 0;
async function emailTick() {
  try {
    if (!store || !service || Date.now() < emailRetryAt) return;
    const e = store.data.settings.email;
    if (!e || !e.to || !e.from || !service._getEmailSecret()) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < (e.sendAt || '22:30')) return;
    const key = todayKeyMain();
    const st = store.data.emailState || {};
    if ((e.dailyPdf || e.lowStock) && st.lastDaily !== key) await sendDaily(false);
    if (e.backupCopy && st.lastBackup !== key) await sendBackupMail();
  } catch (err) {
    logLine('email: ' + (err && err.message ? err.message : err));
    emailRetryAt = Date.now() + 30 * 60000; // try again in half an hour
  }
}
// tell the owner when a password changes, if email is set up
function notifyPasswordChange(how) {
  try {
    const e = store.data.settings.email;
    if (!e || !e.to || !e.from || !service._getEmailSecret()) return;
    mail('Bin Saad: a password was changed', `The owner password was changed (${how}) on ${new Date().toLocaleString('en-GB')}. If this was not you, use the paper recovery code and check the shop computer.`).catch((err) => logLine('email: ' + err.message));
  } catch (err) { /* never block the change itself */ }
}

const EXTRA = {
  async printBill(id) {
    const { bill, html } = receiptFor(id);
    if (bill.status === 'cancelled') throw new UserError('A cancelled bill cannot be printed.');
    await printHtml(html);
    service.markPrinted(id);
    return { printed: true };
  },

  receiptHtml(id) {
    return receiptFor(id).html;
  },

  async exportReceiptPdf(id) {
    const { bill, settings, html } = receiptFor(id);
    const { win, heightPx } = await loadReceiptWindow(html);
    try {
      const widthIn = settings.paperWidthMm / 25.4;
      const heightIn = Math.max(2, (heightPx * 0.2646 + 6) / 25.4);
      const pdf = await win.webContents.printToPDF({ printBackground: true, margins: { marginType: 'none' }, pageSize: { width: widthIn, height: heightIn } });
      const dir = path.join(app.getPath('documents'), 'Bin Saad Receipts');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Bill-${formatBillNo(bill.no)}.pdf`);
      fs.writeFileSync(file, pdf);
      shell.showItemInFolder(file);
      return { file };
    } finally {
      win.destroy();
    }
  },

  // The day's sales as an A4 PDF in Documents\Bin Saad Reports. Owner only.
  async dailyReportPdf(dateKey) {
    service._requireOwner();
    const { pdf, report } = await makeDayPdf(dateKey);
    const dir = path.join(app.getPath('documents'), 'Bin Saad Reports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Sales-${report.dateKey}.pdf`);
    fs.writeFileSync(file, pdf);
    shell.showItemInFolder(file);
    return { file };
  },

  // Sales between two dates as an A4 PDF in Documents\Bin Saad Reports. Owner only.
  async rangeReportPdf(from, to) {
    service._requireOwner();
    const html = service._asOwner(() => {
      const range = service.rangeReport(from, to);
      const bills = service.searchBills({ from, to, limit: 5000 });
      return buildRangeReportHtml(range, bills, service.getSettings());
    });
    const tmpDir = path.join(app.getPath('userData'), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, 'range-report.html');
    fs.writeFileSync(tmp, html, 'utf8');
    const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await win.loadFile(tmp);
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
      const dir = path.join(app.getPath('documents'), 'Bin Saad Reports');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Sales-${from}_to_${to}.pdf`);
      fs.writeFileSync(file, pdf);
      shell.showItemInFolder(file);
      return { file };
    } finally {
      win.destroy();
    }
  },

  // ----- email -----
  // The sender's app password is locked by Windows for this user before it is stored. It never goes to a screen.
  saveEmailPassword(appPassword, ownerPassword) {
    service._requireOwner();
    if (!service.verifyPassword(ownerPassword)) throw new UserError('The password is wrong.');
    if (!appPassword) { service._setEmailSecret(''); return { saved: false }; }
    if (!safeStorage.isEncryptionAvailable()) throw new UserError('Windows cannot lock the password on this computer, so it was not saved.');
    const clean = String(appPassword).replace(/\s+/g, '');
    if (clean.length < 8 || clean.length > 64) throw new UserError('That does not look like a Gmail app password (it has 16 letters).');
    service._setEmailSecret(safeStorage.encryptString(clean).toString('base64'));
    return { saved: true };
  },

  async testEmail() {
    service._requireOwner();
    await mail('Bin Saad test email', 'This is a test. If you can read it, email is working. Nothing else was sent.');
    return { sent: true };
  },

  // Anyone at the login screen can ask. The code goes only to the owner's email address, never back to the screen.
  async requestEmailCode() {
    const { code, to } = service._beginEmailReset();
    await mail('Your Bin Saad password reset code', `Your code is ${code}\n\nIt works once and expires in 10 minutes. If you did not ask for it, ignore this email: nobody can get in with it unless they also have this code.`, [], to);
    return { sent: true };
  },

  async sendReportNow() { service._requireOwner(); await sendDaily(true); return { sent: true }; },
  async sendBackupNow() { service._requireOwner(); await sendBackupMail(); return { sent: true }; },

  async testPrint() {
    service._requireOwner();
    const settings = service.getSettings();
    await printHtml(buildReceiptHtml(sampleBill(), settings, { test: true }));
    return { printed: true };
  },

  testReceiptHtml() {
    service._requireOwner();
    return buildReceiptHtml(sampleBill(), service.getSettings(), { test: true });
  },

  async listPrinters() {
    service._requireOwner();
    const list = await mainWindow.webContents.getPrintersAsync();
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  },

  async chooseImage() {
    service._requireOwner();
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const stat = fs.statSync(file);
    if (stat.size > 400 * 1024) throw new UserError('That picture is too large. Please choose one under 400 KB.');
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
  },

  async chooseBackupDir() {
    service._requireOwner();
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the USB drive or folder for backups',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },

  backupNow() {
    service._requireOwner();
    runBackup();
    if (!lastBackup.ok) throw new UserError(lastBackup.error || 'Backup failed.');
    return lastBackup;
  },

  appInfo() {
    service._requireUser();
    return {
      version: app.getVersion(),
      dataFile: store.file,
      lastBackup,
      backupFolderSet: !!store.data.settings.backupDir,
    };
  },
};

// ---------- the bridge to the screens ----------
function registerIpc() {
  ipcMain.handle('api', async (_event, method, args) => {
    try {
      let value;
      if (method === 'clearTestData' || method === 'clearTestBefore') runBackup(); // a safety copy just before the old bills are removed
      if (Object.prototype.hasOwnProperty.call(EXTRA, method)) value = await EXTRA[method](...(args || []));
      else value = service.call(method, args);
      if (MUTATING.has(method)) scheduleBackup(4000);
      if (method === 'changePassword') notifyPasswordChange('from Settings');
      if (method === 'resetWithRecovery') notifyPasswordChange('with the paper recovery code');
      if (method === 'resetWithEmailCode') notifyPasswordChange('with an emailed code');
      return { ok: true, value };
    } catch (e) {
      const isUser = !!(e && e.userError);
      if (!isUser) console.error(`[${method}]`, e);
      return { ok: false, user: isUser, error: isUser ? e.message : `Something went wrong (${e && e.message ? e.message : e}). Nothing was changed.` };
    }
  });
}
