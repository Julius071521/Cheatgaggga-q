'use strict';
const mysql = require('mysql2/promise');
const env = require('../config/env');

const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_general_ci',
  // Keep DECIMAL columns as strings so money never touches binary floats accidentally.
  decimalNumbers: false,
  supportBigNumbers: true,
});

module.exports = pool;
