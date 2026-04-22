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

// 트랜잭션 헬퍼: fn(client) 안에서 던진 에러는 ROLLBACK, 정상 종료는 COMMIT
// client를 명시적으로 받아야 같은 연결에서 BEGIN/쿼리/COMMIT이 묶임
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  withTransaction,
};
