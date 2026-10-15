const db = require('./db');

// GET /users?name=… — look a user up by name.
function findUsers(req, res) {
  db.query('SELECT id, name, email FROM users WHERE name = ?', [req.query.name], (err, rows) => {
    if (err) return res.status(500).json({ error: 'lookup failed' });
    res.json(rows);
  });
}

module.exports = { findUsers };
