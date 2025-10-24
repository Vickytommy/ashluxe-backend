// db/index.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log('✅ Connected to PostgreSQL successfully'))
  .catch((err) => console.error('❌ PostgreSQL connection error:', err.message));

module.exports = pool;
