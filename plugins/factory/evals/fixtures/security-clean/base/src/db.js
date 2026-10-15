// Thin wrapper over the driver: query(sql, params, cb).
module.exports = require('mysql2').createPool({ uri: process.env.DATABASE_URL });
