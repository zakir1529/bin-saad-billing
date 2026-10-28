'use strict';

// All the shop's rules live here: logins, suits, bills, reports. The screens only ask; this decides.
const crypto = require('crypto');
const { UserError } = require('./errors');
const { computeTotals, percentOf, isRupees, MAX_PRICE } = require('./money');

const PUBLIC_METHODS = [
  'status', 'setupOwner', 'login', 'logout', 'getSettings', 'saveSettings',
  'listSuits', 'saveSuit', 'importSuits', 'createBill', 'getBill', 'searchBills', 'cancelBill',
  'dailyReport', 'monthlyReport', 'verifyPassword', 'listUsers', 'saveUser', 'changePassword', 'auditLog',
  'profitReport', 'listUdhaar', 'udhaarCustomer', 'receiveUdhaar',
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

// A phone number as digits only, so 0300-1234567 and +92 300 1234567 are the same customer.
function phoneKey(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = '0' + d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2);
  return d;
}

// "Navy Blue Suit, 4000" | "Navy Blue Suit 4000" | "Navy Blue Suit, 4000, 2800" (second number = cost)
// | "Navy Blue Suit, 4000, Plain" (text = group) | "Navy Blue Suit, 4000, 2800, Plain"
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
    let cost = null;
    let group = (m[3] || '').trim();
    const c = group.match(/^(?:Rs\.?\s*)?(\d+)\s*(?:[,;\t]\s*(.*))?$/i);
    if (c) {
      cost = parseInt(c[1], 10);
      group = (c[2] || '').trim();
      if (cost > MAX_PRICE) {
        bad.push(raw.trim());
        continue;
      }
    }
    good.push({ name: m[1].trim(), price, cost, group });
  }
  return { good, bad };
}

const paidOf = (b) => (b.paid === undefined ? b.total : b.paid);
const dueOf = (b) => (b.due === undefined ? 0 : b.due);

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
  // What a bill looks like to the person asking: staff never see cost or profit.
  _view(b) {
    const c = clone(b);
    const u = this._user();
    if (!u || u.role !== 'owner') {
      delete c.costTotal;
      delete c.profit;
      for (const l of c.lines) delete l.cost;
    }
    return c;
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
    const list = clone(this.d.suits.filter((s) => all || s.active)).sort((a, b) => a.name.localeCompare(b.name));
    if (u.role !== 'owner') for (const s of list) delete s.cost; // staff never see what a suit costs the shop
    return list;
  }

  _checkSuit(input) {
    const name = String(input.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new UserError('Enter the suit name.');
    if (name.length > 80) throw new UserError('Suit name is too long.');
    const price = Number(input.price);
    if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw new UserError('Price must be a whole number of rupees, more than 0.');
    let cost = null;
    if (input.cost !== undefined && input.cost !== null && input.cost !== '') {
      cost = Number(input.cost);
      if (!Number.isInteger(cost) || cost < 0 || cost > MAX_PRICE) throw new UserError('Cost must be a whole number of rupees (or leave it empty).');
    }
    return { name, price, cost, group: String(input.group || '').trim().slice(0, 30) };
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
      const before = existing ? `${s.name} ${s.price}${s.cost === null || s.cost === undefined ? '' : ' cost ' + s.cost}` : '';
      Object.assign(s, v);
      if (input.active !== undefined) s.active = !!input.active;
      this._audit(u, existing ? 'suit-edit' : 'suit-add', `${before ? before + ' -> ' : ''}${s.name} ${s.price}${s.cost === null ? '' : ' cost ' + s.cost}${s.active ? '' : ' (off)'}`);
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
          if (item.cost !== null) s.cost = item.cost;
          if (item.group) s.group = item.group;
          s.active = true;
          updated++;
        } else {
          d.suits.push({ id: ++d.counters.id, name: item.name, price: item.price, cost: item.cost, group: item.group, active: true });
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
    if (dup) return { bill: this._view(dup), duplicate: true };

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
    const lines = [...merged.values()].map(({ suit, qty }) => ({
      suitId: suit.id, name: suit.name, price: suit.price, cost: suit.cost === undefined ? null : suit.cost, qty,
    }));
    const t = computeTotals(lines, input.discount);
    const lineRows = lines.map((l) => ({ ...l, amount: l.price * l.qty }));
    // The cost is copied onto the bill, so a later change to a suit's cost never rewrites old profit.
    const costKnown = lines.every((l) => l.cost !== null);
    const costTotal = costKnown ? lines.reduce((sum, l) => sum + l.cost * l.qty, 0) : null;

    if (t.total < 1) throw new UserError('The total cannot be zero. Check the discount.');
    if (user.role !== 'owner' && t.subtotal > 0) {
      const pct = (t.discount * 100) / t.subtotal;
      if (pct > settings.discountLimitPct) {
        throw new UserError(`A discount above ${settings.discountLimitPct}% needs the owner.`);
      }
    }

    const customerName = String(input.customerName || '').trim().slice(0, 60);
    const customerPhone = String(input.customerPhone || '').trim().slice(0, 25);

    let method = String(input.method || '');
    let received;
    let paid;
    let due = 0;
    let change = 0;
    const blank = input.received === undefined || input.received === '' || input.received === null;
    if (input.credit) {
      // Udhaar: the customer pays part (or nothing) now and owes the rest.
      if (!customerName) throw new UserError('Udhaar needs the customer name.');
      if (phoneKey(customerPhone).length < 7) throw new UserError('Udhaar needs the customer phone number.');
      paid = blank ? 0 : Number(input.received);
      if (!isRupees(paid)) throw new UserError('The amount paid now must be a whole number of rupees.');
      if (paid >= t.total) throw new UserError('The customer is paying the full amount. Turn off udhaar, or enter less than the total.');
      if (paid > 0 && !settings.paymentMethods.includes(method)) throw new UserError('Choose how the customer is paying.');
      if (paid === 0) method = 'Udhaar';
      received = paid;
      due = t.total - paid;
    } else {
      if (!settings.paymentMethods.includes(method)) throw new UserError('Choose how the customer is paying.');
      const isCash = method.toLowerCase() === 'cash';
      received = blank ? null : Number(input.received);
      if (received === null) {
        if (isCash) throw new UserError('Enter the amount received.');
        received = t.total;
      }
      if (!isRupees(received)) throw new UserError('Amount received must be a whole number of rupees.');
      if (received < t.total) throw new UserError('The amount received is less than the total.');
      if (!isCash && received !== t.total) throw new UserError('For ' + method + ' the amount received must equal the total.');
      change = received - t.total;
      paid = t.total;
    }

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
        customerKey: phoneKey(customerPhone),
        lines: lineRows,
        subtotal: t.subtotal,
        discountType: t.discountType,
        discountValue: t.discountValue,
        discount: t.discount,
        total: t.total,
        costTotal,
        profit: costTotal === null ? null : t.total - costTotal,
        method,
        received,
        change,
        paid,
        due,
        status: 'paid',
        printCount: 0,
      };
      d.bills.push(bill);
      this._audit(user, 'bill', `#${formatBillNo(no)} total ${t.total}` + (t.discount ? ` discount ${t.discount}` : '') + (due ? ` udhaar ${due} (${customerName})` : ''));
      return { bill: this._view(bill), duplicate: false };
    });
  }

  getBill(id) {
    this._requireUser();
    const b = this.d.bills.find((x) => x.id === id);
    if (!b) throw new UserError('Bill not found.');
    return this._view(b);
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
    if (dueOf(b) > 0 && this._balanceOf(b.customerKey) - dueOf(b) < 0) {
      throw new UserError('This customer has already paid back udhaar that includes this bill, so it cannot be cancelled. Ask the developer for help.');
    }
    return this.store.run(() => {
      b.status = 'cancelled';
      b.cancelledAt = this.now().toISOString();
      b.cancelledBy = u.name;
      b.cancelReason = why.slice(0, 200);
      this._audit(u, 'cancel', `#${formatBillNo(b.no)} total ${b.total}: ${b.cancelReason}`);
      return this._view(b);
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
      out.push(this._view(b));
    }
    return out;
  }

  // ---------- reports (owner only) ----------
  _sum(bills) {
    const byMethod = {};
    let sales = 0;
    let discounts = 0;
    let udhaarGiven = 0;
    for (const b of bills) {
      sales += b.total;
      discounts += b.discount;
      udhaarGiven += dueOf(b);
      if (paidOf(b) > 0) byMethod[b.method] = (byMethod[b.method] || 0) + paidOf(b);
    }
    return { sales, bills: bills.length, discounts, byMethod, udhaarGiven };
  }

  dailyReport(dateKey) {
    this._requireOwner();
    const key = dateKey || dateKeyOf(this.now());
    const day = this.d.bills.filter((b) => b.dateKey === key);
    const paid = day.filter((b) => b.status === 'paid');
    const sum = this._sum(paid);
    // Udhaar money that came in today counts as money received, though not as new sales.
    let udhaarCollected = 0;
    for (const p of this.d.payments) {
      if (p.dateKey !== key) continue;
      udhaarCollected += p.amount;
      sum.byMethod[p.method] = (sum.byMethod[p.method] || 0) + p.amount;
    }
    return { dateKey: key, ...sum, udhaarCollected, cancelled: day.length - paid.length };
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

  // ---------- profit (owner only) ----------
  // Profit = what the customer paid for the bill (after any discount) minus what the suits cost the shop.
  // A bill where some suit had no cost price entered is left out and counted as "unknown".
  _profitTotals(bills) {
    let sales = 0;
    let cost = 0;
    let discounts = 0;
    let known = 0;
    let unknown = 0;
    for (const b of bills) {
      if (b.costTotal === null || b.costTotal === undefined) {
        unknown++;
        continue;
      }
      known++;
      sales += b.total;
      cost += b.costTotal;
      discounts += b.discount;
    }
    return { sales, cost, profit: sales - cost, discounts, known, unknown };
  }

  profitReport(ym) {
    this._requireOwner();
    const now = this.now();
    const key = ym || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    if (!/^\d{4}-\d{2}$/.test(key)) throw new UserError('Pick a month.');
    const [y, m] = key.split('-').map(Number);
    const prevKey = m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
    const inMonth = (k) => this.d.bills.filter((b) => b.status === 'paid' && b.dateKey.startsWith(k + '-'));
    const bills = inMonth(key);
    const totals = this._profitTotals(bills);
    const days = new Map();
    const suits = new Map();
    for (const b of bills) {
      const dd = days.get(b.dateKey) || { dateKey: b.dateKey, bills: [] };
      dd.bills.push(b);
      days.set(b.dateKey, dd);
      if (b.costTotal === null || b.costTotal === undefined) continue;
      for (const l of b.lines) {
        const x = suits.get(l.name) || { name: l.name, qty: 0, sales: 0, cost: 0 };
        x.qty += l.qty;
        x.sales += l.amount;
        x.cost += l.cost * l.qty;
        suits.set(l.name, x);
      }
    }
    const byDay = [...days.values()]
      .map((dd) => ({ dateKey: dd.dateKey, ...this._profitTotals(dd.bills) }))
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
    const bySuit = [...suits.values()]
      .map((x) => ({ ...x, profit: x.sales - x.cost }))
      .sort((a, b) => b.profit - a.profit);
    const missingCost = this.d.suits.filter((x) => x.active && (x.cost === null || x.cost === undefined)).map((x) => x.name).sort();
    const prev = this._profitTotals(inMonth(prevKey));
    return { ym: key, ...totals, byDay, bySuit, missingCost, prev: { ym: prevKey, profit: prev.profit, known: prev.known } };
  }

  // ---------- udhaar (money customers still owe) ----------
  // A customer is identified by phone number. What they owe = every unpaid part of their bills minus what they paid back.
  _balanceOf(key) {
    if (!key) return 0;
    let owed = 0;
    for (const b of this.d.bills) if (b.status === 'paid' && b.customerKey === key) owed += dueOf(b);
    for (const p of this.d.payments) if (p.customerKey === key) owed -= p.amount;
    return owed;
  }

  _udhaarCustomers() {
    const map = new Map();
    const get = (key) => {
      if (!map.has(key)) map.set(key, { key, name: '', phone: '', owed: 0, paidBack: 0, lastAt: '', bills: 0 });
      return map.get(key);
    };
    for (const b of this.d.bills) {
      if (b.status !== 'paid' || dueOf(b) <= 0) continue;
      const c = get(b.customerKey);
      c.owed += dueOf(b);
      c.bills += 1;
      c.name = b.customerName || c.name;
      c.phone = b.customerPhone || c.phone;
      if (b.createdAt > c.lastAt) c.lastAt = b.createdAt;
    }
    for (const p of this.d.payments) {
      const c = map.get(p.customerKey);
      if (!c) continue;
      c.paidBack += p.amount;
      if (p.at > c.lastAt) c.lastAt = p.at;
    }
    for (const c of map.values()) c.balance = c.owed - c.paidBack;
    return map;
  }

  listUdhaar() {
    this._requireOwner();
    const all = [...this._udhaarCustomers().values()];
    const customers = all.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance);
    return { customers, total: customers.reduce((sum, c) => sum + c.balance, 0) };
  }

  udhaarCustomer(key) {
    this._requireOwner();
    const c = this._udhaarCustomers().get(String(key || ''));
    if (!c) throw new UserError('This customer has no udhaar.');
    const bills = this.d.bills
      .filter((b) => b.status === 'paid' && b.customerKey === c.key && dueOf(b) > 0)
      .map((b) => ({ id: b.id, no: b.no, createdAt: b.createdAt, total: b.total, paid: paidOf(b), due: dueOf(b) }));
    const payments = clone(this.d.payments.filter((p) => p.customerKey === c.key));
    return { ...c, billList: bills, payments };
  }

  receiveUdhaar(input = {}) {
    const u = this._requireOwner();
    const uid = String(input.uid || '');
    if (uid.length < 8) throw new UserError('This payment has no reference number. Please open the customer again.');
    const dup = this.d.payments.find((p) => p.uid === uid);
    if (dup) return { payment: clone(dup), balance: this._balanceOf(dup.customerKey), duplicate: true };
    const key = String(input.customerKey || '');
    const cust = this._udhaarCustomers().get(key);
    if (!cust || cust.balance <= 0) throw new UserError('This customer owes nothing.');
    const amount = Number(input.amount);
    if (!Number.isInteger(amount) || amount < 1) throw new UserError('Enter the amount received, in whole rupees.');
    if (amount > cust.balance) throw new UserError(`This customer owes only Rs. ${cust.balance}. Enter that or less.`);
    const method = String(input.method || '');
    if (!this.d.settings.paymentMethods.includes(method)) throw new UserError('Choose how the customer paid.');
    return this.store.run((d) => {
      const now = this.now();
      const payment = {
        id: ++d.counters.id,
        uid,
        customerKey: key,
        customerName: cust.name,
        amount,
        method,
        note: String(input.note || '').trim().slice(0, 100),
        at: now.toISOString(),
        dateKey: dateKeyOf(now),
        by: u.name,
      };
      d.payments.push(payment);
      this._audit(u, 'udhaar-payment', `${cust.name} ${cust.phone}: ${amount} by ${method}`);
      return { payment: clone(payment), balance: cust.balance - amount, duplicate: false };
    });
  }

  auditLog(limit = 200) {
    this._requireOwner();
    return clone(this.d.audit.slice(-Math.min(Number(limit) || 200, 1000)).reverse());
  }
}

module.exports = { Service, parseSuitLines, formatBillNo, dateKeyOf, PUBLIC_METHODS };
