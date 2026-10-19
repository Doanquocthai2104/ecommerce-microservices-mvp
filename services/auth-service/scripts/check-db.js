const pool = require("../src/infrastructure/database");

async function main() {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS username
    `);

    console.table(result.rows);
    console.log("Auth Service connected to PostgreSQL successfully");
  } catch (err) {
    console.error("Database connection failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();