const { cartTotal } = require('../src/cart');

test('applies quantity', () => {
  expect(cartTotal([{ priceCents: 250, qty: 2 }])).toBe(500);
});
