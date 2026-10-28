'use strict';
// Drives the real screens in a browser against the harness and checks what a shop owner would see.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8765';
const OUT = process.env.SHOTS || '/tmp/bs-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok, extra: ok ? '' : extra || '' }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + (extra || ''))); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  const text = async (sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ');
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
  const state = async () => (await fetch(BASE + '/__state')).json();
  const nav = async (v) => { await page.click(`[data-act=nav][data-view=${v}]`); await page.waitForTimeout(150); };

  await page.goto(BASE);
  await page.waitForSelector('#l-name');
  await shot('01-first-setup');

  // first-run set-up with a wrong confirmation, then the right one
  await page.fill('#l-name', 'Zakir'); await page.fill('#l-pw', 'owner1234'); await page.fill('#l-pw2', 'different');
  await page.click('[data-act=setup]');
  check('set-up refuses two different passwords', (await text('.err')).includes('not the same'));
  await page.fill('#l-pw2', 'owner1234'); await page.click('[data-act=setup]');
  await page.waitForSelector('.shell');
  check('owner is logged in after set-up', (await text('.nav .who')).includes('Owner'));

  // price list: paste a list
  await nav('prices');
  await page.click('[data-act=pasteList]');
  await page.fill('#m-paste', 'Navy Blue Suit, 4000, Plain\nBlack Suit, 4000, Plain\nBottle Green Suit, 4200, Plain\nMaroon Suit, 4200, Plain\nRose Printed Suit, 4800, Printed\nSky Blue Printed Suit 4800\nbroken line without price');
  await page.click('[data-act=modalOk]');
  await page.waitForSelector('.pill.ok');
  const pasteMsg = await text('.dialog');
  check('paste list: 6 added, 1 line skipped', pasteMsg.includes('6 added') && pasteMsg.includes('broken line'), pasteMsg);
  await shot('02-paste-result');
  await page.click('[data-act=modalOk]');
  await page.waitForTimeout(150);
  check('price list shows the suits', (await page.locator('tbody tr').count()) === 6);
  await shot('03-price-list');

  // billing: tap tiles, 10% discount, cash
  await nav('billing');
  await shot('04-billing-empty');
  check('billing: save is disabled on an empty bill', await page.locator('[data-act=save][data-print="1"]').isDisabled());
  await page.click('.tile:has-text("Navy Blue Suit")');
  await page.click('.tile:has-text("Black Suit")');
  await page.click('.tile:has-text("Black Suit")');
  check('billing: tapping twice makes quantity 2', (await text('.billpanel .lines')).includes('Black Suit') && (await page.inputValue('input[data-qty]:near(:text("Black Suit"))')) !== undefined);
  check('billing: subtotal is 12,000', (await text('.billpanel .foot')).includes('Rs. 12,000'));
  await page.click('[data-act=dchip][data-v="10"]');
  let foot = await text('.billpanel .foot');
  check('10% discount shows -1,200 and total 10,800', foot.includes('-Rs. 1,200') && foot.includes('Rs. 10,800'), foot);
  await page.fill('#received', '10000');
  check('received too low shows a shortage hint', (await text('.hint')).includes('Rs. 800 short'), await text('.hint'));
  check('cannot save while short', await page.locator('[data-act=save][data-print="1"]').isDisabled());
  await page.fill('#received', '11000');
  check('change to return is Rs. 200', (await text('.change')).includes('Rs. 200'));
  await shot('05-billing-with-items');
  await page.click('[data-act=save][data-print="1"]');
  await page.waitForSelector('#newbill');
  await page.waitForFunction(() => document.querySelector('.dialog').innerText.includes('Receipt printed'));
  let done = await text('.dialog');
  check('saved bill 0001: total 10,800 and big change 200', done.includes('Bill 0001 saved') && done.includes('Rs. 10,800') && done.includes('Change: Rs. 200'), done);
  await shot('06-bill-saved');
  let st = await state();
  check('exactly one bill saved and one receipt printed', st.bills === 1 && st.printed.length === 1, JSON.stringify(st));
  const receipt1 = await (await fetch(BASE + '/__printed?n=0')).text();
  check('receipt lists items, discount line and total', ['Navy Blue Suit', 'Black Suit', 'Discount (10%)', '-1,200', 'Rs. 10,800', '2 &times; Rs. 4,000'].every((s) => receipt1.includes(s)));
  check('first print is not marked duplicate', !receipt1.includes('DUPLICATE</div>'));
  check('enter on the saved box starts a new bill', (await page.evaluate(() => document.activeElement.id)) === 'newbill');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('new bill is empty and search box is focused', (await page.locator('.billpanel .line').count()) === 0 && (await page.evaluate(() => document.activeElement.id)) === 'search');

  // search and Enter adds the single match
  await page.fill('#search', 'maroon');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('typing a name and pressing Enter adds the only match', (await text('.billpanel .lines')).includes('Maroon Suit'));
  await page.fill('#search', 'suit');
  await page.keyboard.press('Enter');
  check('Enter with many matches adds nothing and explains', (await page.locator('.billpanel .line').count()) === 1 && (await text('.toast')).includes('More than one'));

  // wallet payment (no received amount needed), group filter
  await page.click('[data-act=group][data-v="Printed"]');
  check('group tab filters the tiles (only Rose has the Printed group)', (await page.locator('.tile').count()) === 1);
  await page.click('[data-act=group][data-v="All"]');
  await page.click('[data-act=method][data-v="JazzCash"]');
  check('wallet: no received box, save enabled', (await page.locator('#received').count()) === 0 && !(await page.locator('[data-act=save][data-print=""]').isDisabled()));
  await page.fill('#cname', 'Imran Khan'); await page.fill('#cphone', '0300-1234567');
  await page.click('[data-act=save][data-print=""]');
  await page.waitForSelector('#newbill');
  check('saved without printing', (await text('.dialog')).includes('Saved without printing'));
  await page.keyboard.press('Enter');

  // printer failure: the bill is still saved, and printing can be retried
  await fetch(BASE + '/__failprint?on=1');
  await page.click('.tile:has-text("Rose Printed Suit")');
  await page.click('[data-act=exact]');
  await page.click('[data-act=save][data-print="1"]');
  await page.waitForFunction(() => document.querySelector('.dialog') && document.querySelector('.dialog').innerText.includes('did not print'));
  await shot('07-print-failed');
  st = await state();
  check('printer offline: bill is saved anyway (3 bills)', st.bills === 3, JSON.stringify(st));
  await fetch(BASE + '/__failprint?on=0');
  await page.click('[data-act=printAgain]');
  await page.waitForFunction(() => document.querySelector('.dialog').innerText.includes('Receipt printed'));
  check('retry prints the same bill without making a new one', (await state()).bills === 3);
  await page.keyboard.press('Enter');

  // bills page
  await nav('bills');
  check('bills list has 3 bills, newest first', (await page.locator('tbody tr.click').count()) === 3 && (await text('tbody tr.click')).startsWith('0003'));
  await page.fill('#bq', 'imran');
  await page.waitForTimeout(500);
  check('search by customer name finds bill 0002', (await page.locator('tbody tr.click').count()) === 1 && (await text('tbody tr.click')).includes('0002'));
  await page.fill('#bq', '1234567');
  await page.waitForTimeout(500);
  check('search by phone finds it too', (await page.locator('tbody tr.click').count()) === 1);
  await page.fill('#bq', '');
  await page.waitForTimeout(500);
  await page.click('tbody tr.click:has-text("0001")');
  await page.click('[data-act=previewBill]');
  await page.waitForSelector('.receipt-frame');
  await shot('08-bills-detail');
  await page.click('[data-act=reprint]');
  await page.waitForTimeout(300);
  const dup = await (await fetch(BASE + '/__printed?n=' + ((await state()).printed.length - 1))).text();
  check('reprint is marked DUPLICATE', dup.includes('DUPLICATE</div>') && dup.includes('0001'));

  // cancel a bill (owner)
  await page.click('[data-act=cancelAsk]');
  await page.click('[data-act=modalOk]');
  await page.waitForTimeout(300);
  check('cancel needs a reason', (await text('.dialog .err')).includes('reason'));
  await page.fill('#m-reason', 'Customer changed mind');
  await page.click('[data-act=modalOk]');
  await page.waitForTimeout(300);
  check('cancelled bill is marked and cannot be reprinted', (await text('.card .pill.bad')).includes('Cancelled') && (await page.locator('[data-act=reprint]').count()) === 0);

  // sales are hidden until the eye is clicked and the password is right
  await nav('sales');
  const hiddenTxt = await text('.content');
  check('sales page shows no money while hidden', !/Rs\. \d/.test(hiddenTxt) && hiddenTxt.includes('•'), hiddenTxt.slice(0, 200));
  check("top bar 'Today's sales' is hidden too", !/Rs\. \d/.test(await text('.top')));
  await shot('09-sales-hidden');
  await page.click('.content [data-act=eye]');
  await page.fill('#m-pw', 'wrong');
  await page.click('[data-act=modalOk]');
  await page.waitForTimeout(300);
  check('wrong password does not reveal sales', (await text('.dialog .err')).includes('Wrong password') && !/Rs\. \d/.test(await text('.content')));
  await page.fill('#m-pw', 'owner1234');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Rs\. \d/.test(document.querySelector('.content').innerText));
  const shownTxt = await text('.content');
  // bill 1 (10,800) was cancelled; bill 2 JazzCash 4,200 (Maroon) + bill 3 cash 4,800 (Rose) remain -> 9,000 across 2 bills
  check('sales show 9,000 over 2 bills (cancelled bill left out)', shownTxt.includes('Rs. 9,000') && /Bills 2/.test(shownTxt), shownTxt.slice(0, 400));
  check('by-method split shows JazzCash 4,200 and Cash 4,800', shownTxt.includes('JazzCash Rs. 4,200') && shownTxt.includes('Cash Rs. 4,800'), shownTxt);
  check('cancelled count is 1', /Cancelled bills 1/.test(shownTxt));
  check("top bar today's sales shows 9,000", (await text('.top')).includes('Rs. 9,000'));
  await shot('10-sales-revealed');
  await page.waitForFunction(() => !/Rs\. \d/.test(document.querySelector('.content').innerText), null, { timeout: 20000 });
  check('figures hide themselves again after a few seconds', true);

  // settings
  await nav('settings');
  await page.waitForSelector('#f-shop');
  await page.fill('#f-addr', 'Eman Zeb Plaza, Darwesh, Haripur'); await page.fill('#f-ph', '0300-0000000');
  await page.click('[data-act=saveShop]');
  await page.waitForTimeout(200);
  check('shop details can be saved', (await text('.toast')).includes('Saved'));
  await page.selectOption('#f-pw', '58'); await page.click('[data-act=savePrinter]');
  await page.waitForTimeout(150);
  await page.click('[data-act=testPreview]');
  await page.waitForSelector('.dialog .receipt-frame');
  await shot('11-settings-and-test-preview');
  await page.click('[data-act=modalCancel]');
  await page.fill('#nu-n', 'Ali'); await page.fill('#nu-u', 'ali'); await page.fill('#nu-p', 'ali12345');
  await page.click('[data-act=addUser]');
  await page.waitForTimeout(300);
  check('staff member added', (await text('.content')).includes('Ali'));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('12-settings');

  // ---------- cost price, udhaar and profit: each in its own tab ----------
  const navAll = await text('.nav');
  check('left menu has separate tabs: New bill, Bills, Price list, Udhaar, Profit, Sales, Settings',
    ['New bill', 'Bills', 'Price list', 'Udhaar', 'Profit', 'Sales', 'Settings'].every((t) => navAll.includes(t)), navAll);

  await nav('prices');
  check('price list hides cost and profit until the eye is clicked', !/Rs\. 3,000/.test(await text('.content')) && (await text('.content')).includes('not set'));
  await page.click('tr:has-text("Maroon Suit") [data-act=editSuit]');
  await page.fill('#m-cost', '3000');
  await page.click('[data-act=modalOk]');
  await page.waitForTimeout(250);
  check('cost price saved for Maroon Suit (still hidden)', (await text('tr:has-text("Maroon Suit")')).includes('•'), await text('tr:has-text("Maroon Suit")'));
  await shot('15-price-list-cost');

  // udhaar bill with part payment, printed: nothing about udhaar or the customer on the paper
  await nav('billing');
  await page.click('.tile:has-text("Maroon Suit")');
  await page.click('[data-act=credit][data-v="1"]');
  check('udhaar: save is blocked until name and phone are given', (await text('.hint')).includes('customer name') && (await page.locator('[data-act=save][data-print="1"]').isDisabled()), await text('.hint'));
  await page.fill('#cname', 'Imran Khan'); await page.fill('#cphone', '0300-1234567');
  await page.fill('#received', '4200');
  check('udhaar: paying the full amount is refused', (await text('.hint')).includes('less than the total'), await text('.hint'));
  await page.fill('#received', '1200');
  check('udhaar: Rs. 4,200 bill with Rs. 1,200 paid shows Rs. 3,000 left', (await text('.change.due')).includes('Rs. 3,000'), await text('.billpanel .foot'));
  await shot('16-udhaar-bill');
  await page.click('[data-act=save][data-print=""]');
  await page.waitForSelector('#newbill');
  const ud = await text('.dialog');
  check('udhaar saved box shows Udhaar Rs. 3,000, not change', ud.includes('Udhaar: Rs. 3,000') && !ud.includes('Change:'), ud);
  await page.click('#newbill');
  await page.click('.tile:has-text("Maroon Suit")');
  await page.click('[data-act=credit][data-v="1"]');
  await page.fill('#cname', 'Imran Khan'); await page.fill('#cphone', '+92 300 1234567');
  await page.click('[data-act=save][data-print="1"]');
  await page.waitForFunction(() => document.querySelector('.dialog').innerText.includes('Receipt printed'));
  const stU = await state();
  const udReceipt = await (await fetch(BASE + '/__printed?n=' + (stU.printed.length - 1))).text();
  check('printed udhaar receipt has no customer, no phone, no udhaar and no "Served by"',
    !['Imran', '1234567', 'Udhaar', 'UDHAAR', 'Balance', 'Served', 'Paid now'].some((w) => udReceipt.includes(w)) && udReceipt.includes('Rs. 4,200'));
  await page.click('#newbill');

  await nav('udhaar');
  await page.waitForSelector('tr.click');
  const uTxt = await text('.content');
  check('udhaar tab: one customer owes Rs. 7,200 (two bills, phone written two ways = one account)', uTxt.includes('Imran Khan') && uTxt.includes('Rs. 7,200') && /Customers who owe 1/.test(uTxt), uTxt.slice(0, 300));
  await page.click('tr.click');
  await page.waitForSelector('#u-amt');
  await page.fill('#u-amt', '9000');
  await page.click('[data-act=receiveUdhaar]');
  await page.waitForTimeout(200);
  check('udhaar: cannot receive more than is owed', (await text('.toast')).includes('owes only Rs. 7,200'), await text('.toast'));
  await page.fill('#u-amt', '200');
  await page.click('[data-act=payMethod][data-v="JazzCash"]');
  await page.click('[data-act=receiveUdhaar]');
  await page.waitForFunction(() => document.querySelector('.toast') && document.querySelector('.toast').innerText.includes('Still owes'));
  check('udhaar: Rs. 200 received, Rs. 7,000 still owed', (await text('.toast')).includes('Rs. 7,000'), await text('.toast'));
  await page.waitForTimeout(200);
  const uTxt2 = await text('.content');
  check('udhaar page shows the new balance and the payment history', uTxt2.includes('Rs. 7,000') && uTxt2.includes('JazzCash') && uTxt2.includes('Rs. 200'), uTxt2.slice(0, 500));
  await shot('17-udhaar-tab');

  await nav('profit');
  const pHidden = await text('.content');
  check('profit tab shows no money while hidden', !/Rs\. \d/.test(pHidden) && pHidden.includes('•'), pHidden.slice(0, 200));
  await page.click('.content [data-act=eye]');
  await page.fill('#m-pw', 'owner1234');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Rs\. \d/.test(document.querySelector('.content').innerText));
  const pTxt = await text('.content');
  // two Maroon udhaar bills: sales 8,400, cost 6,000, profit 2,400. Two older bills had no cost and are left out.
  check('profit: Rs. 2,400 (sales 8,400 minus cost 6,000)', pTxt.includes('Rs. 2,400') && pTxt.includes('Rs. 8,400') && pTxt.includes('Rs. 6,000'), pTxt.slice(0, 500));
  check('profit: bills without a cost are reported as left out', pTxt.includes('2 bills are left out'), pTxt.slice(0, 600));
  await shot('18-profit-revealed');
  await page.waitForFunction(() => !/Rs\. \d/.test(document.querySelector('.content').innerText), null, { timeout: 20000 });
  check('profit hides itself again', true);

  // staff login: no sales, no settings, discount limit enforced
  await page.click('[data-act=logout]');
  await page.waitForSelector('#l-user');
  await page.fill('#l-user', 'ali'); await page.fill('#l-pw', 'ali12345'); await page.click('[data-act=login]');
  await page.waitForSelector('.shell');
  const navTxt = await text('.nav');
  check('staff does not see Sales, Settings, Udhaar or Profit', !navTxt.includes('Sales') && !navTxt.includes('Settings') && !navTxt.includes('Udhaar') && !navTxt.includes('Profit') && navTxt.includes('New bill'));
  check("staff top bar has no sales chip", (await page.locator('.chip-eye').count()) === 0);
  await page.click('.tile:has-text("Navy Blue Suit")');
  await page.fill('#discval', '20');
  check('staff cannot give 20% (limit 15%)', (await text('.hint')).includes('needs the owner') && (await page.locator('[data-act=save][data-print="1"]').isDisabled()));
  await page.fill('#discval', '15');
  await page.click('[data-act=exact]');
  check('staff can give 15%', !(await page.locator('[data-act=save][data-print="1"]').isDisabled()), await text('.hint'));
  await nav('prices');
  check('staff sees the price list read-only', (await page.locator('[data-act=editSuit]').count()) === 0 && (await page.locator('[data-act=addSuit]').count()) === 0);
  check('staff sees no cost or profit column', !/Cost|Profit/.test(await text('.content')));
  await shot('13-staff-prices');

  // the receipt itself, as it would come out of the printer (58mm and 80mm)
  const p2 = await browser.newPage({ viewport: { width: 380, height: 700 } });
  await p2.goto(BASE + '/__printed?n=0');
  await p2.screenshot({ path: `${OUT}/14-receipt-80mm.png`, fullPage: true });
  await p2.close();

  check('no script errors or console errors anywhere', problems.length === 0, problems.join(' | '));
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
