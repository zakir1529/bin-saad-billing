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
    uid: uuid(), lines: [], discType: 'pct', discVal: '',
    method: (S.settings && S.settings.paymentMethods[0]) || 'Cash', received: '', name: '', phone: '',
  });

  const S = {
    status: null, user: null, settings: null, suits: [],
    view: 'billing', search: '', group: 'All', bill: null, saving: false, done: null,
    bills: { text: '', from: '', to: '', state: '', list: null, sel: null, preview: null },
    prices: { q: '', all: [] },
    sales: { day: todayKey(), month: monthKey(), day_data: null, month_data: null },
    reveal: { on: false, today: null, timer: null },
    form: null, newUser: { name: '', username: '', password: '' }, pw: { old: '', a: '', b: '' },
    printers: null, info: null, modal: null, toast: null, login: { username: 'owner', password: '', name: '', password2: '', error: '' },
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
    S.view = 'billing';
    S.settings = await call('getSettings');
    S.suits = await call('listSuits', {});
    S.bill = newBill();
    S.done = null;
    refreshInfo();
    render();
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
    try {
      out.t = M.computeTotals(b.lines.map((l) => ({ price: l.price, qty: l.qty })), { type: b.discType, value: b.discVal });
    } catch (e) { out.hint = e.message; return out; }
    if (out.t.total < 1) { out.hint = 'The total cannot be zero.'; return out; }
    if (S.user.role !== 'owner' && out.t.discount * 100 > out.t.subtotal * S.settings.discountLimitPct) {
      out.hint = `A discount above ${S.settings.discountLimitPct}% needs the owner.`; return out;
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

  function addSuit(id) {
    const s = S.suits.find((x) => x.id === id);
    if (!s) return;
    const line = S.bill.lines.find((l) => l.suitId === id);
    if (line) { if (line.qty < M.MAX_QTY) line.qty += 1; }
    else S.bill.lines.push({ suitId: s.id, name: s.name, price: s.price, qty: 1 });
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
        received: isCash(b.method) ? Number(b.received) : '',
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
    S.reveal = { on: false, today: null, timer: null };
    S.sales.day_data = null;
    S.sales.month_data = null;
    render();
  }
  async function doReveal() {
    S.reveal.today = await call('dailyReport', todayKey());
    S.reveal.on = true;
    if (S.view === 'sales') await loadSales();
    clearTimeout(S.reveal.timer);
    S.reveal.timer = setTimeout(hideReveal, REVEAL_MS);
    render();
  }
  async function toggleReveal() {
    if (S.reveal.on) return hideReveal();
    if (S.settings.revealNeedsPassword) { S.modal = { type: 'password', error: '' }; render(); return; }
    await doReveal();
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
    render();
    await safe(async () => {
      if (view === 'billing') S.suits = await call('listSuits', {});
      if (view === 'bills') await loadBills();
      if (view === 'prices') await reloadSuits();
      if (view === 'sales' && S.reveal.on) await loadSales();
      if (view === 'settings') {
        S.settings = await call('getSettings');
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

  function viewLogin() {
    const L = S.login;
    if (S.status.needsSetup) {
      return `<div class="login"><div class="box">
        <h1>${esc(S.status.shopName)}</h1><div class="sub">First time set-up. Create the owner password.</div>
        <div class="stack">
          <div><label class="field" for="l-name">Your name</label><input id="l-name" type="text" data-bind="login.name" value="${esc(L.name)}"></div>
          <div><label class="field" for="l-pw">Password (at least 4 characters)</label><input id="l-pw" type="password" data-bind="login.password" data-enter="setup" value="${esc(L.password)}"></div>
          <div><label class="field" for="l-pw2">Type the password again</label><input id="l-pw2" type="password" data-bind="login.password2" data-enter="setup" value="${esc(L.password2)}"></div>
          <button class="btn primary big" data-act="setup">Create and start</button>
          <div class="err">${esc(L.error)}</div>
        </div></div></div>`;
    }
    return `<div class="login"><div class="box">
      <h1>${esc(S.status.shopName)}</h1><div class="sub">Please log in</div>
      <div class="stack">
        <div><label class="field" for="l-user">Username</label><input id="l-user" type="text" data-bind="login.username" data-enter="login" value="${esc(L.username)}" autocomplete="off"></div>
        <div><label class="field" for="l-pw">Password</label><input id="l-pw" type="password" data-bind="login.password" data-enter="login" value="${esc(L.password)}" data-autofocus="1"></div>
        <button class="btn primary big" data-act="login">Log in</button>
        <div class="err">${esc(L.error)}</div>
      </div></div></div>`;
  }

  const TITLES = { billing: 'New bill', bills: 'Bills', prices: 'Price list', sales: 'Sales', settings: 'Settings' };

  function shell(content) {
    const owner = S.user.role === 'owner';
    const items = [['billing', 'New bill'], ['bills', 'Bills'], ['prices', owner ? 'Price list' : 'Prices']];
    if (owner) items.push(['sales', 'Sales'], ['settings', 'Settings']);
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

  // ----- billing -----
  function viewBilling() {
    const groups = [...new Set(S.suits.map((s) => s.group).filter(Boolean))].sort();
    const q = S.search.trim().toLowerCase();
    const list = S.suits.filter((s) => (S.group === 'All' || s.group === S.group) && (!q || s.name.toLowerCase().includes(q)));
    const inBill = new Map(S.bill.lines.map((l) => [l.suitId, l.qty]));
    let tiles;
    if (!S.suits.length) {
      tiles = `<div class="empty" style="grid-column:1/-1">There are no suits in the price list yet.${S.user.role === 'owner' ? '<br><br><button class="btn primary" data-act="nav" data-view="prices">Add suits</button>' : '<br>Ask the owner to add them.'}</div>`;
    } else if (!list.length) {
      tiles = '<div class="empty" style="grid-column:1/-1">No suit matches this search.</div>';
    } else {
      tiles = list.map((s) => `<button class="tile ${inBill.has(s.id) ? 'in' : ''}" data-act="tile" data-id="${s.id}">
        <span class="nm">${esc(s.name)}</span><span class="pr num">${money(s.price)}</span>${inBill.has(s.id) ? `<span class="qty">x${inBill.get(s.id)}</span>` : ''}</button>`).join('');
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
          <div class="chips">${methods}</div>
          ${isCash(b.method) ? `<div class="row"><input id="received" type="text" inputmode="numeric" placeholder="Amount received" data-bind="bill.received" data-kind="digits" data-rerender="1" data-enter="saveEnter" value="${esc(b.received)}" aria-label="Amount received">
              <button class="btn" data-act="exact" ${t ? '' : 'disabled'}>Exact</button></div>
            ${c.rec !== null && c.ok ? `<div class="change"><span>Change to return</span><span class="num">${money(c.change)}</span></div>` : ''}`
            : `<div class="muted small">${esc(b.method)}: the amount received equals the total.</div>`}
          <div class="row"><input type="text" id="cname" placeholder="Customer (optional)" data-bind="bill.name" value="${esc(b.name)}" aria-label="Customer name">
            <input type="text" id="cphone" placeholder="Phone (optional)" data-bind="bill.phone" value="${esc(b.phone)}" aria-label="Customer phone"></div>
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
      <td class="num"><b>${pad4(b.no)}</b></td><td class="num">${when(b.createdAt)}</td>
      <td>${esc(b.customerName || '')} <span class="muted small">${esc(b.customerPhone || '')}</span></td>
      <td class="right num"><b>${money(b.total)}</b></td><td>${esc(b.method)}</td>
      <td>${b.status === 'cancelled' ? '<span class="pill bad">Cancelled</span>' : ''}</td></tr>`).join('');
    const sel = f.sel && (f.list || []).find((b) => b.id === f.sel);
    return `<div class="split">
      <div>
        <div class="card row wrap" style="margin-bottom:12px">
          <div class="field-wrap" style="min-width:220px"><label class="field" for="bq">Find by bill number, customer, phone or suit</label><input id="bq" type="text" data-bind="bills.text" data-bills="1" value="${esc(f.text)}" placeholder="For example 12, Imran, 0300..., Navy"></div>
          <div><label class="field" for="bfrom">From</label><input id="bfrom" type="date" data-bind="bills.from" data-bills="1" value="${esc(f.from)}"></div>
          <div><label class="field" for="bto">To</label><input id="bto" type="date" data-bind="bills.to" data-bills="1" value="${esc(f.to)}"></div>
          <div><label class="field" for="bst">Status</label><select id="bst" data-bind="bills.state" data-bills="1"><option value="">All</option><option value="paid" ${f.state === 'paid' ? 'selected' : ''}>Paid</option><option value="cancelled" ${f.state === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></div>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          <table><thead><tr><th>No.</th><th>Date and time</th><th>Customer</th><th class="right">Total</th><th>Paid by</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">No bills found.</td></tr>'}</tbody></table>
        </div>
      </div>
      <div>${sel ? billDetail(sel) : '<div class="card empty">Pick a bill to see it, reprint it, or cancel it.</div>'}</div>
    </div>`;
  }

  function billDetail(b) {
    const owner = S.user.role === 'owner';
    return `<div class="card">
      <div class="row between"><h2>Bill ${pad4(b.no)}</h2>${b.status === 'cancelled' ? '<span class="pill bad">Cancelled</span>' : '<span class="pill ok">Paid</span>'}</div>
      <div class="muted small" style="margin:4px 0 10px">${when(b.createdAt)} &middot; ${esc(b.cashier)}${b.customerName ? ' &middot; ' + esc(b.customerName) : ''}${b.customerPhone ? ' ' + esc(b.customerPhone) : ''}</div>
      <table>${b.lines.map((l) => `<tr><td>${esc(l.name)}<div class="muted small">${l.qty} x ${money(l.price)}</div></td><td class="right num">${money(l.amount)}</td></tr>`).join('')}</table>
      <div style="margin-top:8px">
        <div class="sum"><span class="muted">Subtotal</span><span class="num">${money(b.subtotal)}</span></div>
        ${b.discount ? `<div class="sum"><span class="muted">Discount ${b.discountType === 'pct' ? '(' + Number(b.discountValue) + '%)' : ''}</span><span class="num">-${money(b.discount)}</span></div>` : ''}
        <div class="sum" style="font-size:18px;font-weight:700"><span>Total</span><span class="num">${money(b.total)}</span></div>
        <div class="sum muted"><span>Paid by ${esc(b.method)}</span><span class="num">${isCash(b.method) ? 'Received ' + money(b.received) + ', change ' + money(b.change) : ''}</span></div>
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

  // ----- price list -----
  function viewPrices() {
    const owner = S.user.role === 'owner';
    const all = owner ? S.prices.all : S.suits;
    const q = S.prices.q.trim().toLowerCase();
    const list = all.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.group || '').toLowerCase().includes(q));
    const rows = list.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.group || '')}</td><td class="right num">${money(s.price)}</td>
      <td>${s.active ? '<span class="pill ok">On</span>' : '<span class="pill off">Off</span>'}</td>
      <td class="right">${owner ? `<button class="btn small" data-act="editSuit" data-id="${s.id}">Edit</button>` : ''}</td></tr>`).join('');
    return `<div class="card row wrap" style="margin-bottom:12px">
        <div class="field-wrap" style="min-width:240px"><label class="field" for="pq">Search the list</label><input id="pq" type="text" data-bind="prices.q" data-rerender="1" value="${esc(S.prices.q)}" placeholder="Suit name or group"></div>
        ${owner ? '<div style="align-self:flex-end" class="row"><button class="btn primary" data-act="addSuit">Add a suit</button><button class="btn" data-act="pasteList">Paste a list</button></div>' : '<div class="muted small" style="align-self:flex-end">Only the owner can change prices.</div>'}
      </div>
      <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Suit</th><th>Group</th><th class="right">Price</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty">No suits yet.</td></tr>'}</tbody></table></div>`;
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
        <input type="date" id="sday" data-bind="sales.day" data-sales="1" value="${esc(S.sales.day)}" style="width:170px" aria-label="Pick a day"></div>
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
        <div><label class="field" for="f-ft">Line at the bottom of the receipt</label><input id="f-ft" type="text" data-bind="form.footer" value="${esc(f.footer)}"></div>
        ${img('logo', 'Logo')}${img('qr', 'WhatsApp QR')}
        <div><button class="btn primary" data-act="saveShop">Save shop details</button></div></div></div>

      <div class="card"><h2>Receipt printer</h2><div class="stack" style="margin-top:10px">
        <div class="row"><div class="field-wrap"><label class="field" for="f-pw">Paper width</label><select id="f-pw" data-bind="form.paperWidthMm" data-kind="number"><option value="80" ${Number(f.paperWidthMm) === 80 ? 'selected' : ''}>80 mm (wide roll)</option><option value="58" ${Number(f.paperWidthMm) === 58 ? 'selected' : ''}>58 mm (narrow roll)</option></select></div>
          <div class="field-wrap"><label class="field" for="f-pr">Printer</label><select id="f-pr" data-bind="form.printerName"><option value="">Windows default printer</option>
            ${printers.map((p) => `<option value="${esc(p.name)}" ${f.printerName === p.name ? 'selected' : ''}>${esc(p.displayName)}${p.isDefault ? ' (default)' : ''}</option>`).join('')}</select></div></div>
        <label class="row"><input type="checkbox" data-bind="form.silentPrint" ${f.silentPrint ? 'checked' : ''}> Print straight away, without asking each time</label>
        <div class="row"><button class="btn primary" data-act="savePrinter">Save printer settings</button><button class="btn" data-act="testPrint">Print a test receipt</button><button class="btn" data-act="testPreview">Preview</button></div></div></div>

      <div class="card"><h2>Discounts and payment methods</h2><div class="stack" style="margin-top:10px">
        <div class="row"><div class="field-wrap"><label class="field" for="f-dl">Largest discount staff can give (%)</label><input id="f-dl" type="text" inputmode="decimal" data-bind="form.discountLimitPct" data-kind="decimal" value="${esc(f.discountLimitPct)}"></div>
          <div class="field-wrap"><label class="field" for="f-pm">Payment methods (separate with commas)</label><input id="f-pm" type="text" data-bind="form.paymentMethodsText" value="${esc(f.paymentMethodsText)}"></div></div>
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
          <div class="field-wrap"><label class="field" for="nu-p">Password</label><input id="nu-p" type="password" data-bind="newUser.password" value="${esc(S.newUser.password)}"></div>
          <button class="btn primary" style="align-self:flex-end" data-act="addUser">Add staff</button></div></div>

      <div class="card"><h2>Change my password</h2><div class="row wrap" style="margin-top:10px">
        <div class="field-wrap"><label class="field" for="p-o">Current password</label><input id="p-o" type="password" data-bind="pw.old" value="${esc(S.pw.old)}"></div>
        <div class="field-wrap"><label class="field" for="p-a">New password</label><input id="p-a" type="password" data-bind="pw.a" value="${esc(S.pw.a)}"></div>
        <div class="field-wrap"><label class="field" for="p-b">New password again</label><input id="p-b" type="password" data-bind="pw.b" value="${esc(S.pw.b)}"></div>
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
        <h2>Bill ${pad4(b.no)} saved</h2><div class="stack">
          <div class="sum total"><span>Total</span><span class="num">${money(b.total)}</span></div>
          ${isCash(b.method) ? `<div class="muted small right">Received ${money(b.received)}</div><div class="big-change num">Change: ${money(b.change)}</div>` : `<div class="muted">Paid by ${esc(b.method)}</div>`}
          <div>${status}</div>
          <div class="row"><button class="btn" data-act="printAgain" data-id="${b.id}" ${d.print === 'printing' ? 'disabled' : ''}>${d.print === 'failed' ? 'Try printing again' : 'Print again'}</button>
            <button class="btn primary grow" id="newbill" data-act="newbill" data-autofocus="1">New bill</button></div></div></div></div>`;
    }
    if (!m) return '';
    if (m.type === 'password') {
      return `<div class="overlay"><div class="dialog"><h2>Enter your password</h2><div class="stack">
        <div class="muted small">To show today's sales, please confirm it is you.</div>
        <input id="m-pw" type="password" data-bind="modal.value" data-enter="modalOk" data-autofocus="1" value="${esc(m.value || '')}" aria-label="Password">
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Show</button></div></div></div></div>`;
    }
    if (m.type === 'suit') {
      const groups = [...new Set(S.prices.all.map((s) => s.group).filter(Boolean))];
      return `<div class="overlay"><div class="dialog"><h2>${m.id ? 'Edit suit' : 'Add a suit'}</h2><div class="stack">
        <div><label class="field" for="m-name">Suit name (no company name needed)</label><input id="m-name" type="text" data-bind="modal.name" data-enter="modalOk" data-autofocus="1" value="${esc(m.name)}"></div>
        <div class="row"><div class="field-wrap"><label class="field" for="m-price">Price (Rs.)</label><input id="m-price" type="text" inputmode="numeric" data-bind="modal.price" data-kind="digits" data-enter="modalOk" value="${esc(m.price)}"></div>
          <div class="field-wrap"><label class="field" for="m-group">Group (optional)</label><input id="m-group" list="groups" type="text" data-bind="modal.group" data-enter="modalOk" value="${esc(m.group)}"><datalist id="groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></div></div>
        ${m.id ? `<label class="row"><input type="checkbox" data-bind="modal.active" ${m.active ? 'checked' : ''}> Show this suit when billing</label>` : ''}
        <div class="muted small">Changing a price affects new bills only. Printed bills keep the price they were sold at.</div>
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Save</button></div></div></div></div>`;
    }
    if (m.type === 'paste') {
      return `<div class="overlay"><div class="dialog wide"><h2>Paste a list of suits</h2><div class="stack">
        <div class="muted small">One suit on each line, with its price. For example:<br><b>Navy Blue Suit, 4000</b><br><b>Black Suit 4500</b><br>A group can be added at the end: <b>White Suit, 3800, Plain</b>. A suit already in the list gets its price updated.</div>
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
        <input id="m-upw" type="password" data-bind="modal.value" data-enter="modalOk" data-autofocus="1" value="${esc(m.value || '')}" aria-label="New password">
        <div class="err">${esc(m.error)}</div>
        <div class="row"><button class="btn" data-act="modalCancel">Cancel</button><button class="btn primary grow" data-act="modalOk">Save</button></div></div></div></div>`;
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
      const views = { billing: viewBilling, bills: viewBills, prices: viewPrices, sales: viewSales, settings: viewSettings };
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
        S.status.needsSetup = false;
        L.password = ''; L.password2 = ''; L.error = '';
        await afterLogin(user);
      } catch (e) { L.error = e.message; render(); }
    },
    async logout() {
      await call('logout');
      clearTimeout(S.reveal.timer);
      S.reveal = { on: false, today: null, timer: null };
      S.user = null; S.bill = null; S.done = null; S.modal = null; S.form = null;
      S.login = { username: 'owner', password: '', name: '', password2: '', error: '' };
      S.status = await call('status');
      render();
    },
    eye: () => toggleReveal(),

    tile: (el) => addSuit(Number(el.dataset.id)),
    group: (el) => { S.group = el.dataset.v; render(); },
    searchEnter() {
      const q = S.search.trim().toLowerCase();
      const list = S.suits.filter((s) => (S.group === 'All' || s.group === S.group) && (!q || s.name.toLowerCase().includes(q)));
      if (list.length === 1) { S.search = ''; addSuit(list[0].id); }
      else toast(list.length ? 'More than one suit matches. Tap the one you want.' : 'No suit matches this search.', 'error');
    },
    qplus(el) { const l = S.bill.lines.find((x) => x.suitId === Number(el.dataset.id)); if (l && l.qty < M.MAX_QTY) l.qty++; render(); },
    qminus(el) { const l = S.bill.lines.find((x) => x.suitId === Number(el.dataset.id)); if (l && l.qty > 1) l.qty--; render(); },
    rm(el) { S.bill.lines = S.bill.lines.filter((x) => x.suitId !== Number(el.dataset.id)); render(); },
    clearBill() {
      S.modal = { type: 'confirm', title: 'Clear this bill?', text: 'All suits on the bill will be removed.', yes: 'Clear it', then: () => { S.bill = newBill(); } };
      render();
    },
    dchip(el) { S.bill.discType = 'pct'; S.bill.discVal = el.dataset.v; render(); },
    dtype(el) { S.bill.discType = el.dataset.v; render(); },
    method(el) { S.bill.method = el.dataset.v; if (!isCash(S.bill.method)) S.bill.received = ''; render(); },
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
      S.modal = { type: 'cancel', id: b.id, no: b.no, reason: '', error: '' };
      render();
    },

    addSuit() { S.modal = { type: 'suit', id: null, name: '', price: '', group: '', active: true, error: '' }; render(); },
    editSuit(el) {
      const s = S.prices.all.find((x) => x.id === Number(el.dataset.id));
      S.modal = { type: 'suit', id: s.id, name: s.name, price: String(s.price), group: s.group || '', active: s.active, error: '' };
      render();
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
          S.modal = null;
          await doReveal();
        } else if (m.type === 'suit') {
          await call('saveSuit', { id: m.id, name: m.name, price: m.price === '' ? 0 : Number(m.price), group: m.group, active: m.active });
          S.modal = null;
          await reloadSuits();
          toast('Saved.');
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
      S.settings = await call('saveSettings', { shopName: f.shopName, address: f.address, phone: f.phone, whatsapp: f.whatsapp, footer: f.footer });
      toast('Saved.'); render();
    },
    async savePrinter() {
      const f = S.form;
      S.settings = await call('saveSettings', { paperWidthMm: Number(f.paperWidthMm), printerName: f.printerName, silentPrint: f.silentPrint });
      toast('Saved.'); render();
    },
    async saveRules() {
      const f = S.form;
      S.settings = await call('saveSettings', { discountLimitPct: Number(f.discountLimitPct), paymentMethods: f.paymentMethodsText, revealNeedsPassword: f.revealNeedsPassword });
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
      if (line && Number.isInteger(v) && v >= 1 && v <= M.MAX_QTY) { line.qty = v; render(); }
      return;
    }
    if (!el.dataset.bind) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.kind === 'digits') { const c = String(v).replace(/\D/g, ''); if (c !== v) el.value = c; v = c; }
    if (el.dataset.kind === 'decimal') { const c = String(v).replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'); if (c !== v) el.value = c; v = c; }
    setPath(S, el.dataset.bind, v);
    if (el.dataset.rerender) render();
    if (el.dataset.bills) loadBillsSoon();
    if (el.dataset.sales && S.reveal.on) safe(async () => { await loadSales(); render(); });
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

  boot().catch((e) => { document.getElementById('app').textContent = 'Could not start: ' + e.message; });
})();
