'use strict';

// All money is whole rupees (integers). Nothing here uses decimals, so there is no rounding drift.
// This file is also loaded by the screens (as window.Money), so the total shown while billing
// and the total that gets saved come from exactly the same code.
const UserError = typeof require === 'function'
  ? require('./errors').UserError
  : class UserError extends Error {
      constructor(message) {
        super(message);
        this.userError = true;
      }
    };

const MAX_QTY = 999;
const MAX_PRICE = 10000000;

function isRupees(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

// 4000 -> "4,000"
function fmt(n) {
  const v = Math.round(Number(n) || 0);
  const sign = v < 0 ? '-' : '';
  return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Percent discount, rounded to the nearest whole rupee (half rounds up), using integer maths only.
// pct may have up to two decimals (7.5, 12.25).
function percentOf(subtotal, pct) {
  const hundredths = Math.round(Number(pct) * 100); // 10 -> 1000
  if (!Number.isFinite(hundredths) || hundredths < 0 || hundredths > 10000) {
    throw new UserError('Discount percentage must be between 0 and 100.');
  }
  // round(subtotal * hundredths / 10000), half up, without floating point division
  return Math.floor((subtotal * hundredths * 2 + 10000) / 20000);
}

function lineAmount(price, qty) {
  if (!isRupees(price) || price < 1 || price > MAX_PRICE) throw new UserError('A suit has an invalid price.');
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new UserError('Quantity must be a whole number from 1 to ' + MAX_QTY + '.');
  return price * qty;
}

// discount: { type: 'none' | 'pct' | 'amt', value }
function computeTotals(lines, discount) {
  let subtotal = 0;
  for (const l of lines) subtotal += lineAmount(l.price, l.qty);
  const type = discount && discount.type ? discount.type : 'none';
  let value = discount && discount.value !== undefined && discount.value !== '' ? Number(discount.value) : 0;
  let amount = 0;
  if (type === 'pct') {
    amount = percentOf(subtotal, value);
  } else if (type === 'amt') {
    if (!Number.isInteger(value) || value < 0) throw new UserError('Discount in rupees must be a whole number.');
    amount = value;
  } else if (type !== 'none') {
    throw new UserError('Unknown discount type.');
  }
  if (amount > subtotal) throw new UserError('Discount cannot be more than the bill amount.');
  const total = subtotal - amount;
  return {
    subtotal,
    discountType: amount === 0 ? 'none' : type,
    discountValue: amount === 0 ? 0 : value,
    discount: amount,
    total,
  };
}

const api = { fmt, percentOf, lineAmount, computeTotals, isRupees, MAX_QTY, MAX_PRICE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.Money = api;
