// Linear scan over every product title, recomputed on each keystroke.
function search(products, q) {
  return products.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));
}
module.exports = { search };
