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
  assert.ok(first.includes('-Rs 400'));
  assert.ok(first.includes('Rs 3,600'));
  assert.ok(first.includes('TOTAL DUE'));
  assert.ok(first.includes('INVOICE:') && first.includes('BS-0001'));
  assert.ok(first.includes('SOLD TO:') && first.includes('Walk-in Customer'));
  assert.ok(first.includes('1 ITEM SOLD'));
  assert.ok(first.includes('Exchange possible within 3 days with receipt.'));
  assert.ok(!/@/.test(first.replace(/<style[\s\S]*?<\/style>/, ''))); // no email on the receipt
  assert.ok(first.includes('Change'));
  assert.ok(!first.includes('Imran')); // the customer's name is kept in the records but not printed
  assert.ok(!first.includes('Served by'));
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

// ---------- cost price and profit ----------
function profitCtx() {
  const ctx = setup();
  ctx.svc.saveSuit({ name: 'Plain Grey Suit', price: 1200, cost: 700 });
  ctx.svc.saveSuit({ name: 'No Cost Suit', price: 2000 });
  ctx.plain = ctx.svc.listSuits().find((x) => x.name === 'Plain Grey Suit');
  ctx.nocost = ctx.svc.listSuits().find((x) => x.name === 'No Cost Suit');
  return ctx;
}
const plainBill = (ctx, over = {}) => bill(ctx, { lines: [{ suitId: ctx.plain.id, qty: 1 }], received: 1200, ...over });

test('profit: cost 700 sold at 1200 gives 500; with a Rs. 200 discount it gives 300', () => {
  const ctx = profitCtx();
  const a = ctx.svc.createBill(plainBill(ctx)).bill;
  assert.deepEqual([a.total, a.costTotal, a.profit], [1200, 700, 500]);
  const b = ctx.svc.createBill(plainBill(ctx, { discount: { type: 'amt', value: 200 }, received: 1000 })).bill;
  assert.deepEqual([b.total, b.costTotal, b.profit], [1000, 700, 300]);
  const r = ctx.svc.profitReport();
  assert.deepEqual([r.sales, r.cost, r.profit, r.discounts, r.known, r.unknown], [2200, 1400, 800, 200, 2, 0]);
});

test('profit uses quantity and the percent discount', () => {
  const ctx = profitCtx();
  const b = ctx.svc.createBill(plainBill(ctx, { lines: [{ suitId: ctx.plain.id, qty: 3 }], discount: { type: 'pct', value: 10 }, received: 3240 })).bill;
  assert.deepEqual([b.subtotal, b.total, b.costTotal, b.profit], [3600, 3240, 2100, 1140]);
});

test('bills with a suit that has no cost are counted as unknown, not as zero cost', () => {
  const ctx = profitCtx();
  ctx.svc.createBill(plainBill(ctx));
  const u = ctx.svc.createBill(bill(ctx, { lines: [{ suitId: ctx.nocost.id, qty: 1 }], received: 2000 })).bill;
  assert.equal(u.profit, null);
  const r = ctx.svc.profitReport();
  assert.deepEqual([r.sales, r.profit, r.known, r.unknown], [1200, 500, 1, 1]);
  assert.ok(r.missingCost.includes('No Cost Suit'));
  assert.ok(!r.missingCost.includes('Plain Grey Suit'));
});

test('changing a suit cost later does not change the profit of old bills', () => {
  const ctx = profitCtx();
  const a = ctx.svc.createBill(plainBill(ctx)).bill;
  ctx.svc.saveSuit({ id: ctx.plain.id, name: 'Plain Grey Suit', price: 1200, cost: 900 });
  assert.equal(ctx.svc.getBill(a.id).profit, 500);
  assert.equal(ctx.svc.createBill(plainBill(ctx)).bill.profit, 300);
});

test('cancelled bills are not in the profit', () => {
  const ctx = profitCtx();
  const a = ctx.svc.createBill(plainBill(ctx)).bill;
  ctx.svc.createBill(plainBill(ctx));
  ctx.svc.cancelBill(a.id, 'wrong bill');
  assert.equal(ctx.svc.profitReport().profit, 500);
});

test('staff never see a suit cost or any profit; the owner does', () => {
  const ctx = profitCtx();
  const a = ctx.svc.createBill(plainBill(ctx)).bill;
  ctx.svc.saveUser({ username: 'staff1', name: 'Ali', role: 'staff', password: 'ali12345' });
  ctx.svc.logout();
  ctx.svc.login('staff1', 'ali12345');
  assert.ok(ctx.svc.listSuits({}).every((x) => !('cost' in x)));
  const seen = ctx.svc.getBill(a.id);
  assert.ok(!('profit' in seen) && !('costTotal' in seen) && seen.lines.every((l) => !('cost' in l)));
  const made = ctx.svc.createBill(plainBill(ctx)).bill;
  assert.ok(!('profit' in made) && made.lines.every((l) => !('cost' in l)));
  assert.ok(ctx.svc.searchBills({}).every((x) => !('profit' in x)));
  assert.throws(() => ctx.svc.profitReport(), /Only the owner/);
  ctx.svc.logout();
  ctx.svc.login('owner', 'owner1234');
  assert.equal(ctx.svc.getBill(a.id).profit, 500);
});

test('cost must be a whole number or empty; pasted lists can carry a cost', () => {
  const ctx = setup();
  assert.throws(() => ctx.svc.saveSuit({ name: 'X', price: 1000, cost: -5 }), /Cost must be/);
  assert.throws(() => ctx.svc.saveSuit({ name: 'X', price: 1000, cost: 10.5 }), /Cost must be/);
  assert.equal(ctx.svc.saveSuit({ name: 'X', price: 1000, cost: '' }).cost, null);
  assert.equal(ctx.svc.saveSuit({ name: 'Y', price: 1000, cost: '600' }).cost, 600);
  const { good } = parseSuitLines('Plain Suit, 4000, 2800\nCheck Suit, 3500, 2000, Check\nWhite Suit, 3800, Plain\nOld Suit 3000');
  assert.deepEqual(good.map((g) => [g.name, g.price, g.cost, g.group]), [
    ['Plain Suit', 4000, 2800, ''], ['Check Suit', 3500, 2000, 'Check'], ['White Suit', 3800, null, 'Plain'], ['Old Suit', 3000, null, ''],
  ]);
  ctx.svc.importSuits('Plain Suit, 4000, 2800');
  ctx.svc.importSuits('Plain Suit, 4100');
  assert.equal(ctx.svc.listSuits().find((x) => x.name === 'Plain Suit').cost, 2800); // a price-only line keeps the cost
});

// ---------- udhaar ----------
const credit = (ctx, over = {}) => bill(ctx, {
  lines: [{ suitId: ctx.suits['Navy Blue Suit'].id, qty: 1 }], credit: true, received: 1000,
  customerName: 'Imran Khan', customerPhone: '0300-1234567', ...over,
});

test('udhaar: Rs. 3000 bill, Rs. 1000 paid now, Rs. 2000 owed', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(credit(ctx, { lines: [{ suitId: ctx.suits['Navy Blue Suit'].id, qty: 1 }, { suitId: ctx.suits['Navy Blue Suit'].id, qty: 0 + 1 }], discount: { type: 'amt', value: 5000 } })).bill;
  assert.deepEqual([b.total, b.paid, b.due, b.change], [3000, 1000, 2000, 0]);
  const l = ctx.svc.listUdhaar();
  assert.equal(l.total, 2000);
  assert.deepEqual([l.customers[0].name, l.customers[0].balance], ['Imran Khan', 2000]);
});

test('udhaar needs a name and a phone, and the amount paid now must be less than the total', () => {
  const ctx = setup();
  assert.throws(() => ctx.svc.createBill(credit(ctx, { customerName: '' })), /customer name/);
  assert.throws(() => ctx.svc.createBill(credit(ctx, { customerPhone: '' })), /phone number/);
  assert.throws(() => ctx.svc.createBill(credit(ctx, { customerPhone: '123' })), /phone number/);
  assert.throws(() => ctx.svc.createBill(credit(ctx, { received: 4000 })), /paying the full amount/);
  assert.throws(() => ctx.svc.createBill(credit(ctx, { received: 5000 })), /paying the full amount/);
  assert.throws(() => ctx.svc.createBill(credit(ctx, { received: -5 })), /whole number/);
  assert.equal(ctx.svc.d.bills.length, 0);
});

test('udhaar with nothing paid now is recorded as Udhaar and adds nothing to money received', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(credit(ctx, { received: '' })).bill;
  assert.deepEqual([b.method, b.paid, b.due], ['Udhaar', 0, 4000]);
  const d = ctx.svc.dailyReport();
  assert.equal(d.sales, 4000);
  assert.equal(d.udhaarGiven, 4000);
  assert.deepEqual(d.byMethod, {});
});

test('paying back udhaar reduces the balance and cannot go past what is owed', () => {
  const ctx = setup();
  ctx.svc.createBill(credit(ctx)); // owes 3000
  const key = ctx.svc.listUdhaar().customers[0].key;
  const pay = (amount, extra = {}) => ctx.svc.receiveUdhaar({ uid: 'pay-' + Math.random().toString(36).slice(2) + '-xxxx', customerKey: key, amount, method: 'Cash', ...extra });
  assert.equal(pay(500).balance, 2500);
  assert.throws(() => pay(2501), /owes only Rs. 2500/);
  assert.throws(() => pay(0), /whole rupees/);
  assert.throws(() => pay(10.5), /whole rupees/);
  assert.throws(() => pay(100, { method: 'Cheque' }), /how the customer paid/);
  assert.equal(pay(2500).balance, 0);
  assert.equal(ctx.svc.listUdhaar().customers.length, 0);
  assert.throws(() => pay(1), /owes nothing/);
});

test('the same payment sent twice is recorded once', () => {
  const ctx = setup();
  ctx.svc.createBill(credit(ctx));
  const key = ctx.svc.listUdhaar().customers[0].key;
  const input = { uid: 'pay-one-0001', customerKey: key, amount: 1000, method: 'Cash' };
  ctx.svc.receiveUdhaar(input);
  const again = ctx.svc.receiveUdhaar(input);
  assert.equal(again.duplicate, true);
  assert.equal(ctx.svc.listUdhaar().total, 2000);
});

test('one customer with several bills and a phone written in different ways is one account', () => {
  const ctx = setup();
  ctx.svc.createBill(credit(ctx, { customerPhone: '0300-1234567', received: 3000 })); // owes 1000
  ctx.svc.createBill(credit(ctx, { customerPhone: '+92 300 1234567', customerName: 'Imran', received: 2000 })); // owes 2000
  const l = ctx.svc.listUdhaar();
  assert.equal(l.customers.length, 1);
  assert.equal(l.total, 3000);
  const c = ctx.svc.udhaarCustomer(l.customers[0].key);
  assert.equal(c.billList.length, 2);
  assert.equal(c.balance, 3000);
});

test('payment received later shows in the day report as money received but not as sales', () => {
  const ctx = setup();
  ctx.svc.createBill(credit(ctx)); // sales 4000, cash 1000 now
  ctx.clock.t = new Date(2026, 9, 27, 11, 0, 0);
  const key = ctx.svc.listUdhaar().customers[0].key;
  ctx.svc.receiveUdhaar({ uid: 'pay-day-0002', customerKey: key, amount: 700, method: 'JazzCash' });
  const d = ctx.svc.dailyReport();
  assert.deepEqual([d.sales, d.udhaarCollected, d.byMethod.JazzCash], [0, 700, 700]);
  const y = ctx.svc.dailyReport('2026-10-26');
  assert.deepEqual([y.sales, y.udhaarGiven, y.byMethod.Cash], [4000, 3000, 1000]);
});

test('a cancelled udhaar bill leaves the account, unless the customer already paid more than the other bills', () => {
  const ctx = setup();
  const a = ctx.svc.createBill(credit(ctx)).bill; // owes 3000
  ctx.svc.cancelBill(a.id, 'wrong bill');
  assert.equal(ctx.svc.listUdhaar().customers.length, 0);
  const b = ctx.svc.createBill(credit(ctx)).bill; // owes 3000 again
  const key = ctx.svc.listUdhaar().customers[0].key;
  ctx.svc.receiveUdhaar({ uid: 'pay-can-0003', customerKey: key, amount: 500, method: 'Cash' });
  assert.throws(() => ctx.svc.cancelBill(b.id, 'wrong bill'), /already paid back/);
});

test('only the owner can see or change udhaar accounts', () => {
  const ctx = setup();
  ctx.svc.createBill(credit(ctx));
  ctx.svc.saveUser({ username: 'staff1', name: 'Ali', role: 'staff', password: 'ali12345' });
  ctx.svc.logout();
  ctx.svc.login('staff1', 'ali12345');
  assert.throws(() => ctx.svc.listUdhaar(), /Only the owner/);
  assert.throws(() => ctx.svc.receiveUdhaar({ uid: 'pay-staff-0004', customerKey: '03001234567', amount: 1, method: 'Cash' }), /Only the owner/);
  // staff can still make an udhaar bill at the counter
  assert.equal(ctx.svc.createBill(credit(ctx)).bill.due, 3000);
});

test('the receipt never shows udhaar, the customer, or who served', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(credit(ctx)).bill;
  const html = buildReceiptHtml(b, ctx.svc.getSettings());
  for (const word of ['Imran', '0300', 'Udhaar', 'UDHAAR', 'Balance', 'BALANCE', 'Served', 'Paid now', 'Cash']) assert.ok(!html.includes(word), word);
  assert.ok(html.includes('Rs 4,000'));
});

test('old data without the new fields still loads and counts correctly', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(bill(ctx)).bill;
  delete ctx.svc.d.bills[0].paid;
  delete ctx.svc.d.bills[0].due;
  delete ctx.svc.d.payments;
  ctx.svc.d.payments = [];
  assert.equal(ctx.svc.dailyReport().byMethod.Cash, 4000);
  assert.equal(ctx.svc.listUdhaar().total, 0);
  assert.equal(ctx.svc.getBill(b.id).total, 4000);
});

// ---------- inventory (stock) ----------
const navyId = (ctx) => ctx.suits['Navy Blue Suit'].id;

test('stock: a counted suit goes down with each sale and the last one cannot be oversold', () => {
  const ctx = setup();
  ctx.svc.saveSuit({ id: navyId(ctx), name: 'Navy Blue Suit', price: 4000, stock: 3 });
  ctx.svc.createBill(bill(ctx, { lines: [{ suitId: navyId(ctx), qty: 2 }], received: 8000 }));
  assert.equal(ctx.svc.listSuits().find((x) => x.name === 'Navy Blue Suit').stock, 1);
  assert.throws(() => ctx.svc.createBill(bill(ctx, { lines: [{ suitId: navyId(ctx), qty: 2 }], received: 8000 })), /Only 1 of Navy Blue Suit left/);
  ctx.svc.createBill(bill(ctx));
  assert.throws(() => ctx.svc.createBill(bill(ctx)), /out of stock/);
  assert.equal(ctx.svc.d.bills.length, 2);
});

test('stock: a refused bill changes nothing, and a suit that is not counted is never refused', () => {
  const ctx = setup();
  ctx.svc.saveSuit({ id: navyId(ctx), name: 'Navy Blue Suit', price: 4000, stock: 1 });
  const two = [{ suitId: ctx.suits['Black Suit'].id, qty: 1 }, { suitId: navyId(ctx), qty: 2 }];
  assert.throws(() => ctx.svc.createBill(bill(ctx, { lines: two, received: 20000 })), /Only 1/);
  assert.equal(ctx.svc.d.counters.billNo, 0);
  assert.equal(ctx.svc.listSuits().find((x) => x.name === 'Navy Blue Suit').stock, 1);
  const black = ctx.svc.listSuits().find((x) => x.name === 'Black Suit');
  assert.equal(black.stock, null);
  assert.ok(ctx.svc.createBill(bill(ctx, { lines: [{ suitId: black.id, qty: 50 }], received: 225000 })).bill);
});

test('stock: cancelling a bill puts the suits back', () => {
  const ctx = setup();
  ctx.svc.saveSuit({ id: navyId(ctx), name: 'Navy Blue Suit', price: 4000, stock: 5 });
  const b = ctx.svc.createBill(bill(ctx, { lines: [{ suitId: navyId(ctx), qty: 2 }], received: 8000 })).bill;
  assert.equal(ctx.svc.listSuits().find((x) => x.name === 'Navy Blue Suit').stock, 3);
  ctx.svc.cancelBill(b.id, 'customer left');
  assert.equal(ctx.svc.listSuits().find((x) => x.name === 'Navy Blue Suit').stock, 5);
});

test('stock in adds to the count and every change is written in the log', () => {
  const ctx = setup();
  ctx.svc.addStock({ suitId: navyId(ctx), qty: 10, note: 'Delivery from the supplier' });
  ctx.svc.addStock({ suitId: navyId(ctx), qty: 5 });
  ctx.svc.createBill(bill(ctx));
  assert.equal(ctx.svc.listSuits().find((x) => x.name === 'Navy Blue Suit').stock, 14);
  const log = ctx.svc.listStockLog();
  assert.deepEqual(log.map((x) => [x.delta, x.balance]), [[-1, 14], [5, 15], [10, 10]]);
  assert.match(log[0].reason, /Sold on BS-0001/);
  assert.equal(log[2].reason, 'Delivery from the supplier');
  assert.throws(() => ctx.svc.addStock({ suitId: navyId(ctx), qty: 0 }), /whole number/);
  assert.throws(() => ctx.svc.addStock({ suitId: navyId(ctx), qty: 2.5 }), /whole number/);
  assert.throws(() => ctx.svc.addStock({ suitId: 99999, qty: 2 }), /not found/);
});

test('stock: a pasted count list sets counts and reports unknown names', () => {
  const ctx = setup();
  const r = ctx.svc.importStock('Navy Blue Suit, 12\nblack suit 7\nGhost Suit, 4\nnonsense line');
  assert.deepEqual([r.updated, r.unknown, r.skipped], [2, ['Ghost Suit'], ['nonsense line']]);
  const list = ctx.svc.listSuits();
  assert.equal(list.find((x) => x.name === 'Navy Blue Suit').stock, 12);
  assert.equal(list.find((x) => x.name === 'Black Suit').stock, 7);
});

test('stock: only the owner can add or change stock; staff still see the counts', () => {
  const ctx = setup();
  ctx.svc.addStock({ suitId: navyId(ctx), qty: 4 });
  ctx.svc.saveUser({ username: 'staff1', name: 'Ali', role: 'staff', password: 'ali12345' });
  ctx.svc.logout();
  ctx.svc.login('staff1', 'ali12345');
  assert.throws(() => ctx.svc.addStock({ suitId: navyId(ctx), qty: 1 }), /Only the owner/);
  assert.throws(() => ctx.svc.importStock('Navy Blue Suit, 1'), /Only the owner/);
  assert.throws(() => ctx.svc.listStockLog(), /Only the owner/);
  assert.equal(ctx.svc.listSuits().find((x) => x.name === 'Navy Blue Suit').stock, 4);
});

test('stock must be a whole number or empty', () => {
  const ctx = setup();
  assert.throws(() => ctx.svc.saveSuit({ name: 'X', price: 100, stock: -1 }), /Stock must be/);
  assert.throws(() => ctx.svc.saveSuit({ name: 'X', price: 100, stock: 1.5 }), /Stock must be/);
  assert.equal(ctx.svc.saveSuit({ name: 'Y', price: 100, stock: '' }).stock, null);
  assert.equal(ctx.svc.saveSuit({ name: 'Z', price: 100, stock: '8' }).stock, 8);
});

// ---------- invoice number ----------
test('every bill gets a short invoice number that never repeats, and it can be searched', () => {
  const ctx = setup();
  const a = ctx.svc.createBill(bill(ctx)).bill;
  const b = ctx.svc.createBill(bill(ctx)).bill;
  assert.deepEqual([a.invoice, b.invoice], ['BS-0001', 'BS-0002']);
  ctx.svc.saveSettings({ invoicePrefix: 'bsf' });
  const c = ctx.svc.createBill(bill(ctx)).bill;
  assert.equal(c.invoice, 'BSF-0003');
  assert.equal(ctx.svc.getBill(a.id).invoice, 'BS-0001'); // old bills keep theirs
  assert.deepEqual(ctx.svc.searchBills({ text: 'BS-0002' }).map((x) => x.no), [2]);
  assert.deepEqual(ctx.svc.searchBills({ text: '3' }).map((x) => x.no), [3]);
  assert.throws(() => ctx.svc.saveSettings({ invoicePrefix: 'TOOLONG' }), /up to 4/);
  assert.throws(() => ctx.svc.saveSettings({ invoicePrefix: 'B$' }), /up to 4/);
});

test('settings: exchange note, low stock level and receipt shift are checked', () => {
  const ctx = setup();
  assert.equal(ctx.svc.saveSettings({ exchangeNote: 'Exchange within 7 days' }).exchangeNote, 'Exchange within 7 days');
  assert.throws(() => ctx.svc.saveSettings({ lowStockAt: -1 }), /Low stock/);
  assert.throws(() => ctx.svc.saveSettings({ receiptOffsetMm: 11 }), /-10 to 10/);
  assert.throws(() => ctx.svc.saveSettings({ receiptOffsetMm: 1.5 }), /-10 to 10/);
  assert.equal(ctx.svc.saveSettings({ receiptOffsetMm: -2 }).receiptOffsetMm, -2);
});

// ---------- forgot password ----------
test('recovery code: made with the password, never stored as text, and usable while logged out', () => {
  const ctx = setup();
  assert.equal(ctx.svc.recoveryInfo().exists, false);
  assert.throws(() => ctx.svc.createRecoveryCode('wrong-pass'), /password is wrong/);
  const { code } = ctx.svc.createRecoveryCode('owner1234');
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.ok(!JSON.stringify(ctx.svc.d).includes(code.replace(/-/g, '')));
  ctx.svc.logout();
  assert.equal(ctx.svc.recoveryInfo().exists, true);
  assert.equal(ctx.svc.status().hasRecovery, true);
  const r = ctx.svc.resetWithRecovery(code.toLowerCase().replace(/-/g, ' '), 'brandnew9');
  assert.match(r.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.throws(() => ctx.svc.login('owner', 'owner1234'), /Wrong username or password/);
  assert.equal(ctx.svc.login('owner', 'brandnew9').role, 'owner');
});

test('recovery code: it works once, a new one is made, and the bills are untouched', () => {
  const ctx = setup();
  ctx.svc.createBill(bill(ctx));
  const { code } = ctx.svc.createRecoveryCode('owner1234');
  ctx.svc.logout();
  const next = ctx.svc.resetWithRecovery(code, 'second-pass').code;
  assert.notEqual(next, code);
  assert.throws(() => ctx.svc.resetWithRecovery(code, 'third-pass'), /not right/);
  assert.equal(ctx.svc.resetWithRecovery(next, 'third-pass').code.length, 19);
  ctx.svc.login('owner', 'third-pass');
  assert.equal(ctx.svc.searchBills({}).length, 1);
});

test('recovery code: wrong tries are counted and five in a row lock it for 15 minutes', () => {
  const ctx = setup();
  const { code } = ctx.svc.createRecoveryCode('owner1234');
  ctx.svc.logout();
  for (let i = 0; i < 5; i++) assert.throws(() => ctx.svc.resetWithRecovery('AAAA-AAAA-AAAA-AAAA', 'whatever1'), /not right/);
  assert.throws(() => ctx.svc.resetWithRecovery(code, 'whatever1'), /Too many wrong tries.*15 minutes/);
  ctx.clock.t = new Date(ctx.clock.t.getTime() + 16 * 60000);
  assert.ok(ctx.svc.resetWithRecovery(code, 'whatever1').code);
});

test('recovery code: needs a code to exist, a long enough new password, and is owner only to make', () => {
  const ctx = setup();
  ctx.svc.logout();
  assert.throws(() => ctx.svc.resetWithRecovery('AAAA-AAAA-AAAA-AAAA', 'whatever1'), /No recovery code was made/);
  ctx.svc.login('owner', 'owner1234');
  const { code } = ctx.svc.createRecoveryCode('owner1234');
  ctx.svc.saveUser({ username: 'staff1', name: 'Ali', role: 'staff', password: 'ali12345' });
  ctx.svc.logout();
  assert.throws(() => ctx.svc.resetWithRecovery(code, 'abc'), /at least 4/);
  ctx.svc.login('staff1', 'ali12345');
  assert.throws(() => ctx.svc.createRecoveryCode('ali12345'), /Only the owner/);
});

test('login accepts the username or the person\'s own name', () => {
  const ctx = setup();
  ctx.svc.logout();
  assert.equal(ctx.svc.login('Zakir', 'owner1234').role, 'owner');
  ctx.svc.logout();
  assert.equal(ctx.svc.login('  OWNER ', 'owner1234').role, 'owner');
  assert.throws(() => ctx.svc.login('nobody', 'owner1234'), /Wrong username/);
});

test('receipt: 58 mm is centred on the paper, and the shift setting moves it', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(bill(ctx)).bill;
  const set = (o) => ({ ...ctx.svc.getSettings(), ...o });
  const narrow = buildReceiptHtml(b, set({ paperWidthMm: 58 }));
  assert.ok(/body \{ box-sizing: border-box; width: 44mm; margin: 0 auto;/.test(narrow));
  assert.ok(/left: 0mm;/.test(narrow));
  assert.ok(/body \{ box-sizing: border-box; width: 68mm; margin: 0 auto;/.test(buildReceiptHtml(b, set({ paperWidthMm: 80 }))));
  assert.ok(/left: -2mm;/.test(buildReceiptHtml(b, set({ paperWidthMm: 58, receiptOffsetMm: -2 }))));
});

test('receipt: several of one suit show the price each; the item count is right', () => {
  const ctx = setup();
  const b = ctx.svc.createBill(bill(ctx, { lines: [{ suitId: ctx.suits['Navy Blue Suit'].id, qty: 3 }, { suitId: ctx.suits['Black Suit'].id, qty: 1 }], received: 16500 })).bill;
  const html = buildReceiptHtml(b, ctx.svc.getSettings());
  assert.ok(html.includes('4 ITEMS SOLD'));
  assert.ok(html.includes('Rs 4,000 each'));
  assert.ok(html.includes('Rs 12,000'));
  assert.ok(html.includes('Rs 16,500'));
});

// ---------- the day report (PDF page) ----------
const { buildDayReportHtml } = require('../src/core/report');
test('day report lists bills, totals, money by method and udhaar, and crosses out cancelled bills', () => {
  const ctx = setup();
  ctx.svc.createBill(bill(ctx, { discount: { type: 'pct', value: 10 }, received: 3600 }));
  const gone = ctx.svc.createBill(bill(ctx, { method: 'JazzCash', received: '' })).bill;
  ctx.svc.cancelBill(gone.id, 'wrong bill');
  ctx.svc.createBill(credit(ctx)); // 4000 bill, 1000 paid now
  const key = ctx.svc.listUdhaar().customers[0].key;
  ctx.svc.receiveUdhaar({ uid: 'pay-rep-0005', customerKey: key, amount: 500, method: 'Easypaisa' });
  const report = ctx.svc.dailyReport();
  const html = buildDayReportHtml(report, ctx.svc.searchBills({ from: report.dateKey, to: report.dateKey }), ctx.svc.getSettings());
  assert.ok(html.includes('BIN SAAD FABRICS') && html.includes('26-10-2026'));
  assert.ok(html.includes('BS-0001') && html.includes('BS-0003'));
  assert.ok(html.includes('class="x"') && html.includes('Cancelled'));
  assert.ok(html.includes('Rs 7,600')); // sales: 3600 + 4000, the cancelled bill is left out
  assert.ok(html.includes('Rs 3,000')); // udhaar given
  assert.ok(html.includes('Rs 500') && html.includes('Easypaisa'));
  assert.ok(html.includes('Rs 5,100')); // money received: 3600 cash + 1000 cash + 500 Easypaisa
  assert.ok(!html.includes('profit') && !html.includes('Profit') && !html.includes('cost'));
});

test('clearTestData removes bills, restores stock, keeps suits', () => {
  const ctx = profitCtx();
  const before = ctx.svc.listSuits().length;
  ctx.svc.createBill(plainBill(ctx));
  assert.throws(() => ctx.svc.clearTestData('wrong'), /wrong/);
  const r = ctx.svc.clearTestData(ctx.ownerPassword || 'owner1234');
  assert.equal(r.removed, 1);
  assert.equal(ctx.svc.searchBills({}).length, 0);
  assert.equal(ctx.svc.listSuits().length, before);
  const b = ctx.svc.createBill(plainBill(ctx));
  assert.match(String(b.bill.invoice), /0001$/);
});

test('sizes: each size is its own item; stock per size; dashboard and ledger work', () => {
  const ctx = profitCtx();
  const r = ctx.svc.saveSuitSizes({ base: 'Kurta Black', group: 'Kurtas', price: 3000, cost: 2000, sizes: { S: 2, M: 5, L: 3, XL: 1 } });
  assert.equal(r.added, 4);
  const items = ctx.svc.listSuits().filter((s) => s.name.startsWith('Kurta Black'));
  assert.equal(items.length, 4);
  const m = items.find((s) => s.name === 'Kurta Black (M)');
  assert.equal(m.stock, 5); assert.equal(m.size, 'M'); assert.equal(m.base, 'Kurta Black');
  ctx.svc.createBill(bill(ctx, { lines: [{ suitId: m.id, qty: 2 }], received: 6000 }));
  assert.equal(ctx.svc.listSuits().find((s) => s.id === m.id).stock, 3);
  const dsh = ctx.svc.dashboard();
  assert.equal(dsh.bills >= 1, true);
  const led = ctx.svc.ledger();
  assert.ok(led.stock.pieces > 0 && led.today >= 6000);
  assert.throws(() => ctx.svc.saveSuitSizes({ base: 'X', price: 100, sizes: {} }), /size/);
});

test('profit for a single day, by category; delete-by-date and the lock', () => {
  const ctx = profitCtx();
  ctx.svc.saveSuit({ name: 'Shawl A', price: 2000, cost: 1000, stock: 4, group: 'Shawls' });
  const sh = ctx.svc.listSuits().find((s) => s.name === 'Shawl A');
  const b = ctx.svc.createBill(bill(ctx, { lines: [{ suitId: sh.id, qty: 1 }], received: 2000 })).bill;
  const day = ctx.svc.profitReport(b.dateKey);
  assert.equal(day.isDay, true);
  assert.equal(day.byCategory.find((c) => c.name === 'Shawls').profit, 1000);
  assert.equal(ctx.svc.clearTestBefore('owner1234', '2000-01-01').removed, 0);
  assert.equal(ctx.svc.listSuits().find((s) => s.id === sh.id).stock, 3);
  assert.equal(ctx.svc.clearTestBefore('owner1234', '2999-01-01').removed >= 1, true);
  assert.equal(ctx.svc.listSuits().find((s) => s.id === sh.id).stock, 4);
  assert.throws(() => ctx.svc.startRealSales('wrong'), /wrong/);
  ctx.svc.startRealSales('owner1234');
  assert.throws(() => ctx.svc.clearTestData('owner1234'), /no longer/);
  assert.throws(() => ctx.svc.clearTestBefore('owner1234', '2999-01-01'), /no longer/);
});
