const path = require("node:path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL connection error:", err.message);
});

module.exports = pool;