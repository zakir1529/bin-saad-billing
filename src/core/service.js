'use strict';

// All the shop's rules live here: logins, suits, bills, reports. The screens only ask; this decides.
const crypto = require('crypto');
const { UserError } = require('./errors');
const { computeTotals, percentOf, isRupees, MAX_PRICE } = require('./money');

const PUBLIC_METHODS = [
  'status', 'setupOwner', 'login', 'logout', 'getSettings', 'saveSettings',
  'listSuits', 'saveSuit', 'importSuits', 'createBill', 'getBill', 'searchBills', 'cancelBill',
  'dailyReport', 'monthlyReport', 'verifyPassword', 'listUsers', 'saveUser', 'changePassword', 'auditLog',
];

const pad2 = (n) => String(n).padStart(2, '0');
const clone = (o) => JSON.parse(JSON.stringify(o));

function dateKeyOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function checkPassword(user, password) {
  const given = Buffer.from(hashPassword(password, user.salt), 'hex');
  const real = Buffer.from(user.hash, 'hex');
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function newCredentials(password) {
  if (typeof password !== 'string' || password.length < 4) throw new UserError('Password must be at least 4 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function formatBillNo(n) {
  return String(n).padStart(4, '0');
}

// "Navy Blue Suit, 4000" | "Navy Blue Suit 4000" | "Navy Blue Suit, 4000, Plain" | tab/semicolon separated
function parseSuitLines(text) {
  const good = [];
  const bad = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
    if (!line) continue;
    let m = line.match(/^(.+?)\s*[,;\t]\s*(?:Rs\.?\s*)?(\d+)\s*(?:[,;\t]\s*(.+))?$/i);
    if (!m) m = line.match(/^(.+\S)\s+(?:Rs\.?\s*)?(\d+)()$/i);
    if (!m) {
      bad.push(raw.trim());
      continue;
    }
    const price = parseInt(m[2], 10);
    if (!price || price > MAX_PRICE) {
      bad.push(raw.trim());
      continue;
    }
    good.push({ name: m[1].trim(), price, group: (m[3] || '').trim() });
  }
  return { good, bad };
}

class Service {
  constructor({ store, now }) {
    this.store = store;
    this.now = now || (() => new Date());
    this.userId = null;
  }

  get d() {
    return this.store.data;
  }

  // Called by the screens. Only the listed methods are reachable.
  call(method, args) {
    if (!PUBLIC_METHODS.includes(method)) throw new UserError('Unknown action: ' + method);
    return this[method](...(args || []));
  }

  // ---------- who is logged in ----------
  _user() {
    return this.d.users.find((u) => u.id === this.userId && u.active) || null;
  }
  _requireUser() {
    const u = this._user();
    if (!u) throw new UserError('Please log in first.');
    return u;
  }
  _requireOwner() {
    const u = this._requireUser();
    if (u.role !== 'owner') throw new UserError('Only the owner can do this.');
    return u;
  }
  _pub(u) {
    return u ? { id: u.id, name: u.name, username: u.username, role: u.role } : null;
  }
  _audit(user, action, detail) {
    this.d.audit.push({ ts: this.now().toISOString(), user: user ? user.username : '-', action, detail: detail || '' });
    if (this.d.audit.length > 5000) this.d.audit.splice(0, this.d.audit.length - 5000);
  }

  status() {
    return {
      needsSetup: this.d.users.length === 0,
      user: this._pub(this._user()),
      shopName: this.d.settings.shopName,
    };
  }

  setupOwner({ name, password } = {}) {
    if (this.d.users.length > 0) throw new UserError('The owner account already exists.');
    const cred = newCredentials(password);
    const nm = String(name || '').trim() || 'Owner';
    return this.store.run((d) => {
      const user = { id: ++d.counters.id, username: 'owner', name: nm, role: 'owner', active: true, ...cred };
      d.users.push(user);
      this.userId = user.id;
      this._audit(user, 'setup', 'Owner account created');
      return this._pub(user);
    });
  }

  login(username, password) {
    const u = this.d.users.find((x) => x.active && x.username.toLowerCase() === String(username || '').trim().toLowerCase());
    if (!u || !checkPassword(u, password)) throw new UserError('Wrong username or password.');
    this.userId = u.id;
    return this._pub(u);
  }

  logout() {
    this.userId = null;
    return true;
  }

  // Re-check the logged-in user's password (used for the eye button and other confirmations).
  verifyPassword(password) {
    const u = this._requireUser();
    return checkPassword(u, password);
  }

  changePassword(oldPassword, newPassword) {
    const u = this._requireUser();
    if (!checkPassword(u, oldPassword)) throw new UserError('The current password is wrong.');
    const cred = newCredentials(newPassword);
    return this.store.run(() => {
      Object.assign(u, cred);
      this._audit(u, 'password', 'Password changed');
      return true;
    });
  }

  // ---------- settings ----------
  getSettings() {
    this._requireUser();
    return clone(this.d.settings);
  }

  saveSettings(patch = {}) {
    const u = this._requireOwner();
    const s = {};
    const text = (k, max) => {
      if (patch[k] !== undefined) s[k] = String(patch[k]).trim().slice(0, max);
    };
    text('shopName', 80); text('address', 160); text('phone', 40); text('whatsapp', 40); text('footer', 120);
    text('printerName', 200); text('backupDir', 400);
    if (patch.shopName !== undefined && !s.shopName) throw new UserError('Shop name cannot be empty.');
    if (patch.paperWidthMm !== undefined) {
      const w = Number(patch.paperWidthMm);
      if (w !== 58 && w !== 80) throw new UserError('Paper width must be 58 or 80 mm.');
      s.paperWidthMm = w;
    }
    if (patch.silentPrint !== undefined) s.silentPrint = !!patch.silentPrint;
    if (patch.revealNeedsPassword !== undefined) s.revealNeedsPassword = !!patch.revealNeedsPassword;
    if (patch.discountLimitPct !== undefined) {
      const v = Number(patch.discountLimitPct);
      if (!(v >= 0 && v <= 100)) throw new UserError('Discount limit must be between 0 and 100.');
      s.discountLimitPct = v;
    }
    if (patch.paymentMethods !== undefined) {
      const list = (Array.isArray(patch.paymentMethods) ? patch.paymentMethods : String(patch.paymentMethods).split(','))
        .map((x) => String(x).trim()).filter(Boolean);
      if (!list.length) throw new UserError('Add at least one payment method.');
      if (new Set(list.map((x) => x.toLowerCase())).size !== list.length) throw new UserError('Payment methods must be different from each other.');
      s.paymentMethods = list.slice(0, 8);
    }
    for (const k of ['logo', 'qr']) {
      if (patch[k] !== undefined) {
        const v = String(patch[k]);
        if (v && !/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(v)) throw new UserError('That image type is not supported.');
        if (v.length > 600000) throw new UserError('That image is too large. Please use a smaller one.');
        s[k] = v;
      }
    }
    return this.store.run((d) => {
      Object.assign(d.settings, s);
      this._audit(u, 'settings', Object.keys(s).filter((k) => k !== 'logo' && k !== 'qr').join(', '));
      return clone(d.settings);
    });
  }

  // ---------- users ----------
  listUsers() {
    this._requireOwner();
    return this.d.users.map((u) => ({ ...this._pub(u), active: u.active }));
  }

  saveUser(input = {}) {
    const me = this._requireOwner();
    const username = String(input.username || '').trim().toLowerCase();
    const name = String(input.name || '').trim();
    if (!/^[a-z0-9._-]{3,20}$/.test(username)) throw new UserError('Username must be 3 to 20 letters or numbers.');
    if (!name) throw new UserError('Enter the person\'s name.');
    const role = input.role === 'owner' ? 'owner' : 'staff';
    const existing = input.id ? this.d.users.find((u) => u.id === input.id) : null;
    if (input.id && !existing) throw new UserError('That user was not found.');
    if (this.d.users.some((u) => u.username === username && u !== existing)) throw new UserError('That username is already used.');
    const active = input.active !== false;
    if (existing && existing.role === 'owner' && (!active || role !== 'owner')) {
      const owners = this.d.users.filter((u) => u.role === 'owner' && u.active && u !== existing);
      if (!owners.length) throw new UserError('There must always be one active owner.');
    }
    let cred = null;
    if (!existing || input.password) cred = newCredentials(input.password);
    return this.store.run((d) => {
      let u = existing;
      if (!u) {
        u = { id: ++d.counters.id };
        d.users.push(u);
      }
      Object.assign(u, { username, name, role, active }, cred || {});
      this._audit(me, existing ? 'user-edit' : 'user-add', username);
      return { ...this._pub(u), active: u.active };
    });
  }

  // ---------- suits (the price list) ----------
  listSuits({ includeInactive } = {}) {
    const u = this._requireUser();
    const all = includeInactive && u.role === 'owner';
    return clone(this.d.suits.filter((s) => all || s.active)).sort((a, b) => a.name.localeCompare(b.name));
  }

  _checkSuit(input) {
    const name = String(input.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new UserError('Enter the suit name.');
    if (name.length > 80) throw new UserError('Suit name is too long.');
    const price = Number(input.price);
    if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw new UserError('Price must be a whole number of rupees, more than 0.');
    return { name, price, group: String(input.group || '').trim().slice(0, 30) };
  }

  saveSuit(input = {}) {
    const u = this._requireOwner();
    const v = this._checkSuit(input);
    const existing = input.id ? this.d.suits.find((s) => s.id === input.id) : null;
    if (input.id && !existing) throw new UserError('That suit was not found.');
    const clash = this.d.suits.find((s) => s.name.toLowerCase() === v.name.toLowerCase() && s !== existing);
    if (clash) throw new UserError('A suit with this name is already in the list.');
    return this.store.run((d) => {
      let s = existing;
      if (!s) {
        s = { id: ++d.counters.id, active: true };
        d.suits.push(s);
      }
      const before = existing ? `${s.name} ${s.price}` : '';
      Object.assign(s, v);
      if (input.active !== undefined) s.active = !!input.active;
      this._audit(u, existing ? 'suit-edit' : 'suit-add', `${before ? before + ' -> ' : ''}${s.name} ${s.price}${s.active ? '' : ' (off)'}`);
      return clone(s);
    });
  }

  // Add or update many suits from pasted text, one per line.
  importSuits(text) {
    const u = this._requireOwner();
    const { good, bad } = parseSuitLines(text);
    return this.store.run((d) => {
      let added = 0;
      let updated = 0;
      for (const item of good) {
        const s = d.suits.find((x) => x.name.toLowerCase() === item.name.toLowerCase());
        if (s) {
          s.price = item.price;
          if (item.group) s.group = item.group;
          s.active = true;
          updated++;
        } else {
          d.suits.push({ id: ++d.counters.id, name: item.name, price: item.price, group: item.group, active: true });
          added++;
        }
      }
      this._audit(u, 'suit-import', `${added} added, ${updated} updated`);
      return { added, updated, skipped: bad };
    });
  }

  // ---------- bills ----------
  createBill(input = {}) {
    const user = this._requireUser();
    const settings = this.d.settings;
    const uid = String(input.uid || '');
    if (uid.length < 8) throw new UserError('This bill has no reference number. Please start a new bill.');

    // Pressing Save twice (or a resend) must never make a second bill.
    const dup = this.d.bills.find((b) => b.uid === uid);
    if (dup) return { bill: clone(dup), duplicate: true };

    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new UserError('Add at least one suit to the bill.');
    if (input.lines.length > 100) throw new UserError('Too many lines on one bill.');

    // Prices always come from the price list, never from the screen.
    const merged = new Map();
    for (const l of input.lines) {
      const suit = this.d.suits.find((s) => s.id === l.suitId);
      if (!suit || !suit.active) throw new UserError('A suit on this bill is no longer in the price list.');
      const qty = Number(l.qty);
      if (!Number.isInteger(qty) || qty < 1) throw new UserError('Quantity must be a whole number, 1 or more.');
      const prev = merged.get(suit.id);
      merged.set(suit.id, { suit, qty: (prev ? prev.qty : 0) + qty });
    }
    const lines = [...merged.values()].map(({ suit, qty }) => ({ suitId: suit.id, name: suit.name, price: suit.price, qty }));
    const t = computeTotals(lines, input.discount);
    const lineRows = lines.map((l) => ({ ...l, amount: l.price * l.qty }));

    if (t.total < 1) throw new UserError('The total cannot be zero. Check the discount.');
    if (user.role !== 'owner' && t.subtotal > 0) {
      const pct = (t.discount * 100) / t.subtotal;
      if (pct > settings.discountLimitPct) {
        throw new UserError(`A discount above ${settings.discountLimitPct}% needs the owner.`);
      }
    }

    const method = String(input.method || '');
    if (!settings.paymentMethods.includes(method)) throw new UserError('Choose how the customer is paying.');
    const isCash = method.toLowerCase() === 'cash';
    let received = input.received === undefined || input.received === '' || input.received === null ? null : Number(input.received);
    if (received === null) {
      if (isCash) throw new UserError('Enter the amount received.');
      received = t.total;
    }
    if (!isRupees(received)) throw new UserError('Amount received must be a whole number of rupees.');
    if (received < t.total) throw new UserError('The amount received is less than the total.');
    if (!isCash && received !== t.total) throw new UserError('For ' + method + ' the amount received must equal the total.');
    const change = received - t.total;

    const customerName = String(input.customerName || '').trim().slice(0, 60);
    const customerPhone = String(input.customerPhone || '').trim().slice(0, 25);

    return this.store.run((d) => {
      const now = this.now();
      const no = ++d.counters.billNo;
      const bill = {
        id: ++d.counters.id,
        uid,
        no,
        createdAt: now.toISOString(),
        dateKey: dateKeyOf(now),
        cashier: user.name,
        customerName,
        customerPhone,
        lines: lineRows,
        subtotal: t.subtotal,
        discountType: t.discountType,
        discountValue: t.discountValue,
        discount: t.discount,
        total: t.total,
        method,
        received,
        change,
        status: 'paid',
        printCount: 0,
      };
      d.bills.push(bill);
      this._audit(user, 'bill', `#${formatBillNo(no)} total ${t.total}` + (t.discount ? ` discount ${t.discount}` : ''));
      return { bill: clone(bill), duplicate: false };
    });
  }

  getBill(id) {
    this._requireUser();
    const b = this.d.bills.find((x) => x.id === id);
    if (!b) throw new UserError('Bill not found.');
    return clone(b);
  }

  // Called by the printing code after a receipt really printed.
  markPrinted(id) {
    return this.store.run((d) => {
      const b = d.bills.find((x) => x.id === id);
      if (b) b.printCount = (b.printCount || 0) + 1;
      return b ? b.printCount : 0;
    });
  }

  cancelBill(id, reason) {
    const u = this._requireOwner();
    const b = this.d.bills.find((x) => x.id === id);
    if (!b) throw new UserError('Bill not found.');
    if (b.status === 'cancelled') throw new UserError('This bill is already cancelled.');
    const why = String(reason || '').trim();
    if (why.length < 3) throw new UserError('Write the reason for cancelling.');
    return this.store.run(() => {
      b.status = 'cancelled';
      b.cancelledAt = this.now().toISOString();
      b.cancelledBy = u.name;
      b.cancelReason = why.slice(0, 200);
      this._audit(u, 'cancel', `#${formatBillNo(b.no)} total ${b.total}: ${b.cancelReason}`);
      return clone(b);
    });
  }

  // { text, from, to, status, limit } -> newest first
  searchBills({ text, from, to, status, limit } = {}) {
    this._requireUser();
    const q = String(text || '').trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const max = Math.min(Number(limit) || 200, 500);
    const out = [];
    for (let i = this.d.bills.length - 1; i >= 0 && out.length < max; i--) {
      const b = this.d.bills[i];
      if (from && b.dateKey < from) continue;
      if (to && b.dateKey > to) continue;
      if (status && b.status !== status) continue;
      if (q) {
        const numeric = /^\d+$/.test(q);
        const hit =
          (numeric && b.no === parseInt(q, 10)) ||
          (digits.length >= 4 && (b.customerPhone || '').replace(/\D/g, '').includes(digits)) ||
          (b.customerName || '').toLowerCase().includes(q) ||
          b.lines.some((l) => l.name.toLowerCase().includes(q));
        if (!hit) continue;
      }
      out.push(clone(b));
    }
    return out;
  }

  // ---------- reports (owner only) ----------
  _sum(bills) {
    const byMethod = {};
    let sales = 0;
    let discounts = 0;
    for (const b of bills) {
      sales += b.total;
      discounts += b.discount;
      byMethod[b.method] = (byMethod[b.method] || 0) + b.total;
    }
    return { sales, bills: bills.length, discounts, byMethod };
  }

  dailyReport(dateKey) {
    this._requireOwner();
    const key = dateKey || dateKeyOf(this.now());
    const day = this.d.bills.filter((b) => b.dateKey === key);
    const paid = day.filter((b) => b.status === 'paid');
    return { dateKey: key, ...this._sum(paid), cancelled: day.length - paid.length };
  }

  monthlyReport(ym) {
    this._requireOwner();
    const now = this.now();
    const key = ym || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    if (!/^\d{4}-\d{2}$/.test(key)) throw new UserError('Pick a month.');
    const [y, m] = key.split('-').map(Number);
    const prevKey = m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
    const inMonth = (k) => this.d.bills.filter((b) => b.status === 'paid' && b.dateKey.startsWith(k + '-'));
    const bills = inMonth(key);
    const days = new Map();
    const suits = new Map();
    for (const b of bills) {
      const dd = days.get(b.dateKey) || { dateKey: b.dateKey, sales: 0, bills: 0 };
      dd.sales += b.total;
      dd.bills += 1;
      days.set(b.dateKey, dd);
      for (const l of b.lines) {
        const s = suits.get(l.name) || { name: l.name, qty: 0, amount: 0 };
        s.qty += l.qty;
        s.amount += l.amount;
        suits.set(l.name, s);
      }
    }
    const prev = this._sum(inMonth(prevKey));
    return {
      ym: key,
      ...this._sum(bills),
      byDay: [...days.values()].sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)),
      topSuits: [...suits.values()].sort((a, b) => b.qty - a.qty || b.amount - a.amount).slice(0, 10),
      prev: { ym: prevKey, sales: prev.sales, bills: prev.bills },
    };
  }

  auditLog(limit = 200) {
    this._requireOwner();
    return clone(this.d.audit.slice(-Math.min(Number(limit) || 200, 1000)).reverse());
  }
}

module.exports = { Service, parseSuitLines, formatBillNo, dateKeyOf, PUBLIC_METHODS };
