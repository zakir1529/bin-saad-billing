'use strict';

// A small file-based data store. No database engine and no native modules, so it installs anywhere.
// Safety: every save writes a temporary file, flushes it to disk, keeps the previous version as data.json.bak,
// then swaps the new file in. If a save fails, memory is reloaded from disk so screen and disk never disagree.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  shopName: 'Bin Saad Fabrics',
  address: '',
  phone: '',
  whatsapp: '',
  footer: 'Thank you for shopping with us',
  paperWidthMm: 80,
  printerName: '', // empty = the Windows default printer
  silentPrint: true,
  paymentMethods: ['Cash', 'JazzCash', 'Easypaisa', 'Bank'],
  discountLimitPct: 15, // staff cannot give more than this; the owner can
  revealNeedsPassword: true,
  backupDir: '',
  logo: '', // data URI, optional
  qr: '', // data URI, optional
};

function freshData() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    users: [],
    suits: [],
    bills: [],
    payments: [], // money received later from customers who took udhaar
    counters: { billNo: 0, id: 0 },
    audit: [],
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.lastSavedAt = null;
    this.reload();
  }

  _read(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  reload() {
    let loaded = null;
    if (fs.existsSync(this.file)) {
      try {
        loaded = this._read(this.file);
      } catch (e) {
        const bak = this.file + '.bak';
        if (fs.existsSync(bak)) {
          loaded = this._read(bak); // main file damaged: fall back to the previous good copy
        } else {
          throw new Error('The data file is damaged and no backup copy was found: ' + this.file);
        }
      }
    }
    const base = freshData();
    if (loaded) {
      this.data = {
        ...base,
        ...loaded,
        settings: { ...base.settings, ...(loaded.settings || {}) },
        counters: { ...base.counters, ...(loaded.counters || {}) },
      };
    } else {
      this.data = base;
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    const json = JSON.stringify(this.data);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(tmp, this.file);
    this.lastSavedAt = new Date();
  }

  // Run a change and save it. User mistakes (validated before any change) leave memory alone;
  // any other failure reloads from disk so a half-finished change is never kept.
  run(fn) {
    try {
      const result = fn(this.data);
      this.save();
      return result;
    } catch (e) {
      if (!(e && e.userError)) this.reload();
      throw e;
    }
  }

  // Copy the data file into a folder (for example a USB drive), one file per day, newest 60 days kept.
  backupTo(dir, now = new Date()) {
    if (!dir) throw new Error('No backup folder is set.');
    if (!fs.existsSync(this.file)) this.save();
    fs.mkdirSync(dir, { recursive: true });
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const target = path.join(dir, `binsaad-${stamp}.json`);
    fs.copyFileSync(this.file, target);
    const old = fs.readdirSync(dir).filter((f) => /^binsaad-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (old.length > 60) fs.unlinkSync(path.join(dir, old.shift()));
    return target;
  }
}

module.exports = { Store, DEFAULT_SETTINGS, freshData };
