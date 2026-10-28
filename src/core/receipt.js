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

function discountLabel(bill) {
  if (bill.discountType === 'pct') return `Discount (${Number(bill.discountValue)}%)`;
  return 'Discount';
}

// opts: { duplicate: boolean, test: boolean }
function buildReceiptHtml(bill, settings, opts = {}) {
  const width = settings.paperWidthMm === 58 ? 48 : 72; // printable width in mm
  const narrow = settings.paperWidthMm === 58;
  const row = (l, r, cls) => `<div class="row ${cls || ''}"><span>${l}</span><span>${r}</span></div>`;
  const lines = bill.lines
    .map((l, i) => `<div class="item"><div class="name"><span class="no">${i + 1}</span>${esc(l.name)}</div>${row(`<span class="q">${l.qty} &times; Rs. ${fmt(l.price)}</span>`, 'Rs. ' + fmt(l.amount), 'amt')}</div>`)
    .join('');
  const contact = [settings.phone && 'Ph: ' + esc(settings.phone), settings.whatsapp && 'WhatsApp: ' + esc(settings.whatsapp)]
    .filter(Boolean)
    .map((t) => `<div class="small">${t}</div>`)
    .join('');
  const isCash = String(bill.method).toLowerCase() === 'cash';
  const due = bill.due || 0; // udhaar is kept in the program's own khata and is never printed on the receipt
  const suitCount = bill.lines.reduce((n, l) => n + l.qty, 0);

  const payBlock = due > 0
    ? ''
    : `<div class="pay">${row('Paid by', esc(bill.method))}${isCash ? row('Received', fmt(bill.received)) + row('Change', fmt(bill.change)) : ''}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Bill ${bill.no}</title><style>
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: ${width}mm; padding: 3mm 1.5mm 5mm; font-family: "Segoe UI", Arial, sans-serif; font-size: 12px; line-height: 1.4; color: #000; }
.center { text-align: center; }
.shop { font-size: ${narrow ? 17 : 21}px; font-weight: 800; letter-spacing: ${narrow ? 1.5 : 3}px; margin: 2px 0 1px; line-height: 1.15; }
.small { font-size: 11px; }
.logo { max-width: 40mm; max-height: 22mm; margin: 0 auto 3px; display: block; }
.qr { width: 28mm; height: 28mm; margin: 5px auto 0; display: block; }
.thin { border-top: 1px solid #000; margin: 5px 0; }
.dots { border-top: 1px dotted #000; margin: 4px 0; }
.orn { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 9px; }
.orn.top { margin: 7px 0 4px; }
.orn::before, .orn::after { content: ""; flex: 1; border-top: 1px solid #000; }
.title { text-align: center; font-size: 10.5px; font-weight: 700; letter-spacing: 6px; margin: 0 0 3px; }
.row { display: flex; justify-content: space-between; gap: 6px; }
.row > span:last-child { text-align: right; white-space: nowrap; }
.band { display: flex; justify-content: space-between; align-items: flex-end; padding: 3px 1px; }
.band i { display: block; font-style: normal; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: #333; }
.band b { font-size: 15px; letter-spacing: 1px; }
.band .r { text-align: right; }
.no { display: inline-block; min-width: 14px; font-size: 10px; font-weight: 700; margin-right: 4px; border: 1px solid #000; border-radius: 50%; text-align: center; line-height: 13px; height: 14px; padding: 0 2px; }
.item { margin: 4px 0; padding-bottom: 3px; border-bottom: 1px dotted #777; }
.item:last-child { border-bottom: 0; }
.name { font-weight: 700; font-size: 12.5px; }
.q { font-size: 11px; }
.amt > span:last-child { font-weight: 700; }
.totalbox { border: 2px solid #000; padding: 4px 7px; margin: 6px 0 4px; display: flex; justify-content: space-between; align-items: baseline; font-weight: 800; }
.totalbox span { font-size: ${narrow ? 10.5 : 12}px; letter-spacing: ${narrow ? 1.5 : 3}px; }
.totalbox b { font-size: ${narrow ? 16 : 23}px; white-space: nowrap; }
.saved { text-align: center; font-size: 10.5px; letter-spacing: 1px; margin: 2px 0 4px; }
.pay { margin-top: 3px; }
.thanks { font-size: 12px; font-weight: 600; letter-spacing: 1.5px; margin-top: 2px; }
.stamp { text-align: center; font-weight: 800; font-size: 13px; border: 2px solid #000; padding: 2px 0; margin: 0 0 6px; letter-spacing: 4px; }
</style></head><body>
${opts.duplicate ? '<div class="stamp">DUPLICATE</div>' : ''}
${opts.test ? '<div class="stamp">TEST PRINT</div>' : ''}
<div class="center">
${settings.logo ? `<img class="logo" src="${esc(settings.logo)}" alt="">` : ''}
<div class="shop">${esc(String(settings.shopName).toUpperCase())}</div>
${settings.address ? `<div class="small">${esc(settings.address)}</div>` : ''}
${contact}
</div>
<div class="orn top">&#9670;</div>
<div class="title">RECEIPT</div>
<div class="band">
<div><i>Bill No.</i><b>${String(bill.no).padStart(4, '0')}</b></div>
<div class="r"><i>${dateOnly(bill.createdAt)}</i><b>${timeOnly(bill.createdAt)}</b></div>
</div>
<div class="thin"></div>
${lines}
<div class="thin"></div>
${row('Items', suitCount + (suitCount === 1 ? ' suit' : ' suits'))}
${row('Subtotal', fmt(bill.subtotal))}
${bill.discount > 0 ? row(discountLabel(bill), '-' + fmt(bill.discount)) : ''}
<div class="totalbox"><span>TOTAL</span><b>Rs. ${fmt(bill.total)}</b></div>
${bill.discount > 0 ? `<div class="saved">You saved Rs. ${fmt(bill.discount)}</div>` : ''}
${payBlock}
<div class="orn">&#9670;</div>
<div class="center">
<div class="thanks">${esc(settings.footer || 'Thank you for shopping with us')}</div>
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
