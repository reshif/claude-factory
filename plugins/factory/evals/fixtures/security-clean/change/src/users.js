const db = require('./db');

// GET /users?name=… — look a user up by name, case-insensitively.
function findUsers(req, res) {
  const name = String(req.query.name || '').toLowerCase();
  db.query('SELECT id, name, email FROM users WHERE LOWER(name) = ?', [name], (err, rows) => {
    if (err) return res.status(500).json({ error: 'lookup failed' });
    res.json(rows);
  });
}

module.exports = { findUsers };
