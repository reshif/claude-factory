// Page n (1-based) of `items`, `size` per page.
function paginate(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
module.exports = { paginate };
