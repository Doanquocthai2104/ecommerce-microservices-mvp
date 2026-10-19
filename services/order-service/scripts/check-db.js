const assert = require("node:assert/strict");
const pool = require("../src/infrastructure/database");

async function main() {
  const result = await pool.query(`
    SELECT
      current_database() AS database,
      current_user AS username
  `);

  const connection = result.rows[0];

  assert.equal(connection.database, "order_db");
  console.log("PASS: Connected to order_db");

  assert.equal(connection.username, "order_user");
  console.log("PASS: Connected as order_user");

  console.table(result.rows);
  console.log("Order Service connected to PostgreSQL successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());