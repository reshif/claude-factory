// Cart total in cents: sum of price × qty, minus a percentage discount, rounded once.
function cartTotal(items, discountPct = 0) {
  const subtotal = items.reduce((s, i) => s + i.priceCents * i.qty, 0);
  return Math.round(subtotal * (1 - discountPct / 100));
}
module.exports = { cartTotal };
