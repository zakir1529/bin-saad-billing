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

function dateOnly(iso) {
  const d = new Date(iso);
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}
function timeOnly(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(d.getMinutes())} ${ap}`;
}

const rs = (n) => 'Rs ' + fmt(n);

function discountLabel(bill) {
  if (bill.discountType === 'pct') return `Discount (${Number(bill.discountValue)}%)`;
  return 'Discount';
}

// opts: { duplicate: boolean, test: boolean }
// Layout: date and SALES on top, shop details, a SOLD TO / DATE / INVOICE block, a Qty / Item / Price table,
// "N ITEMS SOLD", subtotal, discount, TOTAL DUE, payment mode, thank-you and the exchange line.
// It never prints the customer's name or phone, who served, or anything about udhaar.
function buildReceiptHtml(bill, settings, opts = {}) {
  const narrow = settings.paperWidthMm === 58;
  const width = narrow ? 44 : 68; // printable width in mm; the page is centred on the paper
  const shift = Number(settings.receiptOffsetMm) || 0;
  const row = (l, r, cls) => `<div class="row ${cls || ''}"><span>${l}</span><span>${r}</span></div>`;
  const invoice = bill.invoice || ((settings.invoicePrefix ? settings.invoicePrefix + '-' : '') + String(bill.no).padStart(4, '0'));
  const items = bill.lines
    .map((l) => `<div class="item"><div class="q">${l.qty}</div><div class="n"><b>${esc(l.name)}</b>${l.qty > 1 ? `<div class="each">${rs(l.price)} each</div>` : ''}</div><div class="p">${rs(l.amount)}</div></div>`)
    .join('');
  const phones = [settings.phone, settings.whatsapp && settings.whatsapp !== settings.phone ? 'WhatsApp ' + settings.whatsapp : '']
    .filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');
  const isCash = String(bill.method).toLowerCase() === 'cash';
  const due = bill.due || 0; // udhaar is kept in the program's own khata and is never printed on the receipt
  const count = bill.lines.reduce((n, l) => n + l.qty, 0);
  const payBlock = due > 0
    ? ''
    : `<div class="pay">${row('PAYMENT MODE:', '<b>' + esc(String(bill.method).toUpperCase()) + '</b>')}${isCash ? row('Received', rs(bill.received), 'small') + row('Change', rs(bill.change), 'small') : ''}</div><div class="dash"></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Bill ${bill.no}</title><style>
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { box-sizing: border-box; width: ${width}mm; margin: 0 auto; position: relative; left: ${shift}mm; padding: 3mm 1.5mm 6mm; font-family: "Segoe UI", Arial, sans-serif; font-size: 12px; line-height: 1.35; color: #000; }
.center { text-align: center; }
.top { display: flex; justify-content: space-between; font-size: 10px; letter-spacing: .5px; margin-bottom: 5px; }
.top b { letter-spacing: 2px; }
.logo { max-width: 40mm; max-height: 22mm; margin: 0 auto 3px; display: block; }
.shop { font-size: ${narrow ? 18 : 24}px; font-weight: 700; letter-spacing: ${narrow ? 1 : 3}px; line-height: 1.1; margin: 2px 0 4px; }
.small { font-size: 11px; }
.solid { border-top: 1.5px solid #000; margin: 5px 0; }
.thin { border-top: 1px solid #000; margin: 4px 0; }
.dash { border-top: 1px dashed #000; margin: 5px 0; }
.dots { border-top: 1px dotted #000; margin: 4px 0; }
.info { margin: 6px 0 4px; }
.info .row span:first-child { font-weight: 600; font-size: 11px; letter-spacing: .5px; }
.row { display: flex; justify-content: space-between; gap: 8px; }
.row > span:last-child { text-align: right; white-space: nowrap; }
.row.small { font-size: 11px; }
.head { display: grid; grid-template-columns: ${narrow ? 22 : 28}px 1fr auto; gap: 6px; font-weight: 600; font-size: 12px; padding: 3px 0; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; margin-top: 6px; }
.head span:last-child { text-align: right; }
.item { display: grid; grid-template-columns: ${narrow ? 22 : 28}px 1fr auto; gap: 6px; padding: 5px 0 4px; border-bottom: 1px dotted #000; }
.item .q { font-weight: 600; }
.item .n b { font-size: 12.5px; }
.item .each { font-size: 10.5px; }
.item .p { font-weight: 600; white-space: nowrap; text-align: right; }
.sold { text-align: center; font-weight: 600; font-size: 12px; letter-spacing: 1.5px; padding: 4px 0; border-bottom: 1.5px solid #000; margin-bottom: 4px; }
.sums .row { padding: 1px 0; font-size: 12px; }
.due { display: flex; justify-content: space-between; align-items: baseline; font-weight: 800; padding: 3px 0 2px; margin: 4px 0 0; border-top: 1px dashed #000; border-bottom: 1px dashed #000; }
.due span { font-size: ${narrow ? 10.5 : 14}px; letter-spacing: ${narrow ? 0 : .5}px; white-space: nowrap; }
.due b { font-size: ${narrow ? 16 : 22}px; white-space: nowrap; }
.pay { margin-top: 3px; font-size: ${narrow ? 10.5 : 12}px; }
.pay .row span:first-child { white-space: nowrap; }
.thanks { font-weight: 600; font-size: 11.5px; letter-spacing: 1px; text-transform: uppercase; margin-top: 3px; }
.exch { font-size: 10.5px; margin-top: 2px; }
.qr { width: 28mm; height: 28mm; margin: 6px auto 0; display: block; }
.stamp { text-align: center; font-weight: 800; font-size: 13px; border: 2px solid #000; padding: 2px 0; margin: 0 0 6px; letter-spacing: 4px; }
</style></head><body>
${opts.duplicate ? '<div class="stamp">DUPLICATE</div>' : ''}
${opts.test ? '<div class="stamp">TEST PRINT</div>' : ''}
<div class="top"><span>${dateOnly(bill.createdAt)}, ${timeOnly(bill.createdAt)}</span><b>SALES</b></div>
<div class="center">
${settings.logo ? `<img class="logo" src="${esc(settings.logo)}" alt="">` : ''}
<div class="shop">${esc(String(settings.shopName).toUpperCase())}</div>
</div>
<div class="solid"></div>
<div class="center">
${settings.address ? `<div class="small">${esc(settings.address)}</div>` : ''}
${phones ? `<div class="small">${phones}</div>` : ''}
</div>
<div class="info">
${row('SOLD TO:', 'Walk-in Customer')}
${row('DATE:', dateOnly(bill.createdAt))}
${row('INVOICE:', '<b>' + esc(invoice) + '</b>')}
</div>
<div class="head"><span>Qty</span><span>Item</span><span>Price</span></div>
${items}
<div class="sold">${count} ${count === 1 ? 'ITEM' : 'ITEMS'} SOLD</div>
<div class="sums">
${row('Subtotal:', rs(bill.subtotal))}
${bill.discount > 0 ? row(discountLabel(bill) + ':', '-' + rs(bill.discount)) : ''}
</div>
<div class="due"><span>TOTAL DUE:</span><b>${rs(bill.total)}</b></div>
${payBlock}
<div class="center">
<div class="thanks">${esc(settings.footer || 'Thank you for shopping with us')}</div>
${settings.exchangeNote ? `<div class="exch">${esc(settings.exchangeNote)}</div>` : ''}
${settings.qr ? `<img class="qr" src="${esc(settings.qr)}" alt="">${settings.whatsapp ? '<div class="small">Scan to chat on WhatsApp</div>' : ''}` : ''}
</div>
</body></html>`;
}

// A made-up bill used for "Test print" in Settings.
function sampleBill(now = new Date()) {
  return {
    no: 0,
    invoice: 'BS-0000',
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
