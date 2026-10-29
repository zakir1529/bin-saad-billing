'use strict';

// Test harness only (not part of the shipped program): serves the screens in a normal browser and
// connects them to the real billing logic, with a pretend printer, so the screens can be checked here.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../src/core/store');
const { Service } = require('../src/core/service');
const { buildReceiptHtml, sampleBill } = require('../src/core/receipt');
const { buildDayReportHtml } = require('../src/core/report');

const PORT = Number(process.env.PORT || 8765);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-harness-'));
const store = new Store(path.join(dir, 'data.json'));
const service = new Service({ store });
const printed = [];
let failPrint = false;
let lastReport = 'none';

const settings = () => service.getSettings();
const EXTRA = {
  printBill(id) {
    const bill = service.getBill(id);
    if (failPrint) throw Object.assign(new Error('The printer did not print: printer is offline'), { userError: true });
    printed.push({ id, no: bill.no, html: buildReceiptHtml(bill, settings(), { duplicate: bill.printCount > 0 }) });
    service.markPrinted(id);
    return { printed: true };
  },
  receiptHtml(id) {
    const bill = service.getBill(id);
    return buildReceiptHtml(bill, settings(), { duplicate: bill.printCount > 0 });
  },
  exportReceiptPdf() { return { file: 'C:\\Users\\Shop\\Documents\\Bin Saad Receipts\\Bill.pdf' }; },
  dailyReportPdf(dateKey) {
    service._requireOwner();
    const report = service.dailyReport(dateKey);
    lastReport = buildDayReportHtml(report, service.searchBills({ from: report.dateKey, to: report.dateKey, limit: 500 }), settings());
    return { file: 'C:\\Users\\Shop\\Documents\\Bin Saad Reports\\Sales-' + report.dateKey + '.pdf' };
  },
  testPrint() { printed.push({ id: 0, no: 0, html: 'test' }); return { printed: true }; },
  testReceiptHtml() { return buildReceiptHtml(sampleBill(), settings(), { test: true }); },
  listPrinters() { return [{ name: 'POS-80', displayName: 'POS-80 Thermal Printer', isDefault: true }, { name: 'Office', displayName: 'Office Laser', isDefault: false }]; },
  chooseImage() { return null; },
  chooseBackupDir() { return 'E:\\Backups'; },
  backupNow() { return { ok: true, at: new Date().toISOString() }; },
  appInfo() { return { version: '1.0.0', dataFile: store.file, lastBackup: { ok: true, at: new Date().toISOString(), error: '' }, backupFolderSet: false }; },
};

const SHIM = `window.bridge = { call: async (m, ...a) => {
  const r = await fetch('/api', { method: 'POST', body: JSON.stringify({ m, a }) }).then((x) => x.json());
  if (!r.ok) { const e = new Error(r.error); e.userError = r.user; throw e; }
  return r.value; } };`;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serveFile(res, file) {
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'text/plain') + '; charset=utf-8' });
  res.end(fs.readFileSync(file));
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/api') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const { m, a } = JSON.parse(body);
      let out;
      try {
        const value = Object.prototype.hasOwnProperty.call(EXTRA, m) ? await EXTRA[m](...a) : service.call(m, a);
        out = { ok: true, value };
      } catch (e) {
        out = { ok: false, user: !!e.userError, error: e.userError ? e.message : 'Something went wrong (' + e.message + ').' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url === '/__state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ printed: printed.map((p) => ({ id: p.id, no: p.no })), bills: store.data.bills.length }));
    return;
  }
  if (url === '/__printed') {
    const n = Number(new URLSearchParams(req.url.split('?')[1]).get('n') || printed.length - 1);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(printed[n] ? printed[n].html : 'none');
    return;
  }
  if (url === '/__report') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(lastReport); return; }
  if (url === '/__failprint') { failPrint = req.url.includes('on=1'); res.end('ok'); return; }
  if (url === '/__shim.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(SHIM); return; }
  if (url === '/' || url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
      .replace('<script src="../core/money.js">', '<script src="/__shim.js"></script><script src="/core/money.js">');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url.startsWith('/core/')) return serveFile(res, path.join(__dirname, '../src/core', path.basename(url)));
  return serveFile(res, path.join(__dirname, '../src/renderer', path.basename(url)));
}).listen(PORT, '127.0.0.1', () => console.log('harness on ' + PORT));
