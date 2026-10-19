const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../src/infrastructure/database");

async function main() {
  const sql = await fs.readFile(
    path.join(__dirname, "../migrations/001_init_auth.sql"),
    "utf8"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");

    console.log("Auth database initialized successfully");

    const result = await client.query(`
      SELECT roleid, rolename
      FROM public."Role"
      ORDER BY roleid
    `);

    console.table(result.rows);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("Database initialization failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());