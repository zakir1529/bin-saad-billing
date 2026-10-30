'use strict';
(function () {
  const M = window.Money; // the same money rules the program uses when it saves a bill
  const REVEAL_MS = 15000; // how long hidden figures stay visible after the eye is clicked

  const call = (method, ...args) => window.bridge.call(method, ...args);
  const fmt = M.fmt;
  const money = (n) => 'Rs. ' + fmt(n);
  const pad4 = (n) => String(n).padStart(4, '0');
  const p2 = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel) => document.querySelector(sel);
  const isCash = (m) => String(m).toLowerCase() === 'cash';

  function uuid() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function when(iso) {
    const d = new Date(iso);
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} ${h}:${p2(d.getMinutes())} ${ap}`;
  }
  function dayLabel(key) {
    const [y, m, d] = key.split('-');
    return `${d}-${m}-${y}`;
  }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }
  function monthKey() {
    return todayKey().slice(0, 7);
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = value;
  }

  const newBill = () => ({
    uid: uuid(), lines: [], discType: 'pct', discVal: '', credit: false,
    method: (S.settings && S.settings.paymentMethods[0]) || 'Cash', received: '', name: '', phone: '',
  });

  function freshLogin() {
    return { username: '', password: '', name: '', password2: '', error: '', mode: 'login', code: '', newCode: '', busy: false };
  }

  const S = {
    status: null, user: null, settings: null, suits: [],
    view: 'billing', search: '', group: 'All', bill: null, saving: false, done: null,
    bills: { text: '', from: '', to: '', state: '', list: null, sel: null, preview: null },
    prices: { q: '', all: [] },
    udhaar: { q: '', list: null, sel: null, detail: null, pay: null, busy: false },
    profit: { month: monthKey(), day: '', data: null },
    dash: null, ledger: null,
    sales: { day: todayKey(), month: monthKey(), day_data: null, month_data: null },
    reveal: { on: false, today: null, timer: null, unlocked: false },
    showPw: {}, stock: { log: [] },
    form: null, newUser: { name: '', username: '', password: '' }, pw: { old: '', a: '', b: '' },
    printers: null, info: null, modal: null, toast: null, login: freshLogin(),
  };

  // ---------- small helpers ----------
  let toastTimer = null;
  function toast(msg, kind) {
    S.toast = { msg, kind: kind || 'ok' };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = null; render(); }, kind === 'error' ? 8000 : 3500);
    render();
  }
  async function safe(fn) {
    try {
      return await fn();
    } catch (e) {
      S.saving = false;
      toast(e && e.message ? e.message : String(e), 'error');
    }
  }

  // ---------- startup and login ----------
  async function boot() {
    if (!window.bridge) {
      document.getElementById('app').innerHTML = '<div class="login"><div class="box"><h1>Cannot start</h1><p class="muted">The program could not connect to its data. Please close it and open it again.</p></div></div>';
      return;
    }
    S.status = await call('status');
    if (S.status.user) await afterLogin(S.status.user);
    else render();
  }

  async function afterLogin(user) {
    S.user = user;
    S.view = 'dashboard';
    S.settings = await call('getSettings');
    S.suits = await call('listSuits', {});
    S.bill = newBill();
    S.done = null;
    refreshInfo();
    render();
    go('dashboard');
  }

  async function refreshInfo() {
    try { S.info = await call('appInfo'); } catch (e) { S.info = null; }
    render();
  }
  setInterval(() => { if (S.user) refreshInfo(); }, 30000);

  async function reloadSuits() {
    S.suits = await call('listSuits', {});
    if (S.user && S.user.role === 'owner') S.prices.all = await call('listSuits', { includeInactive: true });
  }

  // ---------- billing logic (display only; the program re-checks everything when saving) ----------
  function billCalc() {
    const b = S.bill;
    const out = { ok: false, hint: '', t: null, rec: null, change: 0 };
    if (!b.lines.length) { out.hint = 'Tap a suit to start the bill.'; return out; }
    for (const l of b.lines) {
      if (l.qty > maxQty(l.suitId)) { out.hint = `Only ${maxQty(l.suitId)} of ${l.name} in stock.`; return out; }
    }
    try {
      out.t = M.computeTotals(b.lines.map((l) => ({ price: l.price, qty: l.qty })), { type: b.discType, value: b.discVal });
    } catch (e) { out.hint = e.message; return out; }
    if (out.t.total < 1) { out.hint = 'The total cannot be zero.'; return out; }
    if (S.user.role !== 'owner' && out.t.discount * 100 > out.t.subtotal * S.settings.discountLimitPct) {
      out.hint = `A discount above ${S.settings.discountLimitPct}% needs the owner.`; return out;
    }
    if (b.credit) {
      if (!b.name.trim()) { out.hint = 'Udhaar needs the customer name.'; return out; }
      if (b.phone.replace(/\D/g, '').length < 7) { out.hint = 'Udhaar needs the customer phone number.'; return out; }
      out.paid = b.received === '' ? 0 : Number(b.received);
      if (out.paid >= out.t.total) { out.hint = 'Paid now must be less than the total. For a full payment choose Paid in full.'; return out; }
      out.due = out.t.total - out.paid;
      out.ok = true;
      return out;
    }
    if (isCash(b.method)) {
      if (b.received === '') { out.hint = 'Enter the amount received.'; return out; }
      out.rec = Number(b.received);
      if (out.rec < out.t.total) { out.hint = `Received is ${money(out.t.total - out.rec)} short.`; return out; }
      out.change = out.rec - out.t.total;
    }
    out.ok = true;
    return out;
  }

  // How many of a suit can still be sold. Suits that are not being counted have no limit.
  const stockOf = (s) => (s && s.stock !== null && s.stock !== undefined ? s.stock : null);
  function maxQty(suitId) {
    const st = stockOf(S.suits.find((x) => x.id === suitId));
    return st === null ? M.MAX_QTY : Math.min(M.MAX_QTY, st);
  }
  function addSuit(id) {
    const s = S.suits.find((x) => x.id === id);
    if (!s) return;
    const st = stockOf(s);
    const line = S.bill.lines.find((l) => l.suitId === id);
    if (st === 0) { toast(`${s.name} is out of stock.`, 'error'); return; }
    if (line) {
      if (line.qty < maxQty(id)) line.qty += 1;
      else if (st !== null) { toast(`Only ${st} of ${s.name} in stock.`, 'error'); return; }
    } else S.bill.lines.push({ suitId: s.id, name: s.name, price: s.price, qty: 1 });
    render();
  }

  async function saveBill(print) {
    if (S.saving) return;
    const calc = billCalc();
    if (!calc.ok) { toast(calc.hint || 'The bill is not complete.', 'error'); return; }
    const b = S.bill;
    S.saving = true;
    render();
    let result;
    try {
      result = await call('createBill', {
        uid: b.uid,
        lines: b.lines.map((l) => ({ suitId: l.suitId, qty: l.qty })),
        discount: { type: b.discType, value: b.discVal === '' ? 0 : Number(b.discVal) },
        method: b.method,
        credit: !!b.credit,
        received: b.credit ? (b.received === '' ? '' : Number(b.received)) : (isCash(b.method) ? Number(b.received) : ''),
        customerName: b.name,
        customerPhone: b.phone,
      });
    } catch (e) {
      S.saving = false;
      toast(e.message, 'error');
      return;
    }
    S.saving = false;
    S.bill = newBill();
    S.search = '';
    S.done = { bill: result.bill, print: print ? 'printing' : 'skipped', error: '' };
    try { S.suits = await call('listSuits', {}); } catch (e) { /* the counts refresh next time */ }
    render();
    if (print) await doPrint(result.bill.id);
    refreshInfo();
  }

  async function doPrint(id) {
    if (S.done) { S.done.print = 'printing'; S.done.error = ''; render(); }
    try {
      await call('printBill', id);
      if (S.done) S.done.print = 'ok';
    } catch (e) {
      if (S.done) { S.done.print = 'failed'; S.done.error = e.message; }
      else toast(e.message, 'error');
    }
    render();
  }

  // ---------- hidden figures (the eye button) ----------
  function hideReveal() {
    clearTimeout(S.reveal.timer);
    S.reveal = { on: false, today: null, timer: null, unlocked: S.reveal.unlocked };
    S.sales.day_data = null;
    S.sales.month_data = null;
    S.profit.data = null;
    render();
  }
  async function doReveal() {
    S.reveal.today = await call('dailyReport', todayKey());
    S.reveal.on = true;
    if (S.view === 'sales') await loadSales();
    if (S.view === 'profit') await loadProfit();
    if (S.view === 'ledger') await loadLedger();
    clearTimeout(S.reveal.timer);
    S.reveal.timer = setTimeout(hideReveal, REVEAL_MS);
    render();
  }
  async function toggleReveal() {
    if (S.reveal.on) return hideReveal();
    // The password is asked once each time the program is opened. After that the eye just shows and hides.
    if (S.settings.revealNeedsPassword && !S.reveal.unlocked) { S.modal = { type: 'password', error: '' }; render(); return; }
    await doReveal();
  }
  async function loadProfit() {
    S.profit.data = await call('profitReport', S.profit.day || S.profit.month || monthKey());
  }
  async function loadLedger() { S.ledger = await call('ledger'); }
  async function loadUdhaar() {
    const U = S.udhaar;
    U.list = await call('listUdhaar');
    if (U.sel) {
      try { U.detail = await call('udhaarCustomer', U.sel); } catch (e) { U.sel = null; U.detail = null; U.pay = null; }
    }
  }
  async function loadSales() {
    S.sales.day_data = await call('dailyReport', S.sales.day || todayKey());
    S.sales.month_data = await call('monthlyReport', S.sales.month || monthKey());
  }

  // ---------- screens: loading data when a page opens ----------
  async function go(view) {
    S.view = view;
    S.modal = null;
    S.done = null;
    S.toast = null;
    S.showPw = {};
    render();
    await safe(async () => {
      if (view === 'billing') S.suits = await call('listSuits', {});
      if (view === 'dashboard') S.dash = await call('dashboard');
      if (view === 'ledger' && S.reveal.on) await loadLedger();
      if (view === 'bills') await loadBills();
      if (view === 'inventory') {
        await reloadSuits();
        if (S.user.role === 'owner') S.stock.log = await call('listStockLog', 30);
      }
      if (view === 'sales' && S.reveal.on) await loadSales();
      if (view === 'profit' && S.reveal.on) await loadProfit();
      if (view === 'udhaar') await loadUdhaar();
      if (view === 'settings') {
        S.settings = await call('getSettings');
        S.recovery = await call('recoveryInfo');
        S.form = { ...S.settings, paymentMethodsText: S.settings.paymentMethods.join(', ') };
        S.users = await call('listUsers');
        S.printers = await call('listPrinters').catch(() => []);
        refreshInfo();
      }
      render();
    });
  }

  async function loadBills() {
    const f = S.bills;
    f.list = await call('searchBills', { text: f.text, from: f.from, to: f.to, status: f.state, limit: 150 });
    if (f.sel && !f.list.some((b) => b.id === f.sel)) { f.sel = null; f.preview = null; }
    render();
  }
  let billsTimer = null;
  function loadBillsSoon() {
    clearTimeout(billsTimer);
    billsTimer = setTimeout(() => safe(loadBills), 250);
  }

  // ---------- views ----------
  const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_SLASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/></svg>';
  const eyeBtn = () => `<button class="eye" data-act="eye" aria-label="${S.reveal.on ? 'Hide sales' : 'Show sales'}" title="${S.reveal.on ? 'Hide sales' : 'Show sales'}">${S.reveal.on ? EYE_OPEN : EYE_SLASH}</button>`;
  const DOTS = '••••••';
  const shown = (n) => (S.reveal.on ? money(n) : DOTS);

  // A password box with an eye button, so what is being typed can be checked.
  function pwInput(id, bind, value, opts = {}) {
    const show = !!S.showPw[id];
    return `<div class="pw"><input id="${id}" type="${show ? 'text' : 'password'}" data-bind="${bind}" ${opts.enter ? `data-enter="${opts.enter}"` : ''} ${opts.autofocus ? 'data-autofocus="1"' : ''} aria-label="${esc(opts.label || 'Password')}" ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''} value="${esc(value)}" autocomplete="off">
      <button type="button" class="pweye" data-act="pwtoggle" data-for="${id}" aria-label="${show ? 'Hide' : 'Show'} password" title="${show ? 'Hide' : 'Show'} password">${show ? EYE_OPEN : EYE_SLASH}</button></div>`;
  }

  function viewLogin() {
    const L = S.login;
    const shop = esc(S.status.shopName);
    if (S.status.needsSetup) {
      return `<div class="login"><div class="box">
        <h1>${shop}</h1><div class="sub">First time set-up. Create the owner password.</div>
        <div class="stack">
          <div><label class="field" for="l-name">Your name</label><input id="l-name" type="text" data-bind="login.name" value="${esc(L.name)}"></div>
          <div><label class="field" for="l-pw">Password (at least 4 characters)</label>${pwInput('l-pw', 'login.password', L.password, { enter: 'setup', label: 'Password' })}</div>
          <div><label class="field" for="l-pw2">Type the password again</label>${pwInput('l-pw2', 'login.password2', L.password2, { enter: 'setup', label: 'Password again' })}</div>
          <button class="btn primary big" data-act="setup">Create and start</button>
          <div class="muted small">Next you will get a recovery code. Write it on paper. It is the only way back in if the password is forgotten.</div>
          <div class="err">${esc(L.error)}</div>
        </div></div></div>`;
    }
    if (L.mode === 'forgot') {
      return `<div class="login"><div class="box">
        <h1>Forgot password</h1><div class="sub">${S.status.hasRecovery ? 'Type the recovery code you wrote down, then choose a new password. Your bills and data stay as they are.' : 'No recovery code was made on this computer yet. The owner can make one in Settings after logging in.'}</div>
        <div class="stack">
          <div><label class="field" for="l-code">Recovery code</label><input id="l-code" type="text" data-bind="login.code" data-enter="resetPw" value="${esc(L.code)}" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" data-autofocus="1" style="letter-spacing:2px;text-transform:uppercase"></div>
          <div><label class="field" for="l-npw">New password (at least 4 characters)</label>${pwInput('l-npw', 'login.password', L.password, { enter: 'resetPw', label: 'New password' })}</div>
          <div><label class="field" for="l-npw2">Type the new password again</label>${pwInput('l-npw2', 'login.password2', L.password2, { enter: 'resetPw', label: 'New password again' })}</div>
          <button class="btn primary big" data-act="resetPw" ${S.status.hasRecovery && !L.busy ? '' : 'disabled'}>Set the new password</button>
          <div class="err">${esc(L.error)}</div>
          <button class="link" data-act="backToLogin" style="background:none;border:0;color:var(--accent);text-align:left;padding:0">Back to log in</button>
        </div></div></div>`;
    }
    if (L.mode === 'newcode') {
      return `<div class="login"><div class="box">
        <h1>Password changed</h1><div class="sub">Your old recovery code no longer works. Write this new one on paper and keep it somewhere safe, away from the shop computer.</div>
        <div class="stack"><div class="codebox" id="rc-code">${esc(L.newCode)}</div>
          <button class="btn primary big" data-act="codeDone">I have written it down. Go to log in</button></div></div></div>`;
    }
    return `<div class="login"><div class="box">
      <h1>${shop}</h1><div class="sub">Please log in</div>
      <div class="stack">
        <div><label class="field" for="l-user">Username or name</label><input id="l-user" type="text" data-bind="login.username" data-enter="login" value="${esc(L.username)}" placeholder="owner" autocomplete="off" data-autofocus="1"></div>
        <div><label class="field" for="l-pw">Password</label>${pwInput('l-pw', 'login.password', L.password, { enter: 'login', label: 'Password' })}</div>
        <button class="btn primary big" data-act="login">Log in</button>
        <div class="err">${esc(L.error)}</div>
        <button class="link" data-act="forgotGo" style="background:none;border:0;color:var(--accent);text-align:left;padding:0;font-size:13px">Forgot password?</button>
      </div></div></div>`;
  }

  const TITLES = { dashboard: 'Dashboard', ledger: 'Ledger', billing: 'Checkout', inventory: 'Inventory', bills: 'Bills', udhaar: 'Udhaar', profit: 'Analytics', sales: 'Sales', settings: 'Settings' };

  function shell(content) {
    const owner = S.user.role === 'owner';
    const items = [['dashboard', 'Dashboard'], ['billing', 'Checkout'], ['inventory', 'Inventory'], ['bills', 'Bills']];
    if (owner) items.push(['udhaar', 'Udhaar'], ['profit', 'Analytics'], ['ledger', 'Ledger'], ['sales', 'Sales'], ['settings', 'Settings']);
    const backupWarn = S.info && S.info.backupFolderSet && S.info.lastBackup && S.info.lastBackup.ok === false;
    return `<div class="shell">
      <nav class="nav">
        <div class="brand"><b>${esc(S.settings.shopName.toUpperCase())}</b><span>Billing</span></div>
        ${items.map(([v, label]) => `<button class="item ${S.view === v ? 'on' : ''}" data-act="nav" data-view="${v}">${label}</button>`).join('')}
        <div class="who"><b>${esc(S.user.name)}</b>${owner ? 'Owner' : 'Staff'}<br><button data-act="logout">Log out</button></div>
      </nav>
      <div class="main">
        <div class="top">
          <h1>${TITLES[S.view]}</h1><div class="grow"></div>
          ${backupWarn ? '<span class="warn-chip" title="' + esc(S.info.lastBackup.error) + '">Backup problem: check the USB drive</span>' : ''}
          ${owner ? `<div class="chip-eye">Today's sales <strong class="num">${S.reveal.on && S.reveal.today ? money(S.reveal.today.sales) : DOTS}</strong>${eyeBtn()}</div>` : ''}
        </div>
        <div class="content" ${S.view === 'billing' ? 'style="overflow:hidden"' : ''}>${content}</div>
      </div></div>`;
  }

  // ----- dashboard -----
  function viewDashboard() {
    const d = S.dash;
    if (!d) return '<div class="empty">Loading...</div>';
    const owner = S.user.role === 'owner';
    const on = S.reveal.on;
    const v = (n) => (on ? money(n) : DOTS);
    const tile = (k, val, sub) => `<div class="stat"><div class="k">${k}</div><div class="v num">${val}</div>${sub ? '<div class="muted small" style="margin-top:4px">' + sub + '</div>' : ''}</div>`;
    return `<div class="stats">
        ${owner ? tile("Today's sales", v(d.sales || 0), d.bills + ' bill' + (d.bills === 1 ? '' : 's')) : tile('Bills today', d.bills)}
        ${tile('Pieces sold today', d.items)}
        ${owner ? tile('Udhaar owed', v(d.udhaarOwed || 0), 'money customers still owe') : ''}
        ${tile('Low or out of stock', d.low.length, d.low.length ? 'see the list below' : 'all good')}
      </div>
      <div class="row wrap" style="margin:14px 0"><button class="btn primary" data-act="nav" data-view="billing">New bill</button>
        ${owner ? '<button class="btn" data-act="nav" data-view="inventory">Add stock</button><button class="btn" data-act="nav" data-view="udhaar">Udhaar</button>' + eyeBtn() : ''}</div>
      <div class="split">
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Recent bills</th><th>Time</th><th class="right">Total</th></tr></thead><tbody>
          ${d.recent.map((b) => `<tr><td><b>${esc(b.invoice || '')}</b> ${b.status === 'cancelled' ? '<span class="pill off">Cancelled</span>' : ''}</td><td>${esc(when(b.at))}</td><td class="right num">${money(b.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No bills yet.</td></tr>'}</tbody></table></div>
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Needs attention</th><th class="right">Left</th></tr></thead><tbody>
          ${d.low.map((x) => `<tr><td>${esc(x.name)}</td><td class="right">${x.stock === 0 ? '<span class="pill bad">Out</span>' : '<span class="pill warn">' + x.stock + '</span>'}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">Nothing is running low.</td></tr>'}</tbody></table></div>
      </div>`;
  }

  // ----- ledger (owner, hidden until the eye is clicked) -----
  function viewLedger() {
    const on = S.reveal.on;
    const L = on ? S.ledger : null;
    const v = (n) => (on && L ? money(n) : DOTS);
    const tile = (k, val, sub) => `<div class="stat"><div class="k">${k}</div><div class="v num">${val}</div>${sub ? '<div class="muted small" style="margin-top:4px">' + sub + '</div>' : ''}</div>`;
    return `<div class="card row between" style="margin-bottom:12px"><div class="muted">${on ? 'Figures are visible for a few seconds, then hide again.' : 'The ledger is hidden. Click the eye to show it.'}</div>${eyeBtn()}</div>
      <div class="stats">
        ${tile('Stock worth (at cost)', v(L ? L.stock.atCost : 0), L && L.stock.uncosted ? L.stock.uncosted + ' items have no cost set' : '')}
        ${tile('Stock worth (at selling price)', v(L ? L.stock.atPrice : 0), L ? L.stock.pieces + ' pieces counted' : '')}
        ${tile("Today's sales", v(L ? L.today : 0))}
        ${tile("Yesterday's sales", v(L ? L.yesterday : 0))}
        ${tile('Total since opening', v(L ? L.lifetime : 0), L ? L.bills + ' bills' : '')}
        ${tile('Best seller today', on && L ? (L.topToday ? esc(L.topToday.name) + ' x' + L.topToday.qty : '-') : DOTS)}
      </div>
      ${L && L.stock.byCategory.length ? `<div class="card" style="padding:0;overflow:hidden;margin-top:12px"><table><thead><tr><th>Stock by category</th><th class="right">Pieces</th><th class="right">Worth</th></tr></thead><tbody>
        ${L.stock.byCategory.map((c) => `<tr><td>${esc(c.name)}</td><td class="right num">${c.pieces}</td><td class="right num">${money(c.atPrice)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  // ----- billing -----
  function viewBilling() {
    const groups = [...new Set(S.suits.map((s) => s.group).filter(Boolean))].sort();
    const q = S.search.trim().toLowerCase();
    const list = S.suits.filter((s) => (S.group === 'All' || s.group === S.group) && (!q || s.name.toLowerCase().includes(q)));
    const inBill = new Map(S.bill.lines.map((l) => [l.suitId, l.qty]));
    let tiles;
    if (!S.suits.length) {
      tiles = `<div class="empty" style="grid-column:1/-1">There are no suits in the price list yet.${S.user.role === 'owner' ? '<br><br><button class="btn primary" data-act="nav" data-view="inventory">Add suits</button>' : '<br>Ask the owner to add them.'}</div>`;
    } else if (!list.length) {
      tiles = '<div class="empty" style="grid-column:1/-1">No suit matches this search.</div>';
    } else {
      const seen = new Set();
      tiles = list.map((s) => {
        if (s.base && s.size) {
          if (seen.has(s.base)) return '';
          seen.add(s.base);
          const sibs = list.filter((x) => x.base === s.base);
          const counted = sibs.filter((x) => stockOf(x) !== null);
          const total = counted.reduce((n, x) => n + x.stock, 0);
          const allOut = counted.length === sibs.length && total === 0;
          const prices = sibs.map((x) => x.price);
          const lo = Math.min(...prices); const hi = Math.max(...prices);
          const q = sibs.reduce((n, x) => n + (inBill.get(x.id) || 0), 0);
          return `<button class="tile ${q ? 'in' : ''} ${allOut ? 'out' : ''}" data-act="tileGroup" data-base="${esc(s.base)}" ${allOut ? 'disabled' : ''}>
            <span class="nm">${esc(s.base)}</span><span><span class="pr num">${lo === hi ? money(lo) : 'from ' + money(lo)}</span><br><span class="stk">${allOut ? 'Out of stock' : 'Choose a size'}</span></span>${q ? `<span class="qty">x${q}</span>` : ''}</button>`;
        }
        const st = stockOf(s);
        const low = st !== null && st > 0 && st <= S.settings.lowStockAt;
        const stk = st === null ? '' : st === 0 ? '<span class="stk out">Out of stock</span>' : `<span class="stk ${low ? 'low' : ''}">${low ? 'Only ' + st + ' left' : st + ' in stock'}</span>`;
        return `<button class="tile ${inBill.has(s.id) ? 'in' : ''} ${st === 0 ? 'out' : ''}" data-act="tile" data-id="${s.id}" ${st === 0 ? 'disabled' : ''}>
          <span class="nm">${esc(s.name)}</span><span><span class="pr num">${money(s.price)}</span><br>${stk}</span>${inBill.has(s.id) ? `<span class="qty">x${inBill.get(s.id)}</span>` : ''}</button>`;
      }).join('');
    }
    return `<div class="billing">
      <div class="picker">
        <div class="row">
          <input id="search" type="text" placeholder="Type a suit name, then tap it (Enter adds it if only one matches)" data-bind="search" data-rerender="1" data-enter="searchEnter" value="${esc(S.search)}" data-autofocus="1" autocomplete="off">
        </div>
        ${groups.length ? `<div class="chips">${['All', ...groups].map((g) => `<button class="chip ${S.group === g ? 'on' : ''}" data-act="group" data-v="${esc(g)}">${esc(g)}</button>`).join('')}</div>` : ''}
        <div class="tiles" data-keep-scroll="tiles">${tiles}</div>
      </div>
      ${billPanel()}
    </div>`;
  }

  function billPanel() {
    const b = S.bill;
    const c = billCalc();
    const lines = b.lines.length
      ? b.lines.map((l) => `<div class="line">
          <div class="nm">${esc(l.name)}</div><div class="amt num">${money(l.price * l.qty)}</div>
          <div class="qtybox"><button data-act="qminus" data-id="${l.suitId}" aria-label="One less">-</button>
            <input id="q-${l.suitId}" type="number" min="1" max="${M.MAX_QTY}" step="1" value="${l.qty}" data-qty="${l.suitId}" aria-label="Quantity of ${esc(l.name)}">
            <button data-act="qplus" data-id="${l.suitId}" aria-label="One more">+</button>
            <span class="muted small num">&nbsp;${money(l.price)} each</span></div>
          <div class="right"><button class="x" data-act="rm" data-id="${l.suitId}">Remove</button></div></div>`).join('')
      : '<div class="empty">The bill is empty.<br>Tap a suit on the left.</div>';
    const pctChips = [5, 10, 15].map((n) => `<button class="chip ${b.discType === 'pct' && b.discVal === String(n) ? 'on' : ''}" data-act="dchip" data-v="${n}">${n}%</button>`).join('');
    const methods = S.settings.paymentMethods.map((m) => `<button class="chip ${b.method === m ? 'on' : ''}" data-act="method" data-v="${esc(m)}">${esc(m)}</button>`).join('');
    const t = c.t;
    return `<div class="billpanel">
      <div class="head row between"><h2>Current bill</h2><button class="btn small" data-act="clearBill" ${b.lines.length ? '' : 'disabled'}>Clear</button></div>
      <div class="lines" data-keep-scroll="lines">${lines}</div>
      <div class="foot">
        <div class="stack" style="gap:8px">
          <div class="row wrap"><span class="muted small" style="width:58px">Discount</span>
            <div class="chips"><button class="chip ${b.discVal === '' ? 'on' : ''}" data-act="dchip" data-v="">None</button>${pctChips}</div></div>
          <div class="row"><div class="seg"><button data-act="dtype" data-v="pct" class="${b.discType === 'pct' ? 'on' : ''}">%</button><button data-act="dtype" data-v="amt" class="${b.discType === 'amt' ? 'on' : ''}">Rs.</button></div>
            <input id="discval" type="text" inputmode="decimal" placeholder="Other discount" data-bind="bill.discVal" data-kind="decimal" data-rerender="1" value="${esc(b.discVal)}" style="max-width:130px" aria-label="Discount amount">
            <span class="muted small num">${t && t.discount ? 'minus ' + money(t.discount) : ''}</span></div>
          <div>
            <div class="sum"><span class="muted">Subtotal</span><span class="num">${t ? money(t.subtotal) : '-'}</span></div>
            ${t && t.discount ? `<div class="sum"><span class="muted">Discount ${t.discountType === 'pct' ? '(' + Number(t.discountValue) + '%)' : ''}</span><span class="num">-${money(t.discount)}</span></div>` : ''}
            <div class="sum total"><span>Total</span><span class="num">${t ? money(t.total) : 'Rs. 0'}</span></div>
          </div>
          <div class="seg"><button data-act="credit" data-v="" class="${b.credit ? '' : 'on'}">Paid in full</button><button data-act="credit" data-v="1" class="${b.credit ? 'on' : ''}">Udhaar</button></div>
          <div class="chips">${methods}</div>
          ${b.credit
            ? `<div class="row"><input id="received" type="text" inputmode="numeric" placeholder="Paid now (leave empty if nothing)" data-bind="bill.received" data-kind="digits" data-rerender="1" data-enter="saveEnter" value="${esc(b.received)}" aria-label="Paid now"></div>
              ${c.due !== undefined ? `<div class="change due"><span>Left to pay (udhaar)</span><span class="num">${money(c.due)}</span></div>` : ''}`
            : isCash(b.method) ? `<div class="row"><input id="received" type="text" inputmode="numeric" placeholder="Amount received" data-bind="bill.received" data-kind="digits" data-rerender="1" data-enter="saveEnter" value="${esc(b.received)}" aria-label="Amount received">
              <button class="btn" data-act="exact" ${t ? '' : 'disabled'}>Exact</button></div>
            ${c.rec !== null && c.ok ? `<div class="change"><span>Change to return</span><span class="num">${money(c.change)}</span></div>` : ''}`
            : `<div class="muted small">${esc(b.method)}: the amount received equals the total.</div>`}
          <div class="row"><input type="text" id="cname" placeholder="${b.credit ? 'Customer name (needed)' : 'Customer (optional)'}" data-bind="bill.name" value="${esc(b.name)}" aria-label="Customer name">
            <input type="text" id="cphone" placeholder="${b.credit ? 'Phone (needed)' : 'Phone (optional)'}" data-bind="bill.phone" value="${esc(b.phone)}" aria-label="Customer phone"></div>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary big" data-act="save" data-print="1" ${c.ok && !S.saving ? '' : 'disabled'}>${S.saving ? 'Saving...' : 'Save and print'}</button>
        <button class="btn" data-act="save" data-print="" ${c.ok && !S.saving ? '' : 'disabled'}>Save without printing</button>
        <div class="hint">${c.ok ? '' : esc(c.hint)}</div>
      </div></div>`;
  }

  // ----- bills -----
  function viewBills() {
    const f = S.bills;
    const rows = (f.list || []).map((b) => `<tr class="click ${f.sel === b.id ? 'sel' : ''}" data-act="pickBill" data-id="${b.id}">
      <td class="num"><b>${esc(b.invoice || pad4(b.no))}</b></td><td class="num">${when(b.createdAt)}</td>
      <td>${esc(b.customerName || '')} <span class="muted small">${esc(b.customerPhone || '')}</span></td>
      <td class="right num"><b>${money(b.total)}</b></td><td>${esc(b.method)}</td>
      <td>${b.status === 'cancelled' ? '<span class="pill bad">Cancelled</span>' : ''}${b.status !== 'cancelled' && b.due > 0 ? '<span class="pill off">Udhaar</span>' : ''}</td></tr>`).join('');
    const sel = f.sel && (f.list || []).find((b) => b.id === f.sel);
    return `<div class="split">
      <div>
        <div class="card row wrap" style="margin-bottom:12px">
          <div class="field-wrap" style="min-width:220px"><label class="field" for="bq">Find by invoice number, customer, phone or suit</label><input id="bq" type="text" data-bind="bills.text" data-bills="1" value="${esc(f.text)}" placeholder="For example BS-0012, 12, Imran, 0300..., Navy"></div>
          <div><label class="field" for="bfrom">From</label><input id="bfrom" type="date" data-bind="bills.from" data-bills="1" value="${esc(f.from)}"></div>
          <div><label class="field" for="bto">To</label><input id="bto" type="date" data-bind="bills.to" data-bills="1" value="${esc(f.to)}"></div>
          <div><label class="field" for="bst">Status</label><select id="bst" data-bind="bills.state" data-bills="1"><option value="">All</option><option value="paid" ${f.state === 'paid' ? 'selected' : ''}>Paid</option><option value="cancelled" ${f.state === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></div>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          <table><thead><tr><th>Invoice</th><th>Date and time</th><th>Customer</th><th class="right">Total</th><th>Paid by</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">No bills found.</td></tr>'}</tbody></table>
        </div>
      </div>
      <div>${sel ? billDetail(sel) : '<div class="card empty">Pick a bill to see it, reprint it, or cancel it.</div>'}</div>
    </div>`;
  }

  function billDetail(b) {
    const owner = S.user.role === 'owner';
    return `<div class="card">
      <div class="row between"><h2>Bill ${esc(b.invoice || pad4(b.no))}</h2>${b.status === 'cancelled' ? '<span class="pill bad">Cancelled</span>' : '<span class="pill ok">Paid</span>'}</div>
      <div class="muted small" style="margin:4px 0 10px">${when(b.createdAt)} &middot; ${esc(b.cashier)}${b.customerName ? ' &middot; ' + esc(b.customerName) : ''}${b.customerPhone ? ' ' + esc(b.customerPhone) : ''}</div>
      <table>${b.lines.map((l) => `<tr><td>${esc(l.name)}<div class="muted small">${l.qty} x ${money(l.price)}</div></td><td class="right num">${money(l.amount)}</td></tr>`).join('')}</table>
      <div style="margin-top:8px">
        <div class="sum"><span class="muted">Subtotal</span><span class="num">${money(b.subtotal)}</span></div>
        ${b.discount ? `<div class="sum"><span class="muted">Discount ${b.discountType === 'pct' ? '(' + Number(b.discountValue) + '%)' : ''}</span><span class="num">-${money(b.discount)}</span></div>` : ''}
        <div class="sum" style="font-size:18px;font-weight:700"><span>Total</span><span class="num">${money(b.total)}</span></div>
        ${b.due > 0
          ? `<div class="sum muted"><span>Udhaar</span><span class="num">Paid ${money(b.paid)}, owes ${money(b.due)}</span></div>`
          : `<div class="sum muted"><span>Paid by ${esc(b.method)}</span><span class="num">${isCash(b.method) ? 'Received ' + money(b.received) + ', change ' + money(b.change) : ''}</span></div>`}
        ${owner && b.status === 'paid' && 'profit' in b ? `<div class="sum muted"><span>Profit on this bill</span><span class="num">${b.profit === null ? 'cost not set' : shown(b.profit)}</span></div>` : ''}
        ${b.status === 'cancelled' ? `<div class="hint" style="margin-top:8px">Cancelled by ${esc(b.cancelledBy)}: ${esc(b.cancelReason)}</div>` : ''}
      </div>
      <div class="row wrap" style="margin-top:12px">
        ${b.status === 'paid' ? `<button class="btn primary" data-act="reprint" data-id="${b.id}">Reprint (marked duplicate)</button>` : ''}
        <button class="btn" data-act="previewBill" data-id="${b.id}">${S.bills.preview ? 'Hide receipt' : 'Show receipt'}</button>
        <button class="btn" data-act="pdfBill" data-id="${b.id}">Save as PDF</button>
        ${owner && b.status === 'paid' ? `<button class="btn danger" data-act="cancelAsk" data-id="${b.id}">Cancel this bill</button>` : ''}
      </div>
      ${S.bills.preview ? `<div style="margin-top:12px"><iframe class="receipt-frame" sandbox="" srcdoc="${esc(S.bills.preview)}" title="Receipt"></iframe></div>` : ''}
    </div>`;
  }

  // ----- inventory: the suits, their prices, costs and how many are in the shop -----
  function viewInventory() {
    const owner = S.user.role === 'owner';
    const all = owner ? S.prices.all : S.suits;
    const q = S.prices.q.trim().toLowerCase();
    const list = all.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.group || '').toLowerCase().includes(q));
    const lowAt = S.settings.lowStockAt;
    const counted = all.filter((s) => s.active && stockOf(s) !== null);
    const pieces = counted.reduce((n, s) => n + s.stock, 0);
    const outN = counted.filter((s) => s.stock === 0).length;
    const lowN = counted.filter((s) => s.stock > 0 && s.stock <= lowAt).length;
    const noCost = '<span class="muted small">not set</span>';
    const stockCell = (s) => {
      const st = stockOf(s);
      if (st === null) return '<span class="muted small">not counted</span>';
      if (st === 0) return '<span class="pill bad">Out</span>';
      return `<b class="num">${st}</b>${st <= lowAt ? ' <span class="pill warn">Low</span>' : ''}`;
    };
    const rows = list.map((s) => {
      const has = s.cost !== null && s.cost !== undefined;
      return `<tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.group || '')}</td><td class="right num">${money(s.price)}</td>
      ${owner ? `<td class="right num">${has ? shown(s.cost) : noCost}</td><td class="right num">${has ? shown(s.price - s.cost) : noCost}</td>` : ''}
      <td class="right">${stockCell(s)}</td>
      <td>${s.active ? '<span class="pill ok">On</span>' : '<span class="pill off">Off</span>'}</td>
      <td class="right" style="white-space:nowrap">${owner ? `<button class="btn small" data-act="stockIn" data-id="${s.id}">+ Stock</button> <button class="btn small" data-act="editSuit" data-id="${s.id}">Edit</button>` : ''}</td></tr>`;
    }).join('');
    const log = owner && S.stock.log.length
      ? `<div class="card" style="margin-top:14px;padding:0;overflow:hidden"><div style="padding:12px 14px 6px"><h2>Recent stock changes</h2></div>
          <table><thead><tr><th>When</th><th>Suit</th><th class="right">Change</th><th class="right">Now</th><th>Why</th></tr></thead><tbody>
          ${S.stock.log.map((x) => `<tr><td class="num">${when(x.at)}</td><td>${esc(x.name)}</td><td class="right num"><span class="pill ${x.delta > 0 ? 'ok' : 'off'}">${x.delta > 0 ? '+' : ''}${x.delta}</span></td><td class="right num">${x.balance}</td><td class="muted">${esc(x.reason)}${x.by ? ' &middot; ' + esc(x.by) : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '';
    return `<div class="stats" style="margin-bottom:12px">
        <div class="stat"><div class="k">Suits on sale</div><div class="v num">${all.filter((s) => s.active).length}</div></div>
        <div class="stat"><div class="k">Pieces in stock (counted suits)</div><div class="v num">${counted.length ? pieces : '-'}</div></div>
        <div class="stat"><div class="k">Running low</div><div class="v num" style="${lowN ? 'color:var(--warn)' : ''}">${counted.length ? lowN : '-'}</div></div>
        <div class="stat"><div class="k">Out of stock</div><div class="v num" style="${outN ? 'color:var(--danger)' : ''}">${counted.length ? outN : '-'}</div></div>
      </div>
      <div class="card row wrap" style="margin-bottom:12px">
        <div class="field-wrap" style="min-width:240px"><label class="field" for="pq">Search the suits</label><input id="pq" type="text" data-bind="prices.q" data-rerender="1" value="${esc(S.prices.q)}" placeholder="Suit name or group"></div>
        ${owner ? '<div style="align-self:flex-end" class="row wrap"><button class="btn primary" data-act="addSuit">Add a suit</button><button class="btn primary" data-act="addSizes">Add with sizes</button><button class="btn" data-act="pasteList">Paste a list</button><button class="btn" data-act="pasteStock">Paste stock counts</button>' + eyeBtn() + '</div>' : '<div class="muted small" style="align-self:flex-end">Only the owner can change prices and stock.</div>'}
      </div>
      <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Suit</th><th>Group</th><th class="right">Price</th>${owner ? '<th class="right">Cost</th><th class="right">Profit each</th>' : ''}<th class="right">In stock</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${owner ? 8 : 5}" class="empty">No suits yet.</td></tr>`}</tbody></table></div>
      ${log}
      ${owner ? '<div class="muted small" style="margin-top:8px">Cost and profit stay hidden until you click the eye. A suit with an empty stock box is not counted and can always be sold. Counted suits go down with every sale and cannot be sold when they run out.</div>' : ''}`;
  }

  // ----- udhaar (owner): who owes money, and money received back -----
  function viewUdhaar() {
    const U = S.udhaar;
    const q = U.q.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    const all = U.list ? U.list.customers : [];
    const list = all.filter((c) => !q || c.name.toLowerCase().includes(q) || (qd && c.phone.replace(/\D/g, '').includes(qd)));
    const rows = list.map((c) => `<tr class="click ${U.sel === c.key ? 'sel' : ''}" data-act="pickUdhaar" data-key="${esc(c.key)}">
      <td><b>${esc(c.name)}</b><div class="muted small">${esc(c.phone)}</div></td><td class="num">${c.lastAt ? when(c.lastAt) : ''}</td>
      <td class="right num"><b>${money(c.balance)}</b></td></tr>`).join('');
    const d = U.detail;
    let detail = '<div class="card empty">Pick a customer to see their bills and to record money they bring back.</div>';
    if (d) {
      const p = U.pay || { amount: '', method: S.settings.paymentMethods[0], note: '' };
      const methods = S.settings.paymentMethods.map((m) => `<button class="chip ${p.method === m ? 'on' : ''}" data-act="payMethod" data-v="${esc(m)}">${esc(m)}</button>`).join('');
      detail = `<div class="card">
        <div class="row between"><div><h2>${esc(d.name)}</h2><div class="muted small">${esc(d.phone)}</div></div>
          <div class="right"><div class="muted small">Owes</div><div style="font-size:24px;font-weight:700" class="num">${money(d.balance)}</div></div></div>
        <div class="stack" style="margin-top:12px">
          <label class="field" for="u-amt" style="margin:0">Money received now</label>
          <div class="row"><input id="u-amt" type="text" inputmode="numeric" data-bind="udhaar.pay.amount" data-kind="digits" data-rerender="1" data-enter="receiveUdhaar" value="${esc(p.amount)}" placeholder="Amount (Rs.)" aria-label="Amount received">
            <button class="btn" data-act="fullUdhaar">Full ${money(d.balance)}</button></div>
          <div class="chips">${methods}</div>
          <input id="u-note" type="text" data-bind="udhaar.pay.note" placeholder="Note (optional)" value="${esc(p.note)}" aria-label="Note">
          <button class="btn primary" data-act="receiveUdhaar" ${U.busy ? 'disabled' : ''}>${U.busy ? 'Saving...' : 'Receive money'}</button>
        </div>
        <h2 style="margin:16px 0 6px">Bills with udhaar</h2>
        <table><thead><tr><th>No.</th><th>Date</th><th class="right">Total</th><th class="right">Paid</th><th class="right">Left</th></tr></thead><tbody>
          ${d.billList.map((b) => `<tr><td class="num">${esc(b.invoice || pad4(b.no))}</td><td class="num" style="white-space:nowrap">${when(b.createdAt).split(' ')[0]}</td><td class="right num">${money(b.total)}</td><td class="right num">${money(b.paid)}</td><td class="right num"><b>${money(b.due)}</b></td></tr>`).join('')}</tbody></table>
        <h2 style="margin:16px 0 6px">Money received back</h2>
        ${d.payments.length ? `<table><tbody>${d.payments.slice().reverse().map((x) => `<tr><td class="num">${when(x.at)}</td><td>${esc(x.method)}${x.note ? ' <span class="muted small">' + esc(x.note) + '</span>' : ''}</td><td class="right num"><b>${money(x.amount)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="muted small">Nothing received back yet.</div>'}
      </div>`;
    }
    return `<div class="split">
      <div>
        <div class="stats" style="margin-bottom:12px">
          <div class="stat"><div class="k">Total udhaar to collect</div><div class="v num">${U.list ? money(U.list.total) : '-'}</div></div>
          <div class="stat"><div class="k">Customers who owe</div><div class="v num">${U.list ? U.list.customers.length : '-'}</div></div>
        </div>
        <div class="card" style="margin-bottom:12px"><label class="field" for="uq">Find a customer by name or phone</label><input id="uq" type="text" data-bind="udhaar.q" data-rerender="1" value="${esc(U.q)}" placeholder="Name or phone"></div>
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Customer</th><th>Last activity</th><th class="right">Owes</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="3" class="empty">${all.length ? 'No customer matches.' : 'Nobody owes anything.'}</td></tr>`}</tbody></table></div>
        <div class="muted small" style="margin-top:8px">Udhaar is never printed on the customer's receipt. To start one, choose Udhaar on the New bill screen.</div>
      </div>
      <div>${detail}</div>
    </div>`;
  }

  // ----- profit (owner, hidden until the eye is clicked) -----
  function viewProfit() {
    const on = S.reveal.on;
    const p = S.profit.data;
    const v = (n) => (on && p ? money(n) : DOTS);
    let diff = '';
    if (on && p) {
      const delta = p.profit - p.prev.profit;
      diff = p.prev.known ? `${delta >= 0 ? '+' : '-'}${money(Math.abs(delta))} compared with ${esc(p.prev.ym)}` : '';
    }
    const margin = on && p && p.sales > 0 ? Math.round((p.profit * 100) / p.sales) + '%' : on && p ? '-' : DOTS;
    const warn = on && p && p.unknown > 0
      ? `<div class="card" style="margin-top:12px;background:var(--warn-soft)"><b>${p.unknown} bill${p.unknown === 1 ? ' is' : 's are'} left out of the profit,</b> because a suit on ${p.unknown === 1 ? 'it' : 'them'} has no cost price.
          ${p.missingCost.length ? '<div class="small" style="margin-top:4px">Add a cost for: ' + p.missingCost.map(esc).join(', ') + '. Then new bills will count.</div>' : ''}</div>`
      : (on && p && p.missingCost.length ? `<div class="muted small" style="margin-top:8px">Suits with no cost price yet: ${p.missingCost.map(esc).join(', ')}.</div>` : '');
    return `<div class="card row between" style="margin-bottom:12px">
        <div class="muted">${on ? 'Figures are visible for a few seconds, then hide again.' : 'Profit is hidden. Click the eye to show it.'}</div>${eyeBtn()}</div>
      <div class="row wrap" style="margin-bottom:10px"><h2>${S.profit.day ? 'One day' : 'One month'}</h2>
        <input type="month" id="pmonth" data-bind="profit.month" data-profit="1" data-clearday="1" value="${esc(S.profit.month)}" style="width:170px" aria-label="Pick a month">
        <span class="muted">or a single day</span>
        <input type="date" id="pday" data-bind="profit.day" data-profit="1" value="${esc(S.profit.day)}" style="width:170px" aria-label="Pick a day">
        ${S.profit.day ? '<button class="btn small" data-act="profitMonth">Whole month</button>' : ''}</div>
      <div class="stats">
        <div class="stat"><div class="k">Profit</div><div class="v num">${v(p ? p.profit : 0)}</div><div class="muted small" style="margin-top:4px">${diff}</div></div>
        <div class="stat"><div class="k">Sales counted</div><div class="v num">${v(p ? p.sales : 0)}</div></div>
        <div class="stat"><div class="k">Cost of the suits</div><div class="v num">${v(p ? p.cost : 0)}</div></div>
        <div class="stat"><div class="k">Discounts given</div><div class="v num">${v(p ? p.discounts : 0)}</div></div>
        <div class="stat"><div class="k">Margin (profit out of sales)</div><div class="v num">${margin}</div></div>
      </div>
      ${warn}
      ${on && p && p.byCategory.length ? `<div class="card" style="padding:0;overflow:hidden;margin-top:12px"><table><thead><tr><th>Category</th><th class="right">Sold</th><th class="right">Sales</th><th class="right">Profit</th></tr></thead><tbody>
          ${p.byCategory.map((x) => `<tr><td>${esc(x.name)}</td><td class="right num">${x.qty}</td><td class="right num">${money(x.sales)}</td><td class="right num"><b>${money(x.profit)}</b></td></tr>`).join('')}</tbody></table></div>` : ''}
      ${on && p ? `<div class="split" style="margin-top:12px">
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Day</th><th class="right">Sales</th><th class="right">Cost</th><th class="right">Profit</th></tr></thead><tbody>
          ${p.byDay.map((x) => `<tr><td>${dayLabel(x.dateKey)}</td><td class="right num">${money(x.sales)}</td><td class="right num">${money(x.cost)}</td><td class="right num"><b>${money(x.profit)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No sales this month.</td></tr>'}</tbody></table></div>
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Suit</th><th class="right">Sold</th><th class="right">Profit*</th></tr></thead><tbody>
          ${p.bySuit.map((x) => `<tr><td>${esc(x.name)}</td><td class="right num">${x.qty}</td><td class="right num">${money(x.profit)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nothing sold yet.</td></tr>'}</tbody></table></div>
      </div>
      <div class="muted small" style="margin-top:8px">Profit = what the customer paid after discount, minus the cost of the suits. Udhaar bills count on the day the bill is made. *Suit profit is before discounts.</div>` : ''}`;
  }

  // ----- sales (owner, hidden until the eye is clicked) -----
  function viewSales() {
    const on = S.reveal.on;
    const d = S.sales.day_data;
    const m = S.sales.month_data;
    const methods = on && d ? Object.entries(d.byMethod).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="right num">${money(v)}</td></tr>`).join('') : '';
    let diff = '';
    if (on && m) {
      const delta = m.sales - m.prev.sales;
      const pct = m.prev.sales > 0 ? ` (${delta >= 0 ? '+' : ''}${Math.round((delta * 100) / m.prev.sales)}%)` : '';
      diff = `${delta >= 0 ? '+' : '-'}${money(Math.abs(delta))}${pct} compared with ${esc(m.prev.ym)}`;
    }
    return `<div class="card row between" style="margin-bottom:12px">
        <div class="muted">${on ? 'Figures are visible for a few seconds, then hide again.' : 'Sales are hidden. Click the eye to show them.'}</div>${eyeBtn()}</div>
      <div class="row wrap" style="margin-bottom:10px"><h2>One day</h2>
        <input type="date" id="sday" data-bind="sales.day" data-sales="1" value="${esc(S.sales.day)}" style="width:170px" aria-label="Pick a day">
        <button class="btn" data-act="dayPdf">Download this day (PDF)</button></div>
      <div class="stats">
        <div class="stat"><div class="k">Sales</div><div class="v num">${on && d ? money(d.sales) : DOTS}</div></div>
        <div class="stat"><div class="k">Bills</div><div class="v num">${on && d ? d.bills : DOTS}</div></div>
        <div class="stat"><div class="k">Discounts given</div><div class="v num">${on && d ? money(d.discounts) : DOTS}</div></div>
        <div class="stat"><div class="k">Cancelled bills</div><div class="v num">${on && d ? d.cancelled : DOTS}</div></div>
      </div>
      ${on && d && methods ? `<div class="card" style="margin-top:12px"><h2 style="margin-bottom:6px">By payment method</h2><table><tbody>${methods}</tbody></table></div>` : ''}
      <div class="row wrap" style="margin:22px 0 10px"><h2>One month</h2>
        <input type="month" id="smonth" data-bind="sales.month" data-sales="1" value="${esc(S.sales.month)}" style="width:170px" aria-label="Pick a month"></div>
      <div class="stats">
        <div class="stat"><div class="k">Sales this month</div><div class="v num">${on && m ? money(m.sales) : DOTS}</div><div class="muted small" style="margin-top:4px">${diff}</div></div>
        <div class="stat"><div class="k">Bills</div><div class="v num">${on && m ? m.bills : DOTS}</div></div>
        <div class="stat"><div class="k">Last month (${on && m ? esc(m.prev.ym) : '--'})</div><div class="v num">${on && m ? money(m.prev.sales) : DOTS}</div></div>
      </div>
      ${on && m ? `<div class="split" style="margin-top:12px">
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Day</th><th class="right">Bills</th><th class="right">Sales</th></tr></thead><tbody>
          ${m.byDay.map((x) => `<tr><td>${dayLabel(x.dateKey)}</td><td class="right num">${x.bills}</td><td class="right num">${money(x.sales)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No sales this month.</td></tr>'}</tbody></table></div>
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Best sellers</th><th class="right">Sold</th></tr></thead><tbody>
          ${m.topSuits.map((x) => `<tr><td>${esc(x.name)}</td><td class="right num">${x.qty}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">Nothing sold yet.</td></tr>'}</tbody></table></div>
      </div>` : ''}`;
  }

  // ----- settings (owner) -----
  function viewSettings() {
    const f = S.form;
    if (!f) return '<div class="empty">Loading...</div>';
    const printers = S.printers || [];
    const info = S.info;
    const lb = info && info.lastBackup;
    const img = (key, label) => `<div class="row" style="margin-top:8px"><div style="width:110px"><b>${label}</b></div>
      ${S.settings[key] ? `<img class="imgprev" src="${esc(S.settings[key])}" alt="${label}">` : '<span class="muted small">None</span>'}
      <button class="btn small" data-act="pickImage" data-key="${key}">Choose picture</button>
      ${S.settings[key] ? `<button class="btn small" data-act="clearImage" data-key="${key}">Remove</button>` : ''}</div>`;
    return `<div style="max-width:780px">
      <div class="card"><h2>Shop details (printed on the receipt)</h2><div class="stack" style="margin-top:10px">
        <div><label class="field" for="f-shop">Shop name</label><input id="f-shop" type="text" data-bind="form.shopName" value="${esc(f.shopName)}"></div>
        <div><label class="field" for="f-addr">Address</label><input id="f-addr" type="text" data-bind="form.address" value="${esc(f.address)}"></div>
        <div class="row"><div class="field-wrap"><label class="field" for="f-ph">Phone</label><input id="f-ph" type="text" data-bind="form.phone" value="${esc(f.phone)}"></div>
          <div class="field-wrap"><label class="field" for="f-wa">WhatsApp number</label><input id="f-wa" type="text" data-bind="form.whatsapp" value="${esc(f.whatsapp)}"></div></div>
        <div><label class="field" for="f-ft">Thank-you line at the bottom of the receipt</label><input id="f-ft" type="text" data-bind="form.footer" value="${esc(f.footer)}"></div>
        <div class="row"><div class="field-wrap"><label class="field" for="f-ex">Exchange line (printed under it)</label><input id="f-ex" type="text" data-bind="form.exchangeNote" value="${esc(f.exchangeNote)}"></div>
          <div style="width:150px"><label class="field" for="f-inv">Invoice letters</label><input id="f-inv" type="text" data-bind="form.invoicePrefix" value="${esc(f.invoicePrefix)}" maxlength="4" placeholder="BS"></div></div>
        ${img('logo', 'Logo')}${img('qr', 'WhatsApp QR')}
        <div><button class="btn primary" data-act="saveShop">Save shop details</button></div></div></div>

      <div class="card"><h2>Receipt printer</h2><div class="stack" style="margin-top:10px">
        <div class="row"><div class="field-wrap"><label class="field" for="f-pw">Paper width</label><select id="f-pw" data-bind="form.paperWidthMm" data-kind="number"><option value="80" ${Number(f.paperWidthMm) === 80 ? 'selected' : ''}>80 mm (wide roll)</option><option value="58" ${Number(f.paperWidthMm) === 58 ? 'selected' : ''}>58 mm (narrow roll)</option></select></div>
          <div class="field-wrap"><label class="field" for="f-pr">Printer</label><select id="f-pr" data-bind="form.printerName"><option value="">Windows default printer</option>
            ${printers.map((p) => `<option value="${esc(p.name)}" ${f.printerName === p.name ? 'selected' : ''}>${esc(p.displayName)}${p.isDefault ? ' (default)' : ''}</option>`).join('')}</select></div></div>
        <div class="row"><div class="field-wrap"><label class="field" for="f-off">Move the receipt sideways (mm, from -10 to 10). Use this only if it prints off-centre.</label><input id="f-off" type="text" inputmode="numeric" data-bind="form.receiptOffsetMm" data-kind="signed" value="${esc(f.receiptOffsetMm)}" style="max-width:120px"></div></div>
        <label class="row"><input type="checkbox" data-bind="form.silentPrint" ${f.silentPrint ? 'checked' : ''}> Print straight away, without asking each time</label>
        <div class="row"><button class="btn primary" data-act="savePrinter">Save printer settings</button><button class="btn" data-act="testPrint">Print a test receipt</button><button class="btn" data-act="testPreview">Preview</button></div></div></div>

      <div class="card"><h2>Discounts and payment methods</h2><div class="stack" style="margin-top:10px">
        <div class="row"><div class="field-wrap"><label class="field" for="f-dl">Largest discount staff can give (%)</label><input id="f-dl" type="text" inputmode="decimal" data-bind="form.discountLimitPct" data-kind="decimal" value="${esc(f.discountLimitPct)}"></div>
          <div class="field-wrap"><label class="field" for="f-pm">Payment methods (separate with commas)</label><input id="f-pm" type="text" data-bind="form.paymentMethodsText" value="${esc(f.paymentMethodsText)}"></div></div>
        <div class="row"><div class="field-wrap"><label class="field" for="f-ls">Mark a suit Low when this many or fewer are left</label><input id="f-ls" type="text" inputmode="numeric" data-bind="form.lowStockAt" data-kind="digits" value="${esc(f.lowStockAt)}" style="max-width:120px"></div></div>
        <label class="row"><input type="checkbox" data-bind="form.revealNeedsPassword" ${f.revealNeedsPassword ? 'checked' : ''}> Ask for the password before showing sales</label>
        <div><button class="btn primary" data-act="saveRules">Save</button></div></div></div>

      <div class="card"><h2>Backup</h2><div class="stack" style="margin-top:10px">
        <div class="muted">A copy of all data is saved every day on this computer. Choose a USB drive too, so the data survives if this computer breaks.</div>
        <div class="row wrap"><b>USB drive or folder:</b> <span>${esc(S.settings.backupDir || 'Not chosen yet')}</span>
          <button class="btn small" data-act="pickBackup">Choose</button>${S.settings.backupDir ? '<button class="btn small" data-act="clearBackup">Remove</button>' : ''}</div>
        <div class="row wrap"><button class="btn" data-act="backupNow">Back up now</button>
          <span class="${lb && lb.ok === false ? 'hint' : 'muted'}">${lb && lb.at ? (lb.ok ? 'Last backup: ' + when(lb.at) : esc(lb.error)) : 'No backup made yet in this session.'}</span></div></div></div>

      <div class="card"><h2>People who can log in</h2>
        <table style="margin-top:8px"><tbody>${(S.users || []).map((u) => `<tr><td><b>${esc(u.name)}</b> <span class="muted small">${esc(u.username)}</span></td><td>${u.role === 'owner' ? 'Owner' : 'Staff'}</td>
          <td>${u.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Off</span>'}</td>
          <td class="right"><button class="btn small" data-act="userPw" data-id="${u.id}">New password</button>
          ${u.role !== 'owner' ? `<button class="btn small" data-act="userToggle" data-id="${u.id}">${u.active ? 'Switch off' : 'Switch on'}</button>` : ''}</td></tr>`).join('')}</tbody></table>
        <div class="row wrap" style="margin-top:12px"><div class="field-wrap"><label class="field" for="nu-n">Staff name</label><input id="nu-n" type="text" data-bind="newUser.name" value="${esc(S.newUser.name)}"></div>
          <div class="field-wrap"><label class="field" for="nu-u">Username</label><input id="nu-u" type="text" data-bind="newUser.username" value="${esc(S.newUser.username)}"></div>
          <div class="field-wrap"><label class="field" for="nu-p">Password</label>${pwInput('nu-p', 'newUser.password', S.newUser.password, { label: 'Staff password' })}</div>
          <button class="btn primary" style="align-self:flex-end" data-act="addUser">Add staff</button></div></div>

      <div class="card"><h2>Forgot-password code</h2><div class="stack" style="margin-top:10px">
        <div class="muted">${S.recovery && S.recovery.exists ? 'A recovery code was made on ' + when(S.recovery.createdAt) + '. If the owner password is forgotten, choose <b>Forgot password?</b> on the log in screen and type the code.' : '<b style="color:var(--warn)">No recovery code yet.</b> Make one now and write it on paper. Without it, a forgotten password cannot be reset.'}</div>
        <div><button class="btn primary" data-act="recoveryAsk">${S.recovery && S.recovery.exists ? 'Make a new code' : 'Make a recovery code'}</button></div>
        <div class="muted small">A new code replaces the old one. Keep the paper away from the shop computer.</div></div></div>

      <div class="card"><h2>Start fresh (before opening)</h2><div class="stack" style="margin-top:10px">
        <div class="muted">Done testing? This removes all test bills, udhaar and profit figures so you begin from zero. Suits, prices and logins stay.</div>
        ${S.settings.liveLocked ? '<div class="pill ok" style="align-self:flex-start">Real sales have started. Test clearing is switched off.</div>' : `<div class="row wrap"><button class="btn danger" data-act="clearBeforeAsk">Delete test bills before a date</button><button class="btn danger" data-act="clearTestAsk">Clear all test data</button><button class="btn primary" data-act="goLiveAsk">Start real sales (lock this)</button></div>`}</div></div>

      <div class="card"><h2>Change my password</h2><div class="row wrap" style="margin-top:10px">
        <div class="field-wrap"><label class="field" for="p-o">Current password</label>${pwInput('p-o', 'pw.old', S.pw.old, { label: 'Current password' })}</div>
        <div class="field-wrap"><label class="field" for="p-a">New password</label>${pwInput('p-a', 'pw.a', S.pw.a, { label: 'New password' })}</div>
        <div class="field-wrap"><label class="field" for="p-b">New password again</label>${pwInput('p-b', 'pw.b', S.pw.b, { label: 'New password again' })}</div>
        <button class="btn primary" style="align-self:flex-end" data-act="changePw">Change</button></div></div>

      <div class="muted small" style="margin-top:14px">${info ? 'Version ' + esc(info.version) + ' &middot; Data file: ' + esc(info.dataFile) : ''}</div>
    </div>`;
  }

  // ----- dialogs -----
  function modalHtml() {
    const m = S.modal;
    if (S.done) {
      const d = S.done;
      const b = d.bill;
      const status = { printing: '<span class="muted">Printing...</span>', ok: '<span class="pill ok">Receipt printed</span>', skipped: '<span class="muted">Saved without printing.</span>', failed: `<span class="hint">The bill is saved, but it did not print: ${esc(d.error)}</span>` }[d.print];
      return `<div class="overlay"><div class="dialog" role="dialog" aria-label="Bill saved">
        <h2>Bill ${esc(b.invoice || pad4(b.no))} saved</h2><div class="stack">
          <div class="sum total"><span>Total</span><span class="num">${money(b.total)}</span></div>
          ${b.due > 0 ? `<div class="muted small right">${b.paid > 0 ? 'Paid now ' + money(b.paid) + ' (' + esc(b.method) + ')' : 'Nothing paid now'}</div><div class="big-change due num">Udhaar: ${money(b.due)}</div><div class="muted small right">${esc(b.customerName)} ${esc(b.customerPhone)}</div>`
            : isCash(b.method) ? `<div class="muted small right">Received ${money(b.received)}</div><div class="big-change num">Change: ${money(b.change)}</div>` : `<div class="muted">Paid by ${esc(b.method)}</div>`}
          <div>${status}</div>
          <div class="row"><button class="btn" data-act="printAgain" data-id="${b.id}" ${d.print === 'printing' ? 'disabled' : ''}>${d.print === 'failed' ? 'Try printing again' : 'Print again'}</button>
            <button class="btn primary grow" id="newbill" data-act="newbill" data-autofocus="1">New bill</button></div></div></div></div>`;
    }
    if (!m) return '';
    if (m.type === 'password') {
      return `<div class="overlay"><div class="dialog"><h2>Enter your password</h2><div class="stack">
        <div class="muted small">To show sales, profit and cost, please confirm it is you. You will not be asked again until the program is closed and opened again.</div>
        ${pwInput('m-pw', 'modal.value', m.value || '', { enter: 'modalOk', autofocus: true, label: 'Password' })}
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Show</button></div></div></div></div>`;
    }
    if (m.type === 'suit') {
      const groups = [...new Set(S.prices.all.map((s) => s.group).filter(Boolean))];
      return `<div class="overlay"><div class="dialog"><h2>${m.id ? 'Edit suit' : 'Add a suit'}</h2><div class="stack">
        <div><label class="field" for="m-name">Suit name (no company name needed)</label><input id="m-name" type="text" data-bind="modal.name" data-enter="modalOk" data-autofocus="1" value="${esc(m.name)}"></div>
        <div class="row"><div class="field-wrap"><label class="field" for="m-price">Selling price (Rs.)</label><input id="m-price" type="text" inputmode="numeric" data-bind="modal.price" data-kind="digits" data-enter="modalOk" value="${esc(m.price)}"></div>
          <div class="field-wrap"><label class="field" for="m-cost">Cost price (Rs.), for profit</label><input id="m-cost" type="text" inputmode="numeric" data-bind="modal.cost" data-kind="digits" data-enter="modalOk" value="${esc(m.cost)}" placeholder="Optional"></div></div>
        <div class="row"><div class="field-wrap"><label class="field" for="m-group">Group (optional)</label><input id="m-group" list="groups" type="text" data-bind="modal.group" data-enter="modalOk" value="${esc(m.group)}"><datalist id="groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></div>
          <div class="field-wrap"><label class="field" for="m-stock">In stock now</label><input id="m-stock" type="text" inputmode="numeric" data-bind="modal.stock" data-kind="digits" data-enter="modalOk" value="${esc(m.stock)}" placeholder="Empty = not counted"></div></div>
        ${m.base ? `<label class="row"><input type="checkbox" data-bind="modal.allSizes" ${m.allSizes ? 'checked' : ''}> Use this price and cost for all sizes of ${esc(m.base)}</label>` : ''}
        ${m.id ? `<label class="row"><input type="checkbox" data-bind="modal.active" ${m.active ? 'checked' : ''}> Show this suit when billing</label>` : ''}
        <div class="muted small">Changing a price or cost affects new bills only. Old bills keep the price and cost they were sold at. Without a cost price, profit for that suit stays unknown.</div>
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Save</button></div></div></div></div>`;
    }
    if (m.type === 'sizepick') {
      const order = ['S', 'M', 'L', 'XL'];
      const sibs = S.suits.filter((x) => x.base === m.base).sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size));
      const inB = new Map(S.bill.lines.map((l) => [l.suitId, l.qty]));
      return `<div class="overlay"><div class="dialog"><h2>${esc(m.base)}: choose a size</h2><div class="stack">
        <div class="tiles" style="grid-template-columns:repeat(2,1fr)">${sibs.map((x) => {
          const st = stockOf(x);
          return `<button class="tile ${inB.has(x.id) ? 'in' : ''} ${st === 0 ? 'out' : ''}" data-act="pickSize" data-id="${x.id}" ${st === 0 ? 'disabled' : ''}><span class="nm">${esc(x.size)}</span><span><span class="pr num">${money(x.price)}</span><br><span class="stk ${st === 0 ? 'out' : ''}">${st === null ? '' : st === 0 ? 'Out of stock' : st + ' in stock'}</span></span>${inB.has(x.id) ? `<span class="qty">x${inB.get(x.id)}</span>` : ''}</button>`;
        }).join('')}</div>
        <div class="row"><button class="btn grow" data-act="modalCancel">Close</button></div></div></div></div>`;
    }
    if (m.type === 'sizes') {
      const cats = ['Suits', 'Kurtas', 'Waistcoats', 'Shawls'];
      return `<div class="overlay"><div class="dialog"><h2>Add an item with sizes</h2><div class="stack">
        <div><label class="field" for="m-base">Item name (for example Kurta Black)</label><input id="m-base" type="text" data-bind="modal.base" data-autofocus="1" value="${esc(m.base)}"></div>
        <div class="chips">${cats.map((g) => `<button class="chip ${m.group === g ? 'on' : ''}" data-act="sizeCat" data-v="${g}">${g}</button>`).join('')}</div>
        <div class="row"><div class="field-wrap"><label class="field" for="m-sp">Selling price (Rs.)</label><input id="m-sp" type="text" inputmode="numeric" data-bind="modal.price" data-kind="digits" value="${esc(m.price)}"></div>
          <div class="field-wrap"><label class="field" for="m-sc">Cost price (Rs.)</label><input id="m-sc" type="text" inputmode="numeric" data-bind="modal.cost" data-kind="digits" value="${esc(m.cost)}" placeholder="Optional"></div></div>
        <div class="muted small">How many pieces of each size are in the shop? Leave a size empty if you do not stock it.</div>
        <div class="row">${['S', 'M', 'L', 'XL'].map((z) => `<div class="field-wrap"><label class="field" for="m-z${z}">${z}</label><input id="m-z${z}" type="text" inputmode="numeric" data-bind="modal.z${z}" data-kind="digits" value="${esc(m['z' + z])}"></div>`).join('')}</div>
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Save sizes</button></div></div></div></div>`;
    }
    if (m.type === 'clearBefore' || m.type === 'goLive') {
      const live = m.type === 'goLive';
      return `<div class="overlay"><div class="dialog"><h2>${live ? 'Start real sales?' : 'Delete test bills before a date'}</h2><div class="stack">
        <div class="muted small">${live ? 'After this, the Clear test data buttons are removed for good, so real bills can never be wiped by a slip. This cannot be undone.' : 'Bills made <b>before</b> this date are deleted and their pieces go back into stock. Bills from this date on are kept. A backup copy is made first.'}</div>
        ${live ? '' : `<div><label class="field" for="m-date">Delete bills before</label><input id="m-date" type="date" data-bind="modal.date" value="${esc(m.date)}"></div>
        <div><label class="field" for="m-word">Type CLEAR to confirm</label><input id="m-word" type="text" data-bind="modal.word" value="${esc(m.word)}"></div>`}
        ${pwInput('m-cpw', 'modal.value', m.value || '', { enter: 'modalOk', label: 'Password' })}
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">${live ? 'Start real sales' : 'Delete test bills'}</button></div></div></div></div>`;
    }
    if (m.type === 'paste') {
      return `<div class="overlay"><div class="dialog wide"><h2>Paste a list of suits</h2><div class="stack">
        <div class="muted small">One suit on each line, with its price. For example:<br><b>Navy Blue Suit, 4000</b><br><b>Black Suit 4500</b><br>With the cost price after the price: <b>Navy Blue Suit, 4000, 2800</b><br>A group can be added at the end: <b>White Suit, 3800, 2500, Plain</b>. A suit already in the list gets its price updated.</div>
        <textarea id="m-paste" rows="9" data-bind="modal.text" data-autofocus="1" placeholder="Navy Blue Suit, 4000">${esc(m.text)}</textarea>
        ${m.result ? `<div class="pill ok" style="align-self:flex-start">${m.result.added} added, ${m.result.updated} updated</div>${m.result.skipped.length ? `<div class="hint">These lines were skipped (no price found):<br>${m.result.skipped.map(esc).join('<br>')}</div>` : ''}` : ''}
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">${m.result ? 'Close' : 'Cancel'}</button><button class="btn primary grow" data-act="modalOk">Add to the price list</button></div></div></div></div>`;
    }
    if (m.type === 'cancel') {
      return `<div class="overlay"><div class="dialog"><h2>Cancel bill ${pad4(m.no)}?</h2><div class="stack">
        <div class="muted small">The bill stays in the records, marked cancelled, and is taken out of the sales totals.</div>
        <div><label class="field" for="m-reason">Reason</label><input id="m-reason" type="text" data-bind="modal.reason" data-enter="modalOk" data-autofocus="1" value="${esc(m.reason)}"></div>
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Keep the bill</button><button class="btn danger grow" data-act="modalOk">Cancel this bill</button></div></div></div></div>`;
    }
    if (m.type === 'userpw') {
      return `<div class="overlay"><div class="dialog"><h2>New password for ${esc(m.name)}</h2><div class="stack">
        ${pwInput('m-upw', 'modal.value', m.value || '', { enter: 'modalOk', autofocus: true, label: 'New password' })}
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Save</button></div></div></div></div>`;
    }
    if (m.type === 'stockin') {
      return `<div class="overlay"><div class="dialog"><h2>Stock in: ${esc(m.name)}</h2><div class="stack">
        <div class="muted small">${m.now === null ? 'This suit is not counted yet. The number below becomes its first count.' : 'Now in stock: ' + m.now + '. The number below is added to it.'}</div>
        <div><label class="field" for="m-qty">How many came in?</label><input id="m-qty" type="text" inputmode="numeric" data-bind="modal.qty" data-kind="digits" data-enter="modalOk" data-autofocus="1" value="${esc(m.qty)}"></div>
        <div><label class="field" for="m-note">Note (optional)</label><input id="m-note" type="text" data-bind="modal.note" data-enter="modalOk" value="${esc(m.note)}" placeholder="For example: new delivery"></div>
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Add to stock</button></div></div></div></div>`;
    }
    if (m.type === 'stockpaste') {
      return `<div class="overlay"><div class="dialog wide"><h2>Paste stock counts</h2><div class="stack">
        <div class="muted small">One suit on each line: the name, then how many are in the shop right now. For example:<br><b>Navy Blue Suit, 12</b><br><b>Black Suit 7</b><br>This sets the count for each suit (use it for the first count or a recount). Names must match the Inventory list.</div>
        <textarea id="m-paste" rows="9" data-bind="modal.text" data-autofocus="1" placeholder="Navy Blue Suit, 12">${esc(m.text)}</textarea>
        ${m.result ? `<div class="pill ok" style="align-self:flex-start">${m.result.updated} counted</div>${m.result.unknown.length ? `<div class="hint">Not in the list: ${m.result.unknown.map(esc).join(', ')}</div>` : ''}${m.result.skipped.length ? `<div class="hint">Skipped (no number): ${m.result.skipped.map(esc).join(', ')}</div>` : ''}` : ''}
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">${m.result ? 'Close' : 'Cancel'}</button><button class="btn primary grow" data-act="modalOk">Save the counts</button></div></div></div></div>`;
    }
    if (m.type === 'recoveryMake') {
      return `<div class="overlay"><div class="dialog"><h2>Make a recovery code</h2><div class="stack">
        <div class="muted small">Type your password to confirm. A new code replaces the old one, which then stops working.</div>
        ${pwInput('m-rpw', 'modal.value', m.value || '', { enter: 'modalOk', autofocus: true, label: 'Password' })}
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Make the code</button></div></div></div></div>`;
    }
    if (m.type === 'clearTest') {
      return `<div class="overlay"><div class="dialog"><h2>Clear all test bills?</h2><div class="stack">
        <div class="muted small">This deletes <b>every bill</b>, udhaar payment and profit figure, and the next bill becomes number 1. Suits, prices, stock, settings and logins are kept. This cannot be undone. Take a backup first.</div>
        ${pwInput('m-cpw', 'modal.value', m.value || '', { enter: 'modalOk', autofocus: true, label: 'Password' })}
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Delete all bills</button></div></div></div></div>`;
    }
    if (m.type === 'recovery') {
      return `<div class="overlay"><div class="dialog"><h2>Your recovery code</h2><div class="stack">
        <div class="codebox" id="rc-code">${esc(m.code)}</div>
        <div class="muted">Write this code on paper now and keep it safe, away from the shop computer. If the owner password is ever forgotten, choose <b>Forgot password?</b> on the log in screen and type this code. It is shown only this once.</div>
        <button class="btn primary big" data-act="modalCancel">I have written it down</button></div></div></div>`;
    }
    if (m.type === 'preview') {
      return `<div class="overlay"><div class="dialog"><h2>Receipt preview</h2><iframe class="receipt-frame" sandbox="" srcdoc="${esc(m.html)}" title="Receipt preview"></iframe>
        <div class="row" style="margin-top:12px"><button class="btn primary grow" data-act="modalCancel">Close</button></div></div></div>`;
    }
    if (m.type === 'confirm') {
      return `<div class="overlay"><div class="dialog"><h2>${esc(m.title)}</h2><div class="stack"><div class="muted">${esc(m.text)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">No</button><button class="btn primary grow" data-act="modalOk">${esc(m.yes)}</button></div></div></div></div>`;
    }
    return '';
  }

  // ---------- drawing ----------
  function render() {
    const root = document.getElementById('app');
    if (!root) return;
    const active = document.activeElement;
    const keep = active && active.id ? { id: active.id, s: active.selectionStart, e: active.selectionEnd, inOverlay: !!active.closest('.overlay') } : null;
    const scrolls = {};
    root.querySelectorAll('[data-keep-scroll]').forEach((el) => { scrolls[el.dataset.keepScroll] = el.scrollTop; });
    const contentScroll = root.querySelector('.content') ? root.querySelector('.content').scrollTop : 0;

    let html;
    if (!S.user) html = viewLogin();
    else {
      const views = { dashboard: viewDashboard, ledger: viewLedger, billing: viewBilling, bills: viewBills, inventory: viewInventory, udhaar: viewUdhaar, profit: viewProfit, sales: viewSales, settings: viewSettings };
      html = shell(views[S.view]());
    }
    html += modalHtml();
    if (S.toast) html += `<div class="toast ${S.toast.kind === 'error' ? 'error' : ''}" role="status">${esc(S.toast.msg)}</div>`;
    root.innerHTML = html;

    root.querySelectorAll('[data-keep-scroll]').forEach((el) => { if (scrolls[el.dataset.keepScroll] !== undefined) el.scrollTop = scrolls[el.dataset.keepScroll]; });
    const content = root.querySelector('.content');
    if (content) content.scrollTop = contentScroll;

    // Keep the cursor where the person was typing. If a dialog is open, the dialog gets the focus, not the page behind it.
    const overlay = root.querySelector('.overlay');
    let restored = false;
    if (keep && (!overlay || keep.inOverlay)) {
      const el = document.getElementById(keep.id);
      if (el) {
        el.focus();
        try { if (keep.s !== null && keep.s !== undefined) el.setSelectionRange(keep.s, keep.e); } catch (e) { /* number inputs have no caret */ }
        restored = true;
      }
    }
    if (!restored) {
      const af = root.querySelector('.overlay [data-autofocus]') || (overlay ? null : root.querySelector('[data-autofocus]'));
      if (af) af.focus();
    }
  }

  // ---------- actions ----------
  const ACT = {
    nav: (el) => go(el.dataset.view),
    async login() {
      const L = S.login;
      try {
        const user = await call('login', L.username, L.password);
        L.password = ''; L.error = '';
        await afterLogin(user);
      } catch (e) { L.error = e.message; L.password = ''; render(); }
    },
    async setup() {
      const L = S.login;
      if (L.password !== L.password2) { L.error = 'The two passwords are not the same.'; render(); return; }
      try {
        const user = await call('setupOwner', { name: L.name, password: L.password });
        const rc = await call('createRecoveryCode', L.password);
        S.status.needsSetup = false;
        S.status.hasRecovery = true;
        S.login = freshLogin();
        S.showPw = {};
        await afterLogin(user);
        S.modal = { type: 'recovery', code: rc.code };
        render();
      } catch (e) { L.error = e.message; render(); }
    },
    forgotGo() { S.login = { ...freshLogin(), mode: 'forgot' }; S.showPw = {}; render(); },
    backToLogin() { S.login = freshLogin(); S.showPw = {}; render(); },
    async resetPw() {
      const L = S.login;
      if (L.busy) return;
      if (!L.code.trim()) { L.error = 'Type the recovery code.'; render(); return; }
      if (L.password !== L.password2) { L.error = 'The two new passwords are not the same.'; render(); return; }
      L.busy = true; L.error = ''; render();
      try {
        const r = await call('resetWithRecovery', L.code, L.password);
        S.login = { ...freshLogin(), mode: 'newcode', newCode: r.code };
        S.showPw = {};
      } catch (e) { L.error = e.message; L.busy = false; }
      render();
    },
    codeDone() { S.login = freshLogin(); S.showPw = {}; render(); },
    pwtoggle(el) {
      const id = el.dataset.for;
      S.showPw[id] = !S.showPw[id];
      render();
      const input = document.getElementById(id);
      if (input) { input.focus(); const n = input.value.length; try { input.setSelectionRange(n, n); } catch (e) { /* ignore */ } }
    },
    clearTestAsk() { S.modal = { type: 'clearTest', value: '', error: '' }; S.showPw = {}; render(); },
    recoveryAsk() { S.modal = { type: 'recoveryMake', value: '', error: '' }; S.showPw = {}; render(); },
    stockIn(el) {
      const s = S.prices.all.find((x) => x.id === Number(el.dataset.id));
      S.modal = { type: 'stockin', id: s.id, name: s.name, now: stockOf(s), qty: '', note: '', error: '' };
      render();
    },
    pasteStock() { S.modal = { type: 'stockpaste', text: '', result: null, error: '' }; render(); },
    async dayPdf() {
      if (S.settings.revealNeedsPassword && !S.reveal.unlocked) { S.modal = { type: 'password', error: '', after: 'dayPdf' }; render(); return; }
      const r = await call('dailyReportPdf', S.sales.day || todayKey());
      toast('Saved: ' + r.file);
    },
    async logout() {
      await call('logout');
      clearTimeout(S.reveal.timer);
      S.reveal = { on: false, today: null, timer: null, unlocked: false };
      S.user = null; S.bill = null; S.done = null; S.modal = null; S.form = null; S.showPw = {};
      S.login = freshLogin();
      S.status = await call('status');
      render();
    },
    eye: () => toggleReveal(),

    tile: (el) => addSuit(Number(el.dataset.id)),
    tileGroup(el) { S.modal = { type: 'sizepick', base: el.dataset.base }; render(); },
    pickSize(el) { S.modal = null; addSuit(Number(el.dataset.id)); },
    group: (el) => { S.group = el.dataset.v; render(); },
    searchEnter() {
      const q = S.search.trim().toLowerCase();
      const list = S.suits.filter((s) => (S.group === 'All' || s.group === S.group) && (!q || s.name.toLowerCase().includes(q)));
      if (list.length === 1) { S.search = ''; addSuit(list[0].id); }
      else toast(list.length ? 'More than one suit matches. Tap the one you want.' : 'No suit matches this search.', 'error');
    },
    qplus(el) {
      const l = S.bill.lines.find((x) => x.suitId === Number(el.dataset.id));
      if (l && l.qty < maxQty(l.suitId)) l.qty++;
      else if (l) toast(`Only ${maxQty(l.suitId)} of ${l.name} in stock.`, 'error');
      render();
    },
    qminus(el) { const l = S.bill.lines.find((x) => x.suitId === Number(el.dataset.id)); if (l && l.qty > 1) l.qty--; render(); },
    rm(el) { S.bill.lines = S.bill.lines.filter((x) => x.suitId !== Number(el.dataset.id)); render(); },
    clearBill() {
      S.modal = { type: 'confirm', title: 'Clear this bill?', text: 'All suits on the bill will be removed.', yes: 'Clear it', then: () => { S.bill = newBill(); } };
      render();
    },
    dchip(el) { S.bill.discType = 'pct'; S.bill.discVal = el.dataset.v; render(); },
    dtype(el) { S.bill.discType = el.dataset.v; render(); },
    method(el) { S.bill.method = el.dataset.v; if (!isCash(S.bill.method) && !S.bill.credit) S.bill.received = ''; render(); },
    credit(el) { S.bill.credit = !!el.dataset.v; S.bill.received = ''; render(); },
    exact() { const c = billCalc(); if (c.t) { S.bill.received = String(c.t.total); render(); } },
    save: (el) => saveBill(!!el.dataset.print),
    saveEnter() { const c = billCalc(); if (c.ok && !S.saving) saveBill(true); },
    newbill() { S.done = null; S.bill = newBill(); render(); const s = $('#search'); if (s) s.focus(); },
    printAgain: (el) => doPrint(Number(el.dataset.id)),

    pickBill(el) { S.bills.sel = Number(el.dataset.id); S.bills.preview = null; render(); },
    async reprint(el) { await call('printBill', Number(el.dataset.id)); toast('Sent to the printer.'); await loadBills(); },
    async previewBill(el) {
      if (S.bills.preview) { S.bills.preview = null; render(); return; }
      S.bills.preview = await call('receiptHtml', Number(el.dataset.id));
      render();
    },
    async pdfBill(el) { const r = await call('exportReceiptPdf', Number(el.dataset.id)); toast('Saved: ' + r.file); },
    cancelAsk(el) {
      const b = S.bills.list.find((x) => x.id === Number(el.dataset.id));
      S.modal = { type: 'cancel', id: b.id, no: b.invoice || b.no, reason: '', error: '' };
      render();
    },

    addSizes() { S.modal = { type: 'sizes', base: '', group: 'Kurtas', price: '', cost: '', zS: '', zM: '', zL: '', zXL: '', error: '' }; render(); },
    sizeCat(el) { S.modal.group = el.dataset.v; render(); },
    profitMonth() { S.profit.day = ''; safe(async () => { if (S.reveal.on) await loadProfit(); render(); }); },
    clearBeforeAsk() { S.modal = { type: 'clearBefore', value: '', date: todayKey(), word: '', error: '' }; S.showPw = {}; render(); },
    goLiveAsk() { S.modal = { type: 'goLive', value: '', error: '' }; S.showPw = {}; render(); },
    addSuit() { S.modal = { type: 'suit', id: null, name: '', price: '', cost: '', stock: '', group: '', active: true, error: '' }; render(); },
    editSuit(el) {
      const s = S.prices.all.find((x) => x.id === Number(el.dataset.id));
      S.modal = { type: 'suit', id: s.id, name: s.name, price: String(s.price), cost: s.cost === null || s.cost === undefined ? '' : String(s.cost), stock: stockOf(s) === null ? '' : String(s.stock), group: s.group || '', active: s.active, base: s.base || '', allSizes: !!s.base, error: '' };
      render();
    },
    async pickUdhaar(el) {
      S.udhaar.sel = el.dataset.key;
      S.udhaar.detail = await call('udhaarCustomer', S.udhaar.sel);
      S.udhaar.pay = { amount: '', method: S.settings.paymentMethods[0], note: '', uid: uuid() };
      render();
    },
    payMethod(el) { S.udhaar.pay.method = el.dataset.v; render(); },
    fullUdhaar() { S.udhaar.pay.amount = String(S.udhaar.detail.balance); render(); },
    async receiveUdhaar() {
      const U = S.udhaar;
      if (U.busy || !U.detail) return;
      const amount = Number(U.pay.amount);
      if (!U.pay.amount || !Number.isInteger(amount) || amount < 1) { toast('Enter the amount received.', 'error'); return; }
      if (amount > U.detail.balance) { toast(`This customer owes only ${money(U.detail.balance)}.`, 'error'); return; }
      U.busy = true; render();
      try {
        const r = await call('receiveUdhaar', { uid: U.pay.uid, customerKey: U.sel, amount, method: U.pay.method, note: U.pay.note });
        if (r.balance <= 0) { U.sel = null; U.detail = null; U.pay = null; } else U.pay = { amount: '', method: U.pay.method, note: '', uid: uuid() };
        await loadUdhaar();
        toast(`Received ${money(amount)}. ${r.balance > 0 ? 'Still owes ' + money(r.balance) + '.' : 'Nothing left to pay.'}`);
      } finally { U.busy = false; render(); }
    },
    pasteList() { S.modal = { type: 'paste', text: '', result: null, error: '' }; render(); },

    modalCancel() { S.modal = null; render(); },
    async modalOk() {
      const m = S.modal;
      if (!m) return;
      try {
        if (m.type === 'password') {
          const ok = await call('verifyPassword', m.value || '');
          if (!ok) { m.error = 'Wrong password.'; m.value = ''; render(); return; }
          S.reveal.unlocked = true;
          S.modal = null;
          await doReveal();
          if (m.after === 'dayPdf') await ACT.dayPdf();
        } else if (m.type === 'stockin') {
          if (!m.qty) { m.error = 'Enter how many came in.'; render(); return; }
          await call('addStock', { suitId: m.id, qty: Number(m.qty), note: m.note });
          S.modal = null;
          await reloadSuits();
          S.stock.log = await call('listStockLog', 30);
          toast('Stock added.');
        } else if (m.type === 'stockpaste') {
          if (m.result) { S.modal = null; render(); return; }
          m.result = await call('importStock', m.text);
          await reloadSuits();
          S.stock.log = await call('listStockLog', 30);
          m.error = '';
          render();
        } else if (m.type === 'clearTest') {
          const r = await call('clearTestData', m.value || '');
          S.modal = null;
          S.showPw = {};
          await reloadSuits();
          toast(r.removed + ' bills removed. You can start fresh.');
        } else if (m.type === 'recoveryMake') {
          const r = await call('createRecoveryCode', m.value || '');
          S.recovery = await call('recoveryInfo');
          S.modal = { type: 'recovery', code: r.code };
          S.showPw = {};
          render();
        } else if (m.type === 'suit') {
          await call('saveSuit', { id: m.id, name: m.name, price: m.price === '' ? 0 : Number(m.price), cost: m.cost === '' ? '' : Number(m.cost), stock: m.stock === '' ? '' : Number(m.stock), group: m.group, active: m.active });
          if (m.base && m.allSizes) await call('setBasePrice', m.base, m.price === '' ? 0 : Number(m.price), m.cost === '' ? '' : Number(m.cost));
          S.modal = null;
          await reloadSuits();
          toast('Saved.');
        } else if (m.type === 'sizes') {
          const sizes = {};
          for (const z of ['S', 'M', 'L', 'XL']) if (m['z' + z] !== '' && m['z' + z] !== undefined) sizes[z] = Number(m['z' + z]);
          const r = await call('saveSuitSizes', { base: m.base, group: m.group, price: m.price === '' ? 0 : Number(m.price), cost: m.cost === '' ? '' : Number(m.cost), sizes });
          S.modal = null;
          await reloadSuits();
          toast(r.added + ' sizes added' + (r.updated ? ', ' + r.updated + ' updated' : '') + '.');
        } else if (m.type === 'clearBefore') {
          if (m.word !== 'CLEAR') throw new Error('Type the word CLEAR to confirm.');
          const r = await call('clearTestBefore', m.value || '', m.date);
          S.modal = null; S.showPw = {};
          await reloadSuits();
          toast(r.removed + ' test bills removed.');
        } else if (m.type === 'goLive') {
          await call('startRealSales', m.value || '');
          S.settings = await call('getSettings'); S.form = { ...S.settings, paymentMethodsText: S.settings.paymentMethods.join(', ') };
          S.modal = null; S.showPw = {};
          toast('Real sales have started. Test clearing is now off.');
        } else if (m.type === 'paste') {
          if (m.result) { S.modal = null; render(); return; }
          m.result = await call('importSuits', m.text);
          await reloadSuits();
          m.error = '';
          render();
        } else if (m.type === 'cancel') {
          await call('cancelBill', m.id, m.reason);
          S.modal = null;
          S.bills.preview = null;
          await loadBills();
          toast('Bill cancelled.');
        } else if (m.type === 'userpw') {
          await call('saveUser', { ...m.user, password: m.value });
          S.modal = null;
          toast('Password changed.');
        } else if (m.type === 'confirm') {
          S.modal = null;
          m.then();
          render();
        }
      } catch (e) { m.error = e.message; render(); }
    },

    async saveShop() {
      const f = S.form;
      S.settings = await call('saveSettings', { shopName: f.shopName, address: f.address, phone: f.phone, whatsapp: f.whatsapp, footer: f.footer, exchangeNote: f.exchangeNote, invoicePrefix: f.invoicePrefix });
      S.form.invoicePrefix = S.settings.invoicePrefix;
      toast('Saved.'); render();
    },
    async savePrinter() {
      const f = S.form;
      S.settings = await call('saveSettings', { paperWidthMm: Number(f.paperWidthMm), printerName: f.printerName, silentPrint: f.silentPrint, receiptOffsetMm: f.receiptOffsetMm === '' || f.receiptOffsetMm === '-' ? 0 : Number(f.receiptOffsetMm) });
      toast('Saved.'); render();
    },
    async saveRules() {
      const f = S.form;
      S.settings = await call('saveSettings', { discountLimitPct: Number(f.discountLimitPct), paymentMethods: f.paymentMethodsText, revealNeedsPassword: f.revealNeedsPassword, lowStockAt: f.lowStockAt === '' ? 0 : Number(f.lowStockAt) });
      if (!S.settings.paymentMethods.includes(S.bill.method)) S.bill.method = S.settings.paymentMethods[0];
      S.form.paymentMethodsText = S.settings.paymentMethods.join(', ');
      toast('Saved.'); render();
    },
    async testPrint() { await call('testPrint'); toast('Test receipt sent to the printer.'); },
    async testPreview() { S.modal = { type: 'preview', html: await call('testReceiptHtml') }; render(); },
    async pickImage(el) {
      const data = await call('chooseImage');
      if (!data) return;
      S.settings = await call('saveSettings', { [el.dataset.key]: data });
      toast('Saved.'); render();
    },
    async clearImage(el) { S.settings = await call('saveSettings', { [el.dataset.key]: '' }); render(); },
    async pickBackup() {
      const dir = await call('chooseBackupDir');
      if (!dir) return;
      S.settings = await call('saveSettings', { backupDir: dir });
      await call('backupNow');
      await refreshInfo();
      toast('Backup folder saved and a copy made.');
    },
    async clearBackup() { S.settings = await call('saveSettings', { backupDir: '' }); await refreshInfo(); },
    async backupNow() { await call('backupNow'); await refreshInfo(); toast('Backup done.'); },
    async addUser() {
      const u = S.newUser;
      await call('saveUser', { name: u.name, username: u.username, password: u.password, role: 'staff' });
      S.newUser = { name: '', username: '', password: '' };
      S.users = await call('listUsers');
      toast('Staff added.'); render();
    },
    userPw(el) {
      const u = S.users.find((x) => x.id === Number(el.dataset.id));
      S.modal = { type: 'userpw', name: u.name, user: u, value: '', error: '' };
      render();
    },
    async userToggle(el) {
      const u = S.users.find((x) => x.id === Number(el.dataset.id));
      await call('saveUser', { ...u, active: !u.active });
      S.users = await call('listUsers');
      render();
    },
    async changePw() {
      if (S.pw.a !== S.pw.b) throw new Error('The two new passwords are not the same.');
      await call('changePassword', S.pw.old, S.pw.a);
      S.pw = { old: '', a: '', b: '' };
      toast('Password changed.'); render();
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACT[el.dataset.act];
    if (fn) safe(() => fn(el, e));
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.qty) {
      const v = parseInt(el.value, 10);
      const line = S.bill.lines.find((l) => l.suitId === Number(el.dataset.qty));
      if (line && Number.isInteger(v) && v >= 1 && v <= M.MAX_QTY) {
        const cap = maxQty(line.suitId);
        if (v > cap) { line.qty = cap; toast(`Only ${cap} of ${line.name} in stock.`, 'error'); } else { line.qty = v; render(); }
      }
      return;
    }
    if (!el.dataset.bind) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.kind === 'digits') { const c = String(v).replace(/\D/g, ''); if (c !== v) el.value = c; v = c; }
    if (el.dataset.kind === 'signed') { const c = String(v).replace(/[^\d-]/g, '').replace(/(?!^)-/g, ''); if (c !== v) el.value = c; v = c; }
    if (el.dataset.kind === 'decimal') { const c = String(v).replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'); if (c !== v) el.value = c; v = c; }
    setPath(S, el.dataset.bind, v);
    if (el.dataset.rerender) render();
    if (el.dataset.bills) loadBillsSoon();
    if (el.dataset.sales && S.reveal.on) safe(async () => { await loadSales(); render(); });
    if (el.dataset.clearday) S.profit.day = '';
    if (el.dataset.profit && S.reveal.on) safe(async () => { await loadProfit(); render(); });
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.qty) { const line = S.bill.lines.find((l) => l.suitId === Number(el.dataset.qty)); if (line) el.value = line.qty; return; }
    if (el.tagName === 'SELECT' && el.dataset.bind) {
      let v = el.value;
      if (el.dataset.kind === 'number') v = Number(v);
      setPath(S, el.dataset.bind, v);
      if (el.dataset.bills) loadBillsSoon();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    const act = el && el.dataset && el.dataset.enter;
    if (act && ACT[act]) { e.preventDefault(); safe(() => ACT[act](el, e)); }
  });

  // Nothing that goes wrong on a screen should leave the person with a blank window.
  window.addEventListener('error', (e) => { try { toast('Something went wrong on this screen. Your saved bills are safe.', 'error'); } catch (x) { /* ignore */ } console.error(e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); try { toast(e.reason && e.reason.message ? e.reason.message : 'Something went wrong. Your saved bills are safe.', 'error'); } catch (x) { /* ignore */ } });

  boot().catch((e) => { document.getElementById('app').textContent = 'Could not start: ' + e.message; });
})();
