require('dotenv').config();
const { Pool } = require('pg');

// Render 등 운영환경은 DATABASE_URL 하나로 받고 SSL 필수
// 로컬은 기존 개별 환경변수 방식
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
