'use strict';

// The one-day sales report as a printable page (saved as a PDF by the program). Owner only.
const { fmt } = require('./money');

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const rs = (n) => 'Rs ' + fmt(n);

function dayLabel(key) {
  const [y, m, d] = key.split('-');
  return `${d}-${m}-${y}`;
}
function timeOf(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(d.getMinutes())} ${ap}`;
}

// report = dailyReport() result, bills = searchBills() for that day (oldest first is fine, it is sorted here)
function buildDayReportHtml(report, bills, settings, madeAt = new Date()) {
  const list = bills.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const rows = list.map((b) => {
    const cancelled = b.status === 'cancelled';
    const items = b.lines.map((l) => `${esc(l.name)} &times; ${l.qty}`).join('<br>');
    const how = cancelled ? 'Cancelled' : (b.due > 0 ? `${esc(b.method)} (udhaar ${rs(b.due)})` : esc(b.method));
    return `<tr class="${cancelled ? 'x' : ''}"><td>${esc(b.invoice || String(b.no).padStart(4, '0'))}</td><td>${timeOf(b.createdAt)}</td><td>${items}</td>
      <td class="r">${b.discount ? '-' + rs(b.discount) : ''}</td><td class="r"><b>${rs(b.total)}</b></td><td>${how}</td></tr>`;
  }).join('');
  const methods = Object.entries(report.byMethod).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${rs(v)}</td></tr>`).join('');
  const received = Object.values(report.byMethod).reduce((a, b) => a + b, 0);
  const pays = (report.payments || []).map((p) => `<tr><td>${timeOf(p.at)}</td><td>${esc(p.name)}</td><td>${esc(p.method)}</td><td class="r">${rs(p.amount)}</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Sales ${esc(report.dateKey)}</title><style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11px; color: #111; margin: 0; }
h1 { font-size: 20px; margin: 0; letter-spacing: 1px; }
.sub { color: #555; margin: 2px 0 12px; }
h2 { font-size: 12px; margin: 16px 0 6px; letter-spacing: 1px; text-transform: uppercase; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #444; border-bottom: 1.5px solid #111; padding: 5px 6px; }
td { padding: 5px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
.r { text-align: right; white-space: nowrap; }
.x td { color: #888; text-decoration: line-through; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.stat { border: 1px solid #bbb; border-radius: 4px; padding: 7px 9px; }
.stat i { display: block; font-style: normal; font-size: 9.5px; color: #555; text-transform: uppercase; letter-spacing: .5px; }
.stat b { font-size: 15px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.foot { margin-top: 18px; color: #777; font-size: 9.5px; }
</style></head><body>
<h1>${esc(String(settings.shopName).toUpperCase())}</h1>
<div class="sub">Sales report for ${dayLabel(report.dateKey)}${settings.address ? ' &middot; ' + esc(settings.address) : ''}</div>
<div class="stats">
  <div class="stat"><i>Sales</i><b>${rs(report.sales)}</b></div>
  <div class="stat"><i>Bills</i><b>${report.bills}</b></div>
  <div class="stat"><i>Discounts given</i><b>${rs(report.discounts)}</b></div>
  <div class="stat"><i>Cancelled bills</i><b>${report.cancelled}</b></div>
  <div class="stat"><i>Udhaar given today</i><b>${rs(report.udhaarGiven || 0)}</b></div>
  <div class="stat"><i>Udhaar collected today</i><b>${rs(report.udhaarCollected || 0)}</b></div>
  <div class="stat"><i>Money received today</i><b>${rs(received)}</b></div>
</div>
<div class="two">
  <div><h2>Money received by method</h2><table><tbody>${methods || '<tr><td>Nothing received.</td><td></td></tr>'}</tbody></table></div>
  <div><h2>Udhaar money received</h2>${pays ? `<table><tbody>${pays}</tbody></table>` : '<div class="sub">None today.</div>'}</div>
</div>
<h2>Bills</h2>
<table><thead><tr><th>Invoice</th><th>Time</th><th>Items</th><th class="r">Discount</th><th class="r">Total</th><th>Paid by</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No bills on this day.</td></tr>'}</tbody></table>
<div class="foot">Made on ${dayLabel(`${madeAt.getFullYear()}-${pad2(madeAt.getMonth() + 1)}-${pad2(madeAt.getDate())}`)} at ${timeOf(madeAt.toISOString())}. Cancelled bills are crossed out and are not in the sales figure.</div>
</body></html>`;
}

module.exports = { buildDayReportHtml };
