'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { percentOf, computeTotals, fmt } = require('../src/core/money');
const { Store } = require('../src/core/store');
const { Service, parseSuitLines } = require('../src/core/service');
const { buildReceiptHtml } = require('../src/core/receipt');

function setup(startDate = new Date(2026, 9, 26, 13, 0, 0)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-test-'));
  const clock = { t: startDate };
  const store = new Store(path.join(dir, 'data.json'));
  const svc = new Service({ store, now: () => clock.t });
  svc.setupOwner({ name: 'Zakir', password: 'owner1234' });
  svc.importSuits('Navy Blue Suit, 4000\nBlack Suit, 4500\nBottle Green Suit 5200');
  const suits = {};
  for (const s of svc.listSuits()) suits[s.name] = s;
  return { dir, clock, store, svc, suits };
}

const bill = (ctx, over = {}) => ({
  uid: 'uid-' + Math.random().toString(36).slice(2) + '-xxxx',
  lines: [{ suitId: ctx.suits['Navy Blue Suit'].id, qty: 1 }],
  discount: { type: 'none' },
  method: 'Cash',
  received: 4000,
  ...over,
});

// ---------- money ----------
test('10% of 4000 is exactly 400 and the total is 3600', () => {
  assert.equal(percentOf(4000, 10), 400);
  const t = computeTotals([{ price: 4000, qty: 1 }], { type: 'pct', value: 10 });
  assert.deepEqual([t.subtotal, t.discount, t.total], [4000, 400, 3600]);
});

test('percent discount rounds to the nearest rupee, half up', () => {
  assert.equal(percentOf(4005, 10), 401); // 400.5
  assert.equal(percentOf(4004, 10), 400); // 400.4
  assert.equal(percentOf(4006, 10), 401); // 400.6
  assert.equal(percentOf(1, 50), 1);
  assert.equal(percentOf(9999, 7.5), 750); // 749.925
  assert.equal(percentOf(4000, 100), 4000);
  assert.equal(percentOf(4000, 0), 0);
});

test('percent outside 0-100 is refused', () => {
  assert.throws(() => percentOf(4000, 101), /between 0 and 100/);
  assert.throws(() => percentOf(4000, -1), /between 0 and 100/);
  assert.throws(() => percentOf(4000, 'abc'), /between 0 and 100/);
});

test('rupee discount must be whole and not above the bill', () => {
  assert.equal(computeTotals([{ price: 4000, qty: 2 }], { type: 'amt', value: 500 }).total, 7500);
  assert.throws(() => computeTotals([{ price: 4000, qty: 1 }], { type: 'amt', value: 4001 }), /more than the bill/);
  assert.throws(() => computeTotals([{ price: 4000, qty: 1 }], { type: 'amt', value: 10.5 }), /whole number/);
});

test('every total over many combinations matches plain integer arithmetic', () => {
  for (let price = 1000; price <= 9000; price += 337) {
    for (let qty = 1; qty <= 6; qty++) {
      for (const pct of [0, 1, 5, 7.5, 10, 12.5, 15, 33.33]) {
        const t = computeTotals([{ price, qty }], { type: 'pct', value: pct });
        const exact = Math.floor((price * qty * Math.round(pct * 100) * 2 + 10000) / 20000);
        assert.equal(t.discount, exact);
        assert.equal(t.total + t.discount, price * qty);
        assert.ok(Number.isInteger(t.total));
      }
    }
  }
});

test('money is formatted with thousands separators', () => {
  assert.equal(fmt(4000), '4,000');
  assert.equal(fmt(1234567), '1,234,567');
  assert.equal(fmt(0), '0');
});

// ---------- store ----------
test('a damaged data file falls back to the previous good copy', () => {
  const ctx = setup();
  ctx.svc.createBill(bill(ctx));
  ctx.svc.createBill(bill(ctx));
  fs.writeFileSync(ctx.store.file, '{ broken json');
  const reopened = new Store(ctx.store.file);
  assert.ok(reopened.data.bills.length >= 1); // the .bak copy is one save behind at most
});

test('a failed save does not leave the bill in memory', () => {
  const ctx = setup();
  const before = ctx.store.data.bills.length;
  const realSave = ctx.store.save.bind(ctx.store);
  ctx.store.save = () => { throw new Error('disk full'); };
  assert.throws(() => ctx.svc.createBill(bill(ctx)), /disk full/);
  ctx.store.save = realSave;
  assert.equal(ctx.store.data.bills.length, before);
  assert.equal(ctx.store.data.counters.billNo, before); // the bill number is not burned either
});

test('backup copies the data file once a day and keeps 60 days', () => {
  const ctx = setup();
  const out = path.join(ctx.dir, 'usb');
  for (let i = 0; i < 65; i++) ctx.store.backupTo(out, new Date(2026, 0, 1 + i));
  const files = fs.readdirSync(out).sort();
  assert.equal(files.length, 60);
  assert.equal(files[0], 'binsaad-2026-01-06.json');
  JSON.parse(fs.readFileSync(path.join(out, files[59]), 'utf8'));
});

// ---------- logins ----------
test('login works only with the right password and the first setup runs once', () => {
  const ctx = setup();
  ctx.svc.logout();
  assert.throws(() => ctx.svc.login('owner', 'wrong'), /Wrong username or password/);
  assert.equal(ctx.svc.login('OWNER', 'owner1234').role, 'owner');
  assert.throws(() => ctx.svc.setupOwner({ password: 'abcd' }), /already exists/);
  assert.equal(ctx.svc.verifyPassword('owner1234'), true);
  assert.equal(ctx.svc.verifyPassword('nope'), false);
});

test('nothing works before logging in', () => {
  const ctx = setup();
  ctx.svc.logout();
  assert.throws(() => ctx.svc.listSuits(), /log in/);
  assert.throws(() => ctx.svc.createBill(bill(ctx)), /log in/);
});

test('passwords are not stored in plain text', () => {
  const ctx = setup();
  assert.ok(!fs.readFileSync(ctx.store.file, 'utf8').includes('owner1234'));
});

// ---------- billing ----------
test('a bill is saved with the right totals and a running number', () => {
  const ctx = setup();
  const a = ctx.svc.createBill(bill(ctx, { discount: { type: 'pct', value: 10 }, received: 4000 })).bill;
  assert.deepEqual([a.no, a.subtotal, a.discount, a.total, a.change], [1, 4000, 400, 3600, 400]);
  const b = ctx.svc.createBill(bill(ctx)).bill;
  assert.equal(b.no, 2);
});

test('the same bill pressed twice never makes two bills', () => {
  const ctx = setup();
  const payload = bill(ctx);
  const first = ctx.svc.createBill(payload);
  const second = ctx.svc.createBill(payload);
  assert.equal(second.duplicate, true);
  assert.equal(second.bill.no, first.bill.no);
  assert.equal(ctx.store.data.bills.length, 1);
});

test('prices come from the price list, not from the screen', () => {
  const ctx = setup();
  const payload = bill(ctx);
  payload.lines[0].price = 1; // a tampered price is ignored
  const b = ctx.svc.createBill(payload).bill;
  assert.equal(b.lines[0].price, 4000);
  assert.equal(b.total, 4000);
});

test('same suit added twice becomes one line with the combined quantity', () => {
  const ctx = setup();
  const id = ctx.suits['Black Suit'].id;
  const b = ctx.svc.createBill(bill(ctx, { lines: [{ suitId: id, qty: 1 }, { suitId: id, qty: 2 }], received: 13500 })).bill;
  assert.equal(b.lines.length, 1);
  assert.deepEqual([b.lines[0].qty, b.total], [3, 13500]);
});

test('several suits are added up correctly', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(bill(ctx, {
    lines: [
      { suitId: ctx.suits['Navy Blue Suit'].id, qty: 1 },
      { suitId: ctx.suits['Black Suit'].id, qty: 2 },
      { suitId: ctx.suits['Bottle Green Suit'].id, qty: 1 },
    ],
    discount: { type: 'amt', value: 600 },
    received: 20000,
  })).bill;
  assert.deepEqual([b.subtotal, b.discount, b.total, b.change], [18200, 600, 17600, 2400]);
});

test('payment rules: cash must cover the total, wallets must match it exactly', () => {
  const ctx = setup();
  assert.throws(() => ctx.svc.createBill(bill(ctx, { received: 3999 })), /less than the total/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { received: '' })), /Enter the amount received/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { received: 4000.5 })), /whole number/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { method: 'JazzCash', received: 4500 })), /must equal the total/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { method: 'Cheque' })), /how the customer is paying/);
  const ok = ctx.svc.createBill(bill(ctx, { method: 'JazzCash', received: '' })).bill;
  assert.deepEqual([ok.received, ok.change], [4000, 0]);
  assert.equal(ctx.store.data.bills.length, 1); // refused bills were never saved
  assert.equal(ctx.store.data.counters.billNo, 1);
});

test('empty bills, zero totals and bad quantities are refused', () => {
  const ctx = setup();
  assert.throws(() => ctx.svc.createBill(bill(ctx, { lines: [] })), /at least one suit/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { discount: { type: 'pct', value: 100 } })), /cannot be zero/);
  const id = ctx.suits['Navy Blue Suit'].id;
  assert.throws(() => ctx.svc.createBill(bill(ctx, { lines: [{ suitId: id, qty: 0 }] })), /whole number/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { lines: [{ suitId: id, qty: 1.5 }] })), /whole number/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { lines: [{ suitId: 99999, qty: 1 }] })), /no longer in the price list/);
});

test('staff cannot go above the discount limit, the owner can', () => {
  const ctx = setup();
  ctx.svc.saveUser({ username: 'staff1', name: 'Ali', role: 'staff', password: 'ali12345' });
  ctx.svc.logout();
  ctx.svc.login('staff1', 'ali12345');
  assert.throws(() => ctx.svc.createBill(bill(ctx, { discount: { type: 'pct', value: 20 } })), /needs the owner/);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { discount: { type: 'amt', value: 700 } })), /needs the owner/); // 17.5%
  assert.equal(ctx.svc.createBill(bill(ctx, { discount: { type: 'pct', value: 15 }, received: 4000 })).bill.total, 3400);
  ctx.svc.logout();
  ctx.svc.login('owner', 'owner1234');
  assert.equal(ctx.svc.createBill(bill(ctx, { discount: { type: 'pct', value: 20 } })).bill.total, 3200);
});

test('price changes and switched-off suits do not touch printed bills', () => {
  const ctx = setup();
  const before = ctx.svc.createBill(bill(ctx)).bill;
  ctx.svc.saveSuit({ id: ctx.suits['Navy Blue Suit'].id, name: 'Navy Blue Suit', price: 5000, group: '' });
  assert.equal(ctx.svc.getBill(before.id).total, 4000);
  assert.equal(ctx.svc.createBill(bill(ctx, { received: 5000 })).bill.total, 5000);
  ctx.svc.saveSuit({ id: ctx.suits['Black Suit'].id, name: 'Black Suit', price: 4500, active: false });
  assert.throws(() => ctx.svc.createBill(bill(ctx, { lines: [{ suitId: ctx.suits['Black Suit'].id, qty: 1 }] })), /no longer/);
});

test('cancelling needs the owner and a reason, and cancelled bills drop out of sales', () => {
  const ctx = setup();
  const a = ctx.svc.createBill(bill(ctx)).bill;
  const b = ctx.svc.createBill(bill(ctx, { lines: [{ suitId: ctx.suits['Black Suit'].id, qty: 1 }], received: 4500 })).bill;
  assert.throws(() => ctx.svc.cancelBill(a.id, ''), /reason/);
  ctx.svc.cancelBill(a.id, 'Wrong suit entered');
  assert.throws(() => ctx.svc.cancelBill(a.id, 'again'), /already cancelled/);
  const day = ctx.svc.dailyReport();
  assert.deepEqual([day.sales, day.bills, day.cancelled], [4500, 1, 1]);
  assert.equal(ctx.svc.getBill(a.id).status, 'cancelled');
  ctx.svc.saveUser({ username: 'staff1', name: 'Ali', role: 'staff', password: 'ali12345' });
  ctx.svc.logout();
  ctx.svc.login('staff1', 'ali12345');
  assert.throws(() => ctx.svc.cancelBill(b.id, 'staff trying'), /Only the owner/);
  assert.throws(() => ctx.svc.dailyReport(), /Only the owner/);
  assert.throws(() => ctx.svc.saveSuit({ name: 'X', price: 1 }), /Only the owner/);
});

test('bill numbers never repeat, even after cancelling', () => {
  const ctx = setup();
  const nos = [];
  for (let i = 0; i < 5; i++) {
    const r = ctx.svc.createBill(bill(ctx)).bill;
    nos.push(r.no);
    if (i === 2) ctx.svc.cancelBill(r.id, 'mistake');
  }
  assert.deepEqual(nos, [1, 2, 3, 4, 5]);
});

test('reprint counter starts at zero and counts prints', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(bill(ctx)).bill;
  assert.equal(b.printCount, 0);
  ctx.svc.markPrinted(b.id);
  assert.equal(ctx.svc.getBill(b.id).printCount, 1);
});

// ---------- search ----------
test('old bills can be found by number, customer, phone, suit and date', () => {
  const ctx = setup();
  ctx.clock.t = new Date(2026, 8, 20, 11, 0);
  const old = ctx.svc.createBill(bill(ctx, { customerName: 'Imran Khan', customerPhone: '0300-1234567', lines: [{ suitId: ctx.suits['Black Suit'].id, qty: 1 }], received: 4500 })).bill;
  ctx.clock.t = new Date(2026, 9, 26, 13, 0);
  ctx.svc.createBill(bill(ctx));
  assert.equal(ctx.svc.searchBills({ text: '1' })[0].id, old.id);
  assert.equal(ctx.svc.searchBills({ text: '0001' })[0].id, old.id);
  assert.equal(ctx.svc.searchBills({ text: 'imran' }).length, 1);
  assert.equal(ctx.svc.searchBills({ text: '1234567' }).length, 1);
  assert.equal(ctx.svc.searchBills({ text: 'black' }).length, 1);
  assert.equal(ctx.svc.searchBills({ from: '2026-09-01', to: '2026-09-30' }).length, 1);
  assert.equal(ctx.svc.searchBills({}).length, 2);
  assert.equal(ctx.svc.searchBills({})[0].no, 2); // newest first
});

// ---------- reports ----------
test('daily and monthly sales, this month against last month', () => {
  const ctx = setup();
  const sell = (when, name, qty, total) => {
    ctx.clock.t = when;
    ctx.svc.createBill(bill(ctx, { lines: [{ suitId: ctx.suits[name].id, qty }], received: total }));
  };
  sell(new Date(2026, 8, 5, 10, 0), 'Navy Blue Suit', 1, 4000); // September
  sell(new Date(2026, 8, 6, 10, 0), 'Black Suit', 2, 9000); // September
  sell(new Date(2026, 9, 25, 10, 0), 'Navy Blue Suit', 1, 4000); // October
  sell(new Date(2026, 9, 26, 10, 0), 'Black Suit', 1, 4500); // October, today
  sell(new Date(2026, 9, 26, 15, 30), 'Navy Blue Suit', 2, 8000); // October, today
  ctx.clock.t = new Date(2026, 9, 26, 18, 0);
  const day = ctx.svc.dailyReport();
  assert.deepEqual([day.sales, day.bills], [12500, 2]);
  assert.equal(day.byMethod.Cash, 12500);
  const m = ctx.svc.monthlyReport();
  assert.deepEqual([m.ym, m.sales, m.bills], ['2026-10', 16500, 3]);
  assert.deepEqual(m.prev, { ym: '2026-09', sales: 13000, bills: 2 });
  assert.equal(m.byDay.length, 2);
  assert.equal(m.topSuits[0].name, 'Navy Blue Suit');
  assert.equal(m.topSuits[0].qty, 3);
  assert.equal(ctx.svc.monthlyReport('2026-01').prev.ym, '2025-12');
});

test('a bill made late at night counts on the day it was made (shop clock)', () => {
  const ctx = setup();
  ctx.clock.t = new Date(2026, 9, 26, 23, 50);
  ctx.svc.createBill(bill(ctx));
  assert.equal(ctx.svc.dailyReport('2026-10-26').bills, 1);
  assert.equal(ctx.svc.dailyReport('2026-10-27').bills, 0);
});

// ---------- suit list ----------
test('pasted suit lists are read in common formats', () => {
  const r = parseSuitLines('Navy Blue Suit, 4000\nBlack Suit 4,500\nRose Suit - skip me\nWhite Suit;3800;Plain\nGrey\t4100\n\nBad line\nZero Suit, 0');
  assert.deepEqual(r.good.map((g) => [g.name, g.price, g.group]), [
    ['Navy Blue Suit', 4000, ''],
    ['Black Suit', 4500, ''],
    ['White Suit', 3800, 'Plain'],
    ['Grey', 4100, ''],
  ]);
  assert.deepEqual(r.bad, ['Rose Suit - skip me', 'Bad line', 'Zero Suit, 0']);
});

test('importing again updates prices instead of adding duplicates', () => {
  const ctx = setup();
  const r = ctx.svc.importSuits('Navy Blue Suit, 4200\nNew Suit, 3000');
  assert.deepEqual([r.added, r.updated], [1, 1]);
  assert.equal(ctx.svc.listSuits().filter((s) => s.name === 'Navy Blue Suit').length, 1);
  assert.equal(ctx.svc.listSuits().find((s) => s.name === 'Navy Blue Suit').price, 4200);
});

test('the last owner cannot be switched off', () => {
  const ctx = setup();
  const owner = ctx.svc.listUsers()[0];
  assert.throws(() => ctx.svc.saveUser({ id: owner.id, username: 'owner', name: 'Owner', role: 'owner', active: false }), /one active owner/);
  assert.throws(() => ctx.svc.saveUser({ id: owner.id, username: 'owner', name: 'Owner', role: 'staff' }), /one active owner/);
});

test('settings: validation and the paper width', () => {
  const ctx = setup();
  assert.throws(() => ctx.svc.saveSettings({ paperWidthMm: 70 }), /58 or 80/);
  assert.throws(() => ctx.svc.saveSettings({ shopName: '  ' }), /cannot be empty/);
  assert.throws(() => ctx.svc.saveSettings({ logo: 'http://x/y.png' }), /not supported/);
  const s = ctx.svc.saveSettings({ address: 'Haripur', paymentMethods: 'Cash, JazzCash' });
  assert.deepEqual(s.paymentMethods, ['Cash', 'JazzCash']);
  assert.equal(s.address, 'Haripur');
});

test('only listed actions can be called by the screens', () => {
  const ctx = setup();
  assert.throws(() => ctx.svc.call('markPrinted', [1]), /Unknown action/);
  assert.throws(() => ctx.svc.call('store', []), /Unknown action/);
  assert.ok(Array.isArray(ctx.svc.call('listSuits', [{}])));
});

// ---------- receipt ----------
test('receipt shows the discount line under the items, and DUPLICATE only on reprints', () => {
  const ctx = setup();
  ctx.svc.saveSettings({ address: 'Darwesh, Haripur', phone: '0300-0000000' });
  const b = ctx.svc.createBill(bill(ctx, { discount: { type: 'pct', value: 10 }, received: 4000, customerName: 'Imran' })).bill;
  const settings = ctx.svc.getSettings();
  const first = buildReceiptHtml(b, settings, { duplicate: false });
  assert.ok(first.includes('BIN SAAD FABRICS'));
  assert.ok(first.includes('Navy Blue Suit'));
  assert.ok(first.includes('Discount (10%)'));
  assert.ok(first.includes('-400'));
  assert.ok(first.includes('Rs. 3,600'));
  assert.ok(first.includes('Change'));
  assert.ok(first.includes('Imran'));
  assert.ok(!first.includes('DUPLICATE</div>'));
  assert.ok(buildReceiptHtml(b, settings, { duplicate: true }).includes('DUPLICATE</div>'));
});

test('receipt escapes names so odd characters cannot break the page', () => {
  const ctx = setup();
  ctx.svc.saveSuit({ name: '<b>Evil</b> & Co "Suit"', price: 1000 });
  const s = ctx.svc.listSuits().find((x) => x.name.includes('Evil'));
  const b = ctx.svc.createBill(bill(ctx, { lines: [{ suitId: s.id, qty: 1 }], received: 1000 })).bill;
  const html = buildReceiptHtml(b, ctx.svc.getSettings());
  assert.ok(!html.includes('<b>Evil</b>'));
  assert.ok(html.includes('&lt;b&gt;Evil&lt;/b&gt; &amp; Co &quot;Suit&quot;'));
});

test('wallet payments show no change lines; cash shows received and change', () => {
  const ctx = setup();
  const w = ctx.svc.createBill(bill(ctx, { method: 'JazzCash', received: '' })).bill;
  const c = ctx.svc.createBill(bill(ctx, { received: 5000 })).bill;
  assert.ok(!buildReceiptHtml(w, ctx.svc.getSettings()).includes('Change'));
  assert.ok(buildReceiptHtml(c, ctx.svc.getSettings()).includes('Change'));
});
