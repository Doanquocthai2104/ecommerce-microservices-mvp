const assert = require("node:assert/strict");

const {
  mongoose,
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

async function main() {
  await connectDatabase();

  assert.equal(mongoose.connection.name, "shipment_db");
  console.log("PASS: Connected to shipment_db");

  const result = await mongoose.connection.db.command({
    ping: 1,
  });

  assert.equal(result.ok, 1);
  console.log("PASS: MongoDB responds to ping");

  console.table([
    {
      database: mongoose.connection.name,
      host: mongoose.connection.host,
      port: mongoose.connection.port,
    },
  ]);

  console.log(
    "Shipment Service connected to MongoDB successfully"
  );
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});