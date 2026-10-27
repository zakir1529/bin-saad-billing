'use strict';

// Builds the receipt page for the thermal printer. The same page is used for printing and for the on-screen preview.
const { fmt } = require('./money');

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');

function formatWhen(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}  ${h}:${pad2(d.getMinutes())} ${ap}`;
}

function discountLabel(bill) {
  if (bill.discountType === 'pct') return `Discount (${Number(bill.discountValue)}%)`;
  return 'Discount';
}

// opts: { duplicate: boolean, test: boolean }
function buildReceiptHtml(bill, settings, opts = {}) {
  const width = settings.paperWidthMm === 58 ? 48 : 72; // printable width in mm
  const row = (l, r, cls) => `<div class="row ${cls || ''}"><span>${l}</span><span>${r}</span></div>`;
  const lines = bill.lines
    .map((l) => `<div class="item"><div class="name">${esc(l.name)}</div>${row(`${l.qty} x ${fmt(l.price)}`, fmt(l.amount))}</div>`)
    .join('');
  const contact = [settings.phone && 'Ph: ' + esc(settings.phone), settings.whatsapp && 'WhatsApp: ' + esc(settings.whatsapp)]
    .filter(Boolean)
    .map((t) => `<div class="small">${t}</div>`)
    .join('');
  const customer = bill.customerName || bill.customerPhone
    ? row('Customer', esc([bill.customerName, bill.customerPhone].filter(Boolean).join('  ')))
    : '';
  const isCash = String(bill.method).toLowerCase() === 'cash';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Bill ${bill.no}</title><style>
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: ${width}mm; padding: 2mm 1mm 4mm; font-family: "Segoe UI", Arial, sans-serif; font-size: 12px; line-height: 1.35; color: #000; }
.center { text-align: center; }
.shop { font-size: 17px; font-weight: 700; letter-spacing: .5px; margin: 2px 0; }
.small { font-size: 11px; }
.logo { max-width: 40mm; max-height: 22mm; margin: 0 auto 2px; display: block; }
.qr { width: 28mm; height: 28mm; margin: 4px auto 0; display: block; }
.rule { border-top: 1px dashed #000; margin: 5px 0; }
.row { display: flex; justify-content: space-between; gap: 6px; }
.row span:last-child { text-align: right; white-space: nowrap; }
.item { margin: 3px 0; }
.name { font-weight: 700; }
.total { font-size: 16px; font-weight: 700; margin: 3px 0; }
.stamp { text-align: center; font-weight: 700; font-size: 13px; border: 1.5px solid #000; padding: 2px 0; margin: 0 0 5px; letter-spacing: 2px; }
</style></head><body>
${opts.duplicate ? '<div class="stamp">DUPLICATE</div>' : ''}
${opts.test ? '<div class="stamp">TEST PRINT</div>' : ''}
<div class="center">
${settings.logo ? `<img class="logo" src="${esc(settings.logo)}" alt="">` : ''}
<div class="shop">${esc(String(settings.shopName).toUpperCase())}</div>
${settings.address ? `<div class="small">${esc(settings.address)}</div>` : ''}
${contact}
</div>
<div class="rule"></div>
${row('Bill No.', String(bill.no).padStart(4, '0'))}
${row('Date', formatWhen(bill.createdAt))}
${row('Cashier', esc(bill.cashier))}
${customer}
<div class="rule"></div>
${lines}
<div class="rule"></div>
${row('Subtotal', fmt(bill.subtotal))}
${bill.discount > 0 ? row(discountLabel(bill), '-' + fmt(bill.discount)) : ''}
${row('<b>TOTAL</b>', '<b class="total">Rs. ' + fmt(bill.total) + '</b>')}
${row('Paid by', esc(bill.method))}
${isCash ? row('Received', fmt(bill.received)) + row('Change', fmt(bill.change)) : ''}
<div class="rule"></div>
<div class="center">
${settings.footer ? `<div>${esc(settings.footer)}</div>` : ''}
${settings.qr ? `<img class="qr" src="${esc(settings.qr)}" alt="">${settings.whatsapp ? '<div class="small">Scan to chat on WhatsApp</div>' : ''}` : ''}
</div>
</body></html>`;
}

// A made-up bill used for "Test print" in Settings.
function sampleBill(now = new Date()) {
  return {
    no: 0,
    createdAt: now.toISOString(),
    cashier: 'Test',
    customerName: '',
    customerPhone: '',
    lines: [
      { name: 'Sample Suit One', price: 4000, qty: 1, amount: 4000 },
      { name: 'Sample Suit Two', price: 4500, qty: 2, amount: 9000 },
    ],
    subtotal: 13000,
    discountType: 'pct',
    discountValue: 10,
    discount: 1300,
    total: 11700,
    method: 'Cash',
    received: 12000,
    change: 300,
    status: 'paid',
  };
}

module.exports = { buildReceiptHtml, sampleBill, formatWhen };
