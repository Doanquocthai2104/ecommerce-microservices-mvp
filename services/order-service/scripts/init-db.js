const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../src/infrastructure/database");

async function main() {
  const sql = await fs.readFile(
    path.join(__dirname, "../migrations/001_init_order.sql"),
    "utf8"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name IN (
        'Order',
        'OrderDetail',
        'OutboxEvent'
      )
    ORDER BY table_name
  `);

  console.table(result.rows);
  console.log("Order database initialized successfully");
}

main()
  .catch((err) => {
    console.error("Order database initialization failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());