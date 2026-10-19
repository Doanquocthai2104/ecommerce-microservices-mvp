const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../src/infrastructure/database");

async function main() {
  const sql = await fs.readFile(
    path.join(__dirname, "../migrations/001_init_customer.sql"),
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

  const connection = await pool.query(`
    SELECT
      current_database() AS database,
      current_user AS username
  `);

  console.table(connection.rows);

  const memberships = await pool.query(`
    SELECT mid, mname, score
    FROM public."MemberShip"
    ORDER BY mid
  `);

  console.table(memberships.rows);

  console.log("Customer database initialized successfully");
}

main()
  .catch((err) => {
    console.error("Customer database initialization failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());