const assert = require("node:assert/strict");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

async function main() {
  const connection = await connectDatabase();

  assert.equal(connection.name, "product_db");
  console.log("PASS: Connected to product_db");

  const result = await connection.db.command({ ping: 1 });

  assert.equal(result.ok, 1);
  console.log("PASS: MongoDB responds to ping");

  console.table([
    {
      database: connection.name,
      host: connection.host,
      port: connection.port,
    },
  ]);

  console.log("Product Service connected to MongoDB successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());