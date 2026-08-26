import pool from './db.js';

(async () => {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('DB Connected:', result.rows[0]);
  } catch (err) {
    console.error('DB Error:', err.message);
  } finally {
    process.exit();
  }
})();