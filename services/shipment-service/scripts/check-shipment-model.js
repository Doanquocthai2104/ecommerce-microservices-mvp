const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Shipment = require("../src/infrastructure/shipment-model");

function validInput() {
  return {
    shipid: 1,
    oid: 1001,
    uid: 1,
    sourceEventId: randomUUID(),
    eventHash: "a".repeat(64),
  };
}

async function expectInvalid(changes, field) {
  const shipment = new Shipment({
    ...validInput(),
    ...changes,
  });

  await assert.rejects(
    () => shipment.validate(),
    (err) => {
      assert.ok(
        err.errors?.[field],
        `Expected validation error on field ${field}`
      );

      return true;
    }
  );
}

async function main() {
  await connectDatabase();
  await Shipment.init();

  const indexes = await Shipment.collection.indexes();

  for (const field of ["shipid", "oid", "sourceEventId"]) {
    assert.ok(
      indexes.some(
        (index) =>
          index.unique === true &&
          index.key[field] === 1 &&
          Object.keys(index.key).length === 1
      ),
      `Missing unique index for ${field}`
    );
  }

  console.log(
    "PASS: Shipment has unique shipid, oid and source event indexes"
  );

  const shipment = new Shipment(validInput());

  await shipment.validate();
  assert.equal(shipment.status, "PENDING");

  console.log("PASS: Valid shipment receives PENDING status");

  for (const field of ["shipid", "oid", "uid"]) {
    for (const value of [0, -1, 1.5, 2147483648]) {
      await expectInvalid({ [field]: value }, field);
    }
  }

  console.log(
    "PASS: Invalid shipment, order and customer IDs rejected"
  );

  await expectInvalid(
    { sourceEventId: "invalid-event-id" },
    "sourceEventId"
  );

  await expectInvalid(
    { sourceEventId: undefined },
    "sourceEventId"
  );

  console.log("PASS: Missing or invalid source event ID rejected");

  await expectInvalid(
    { eventHash: "invalid-hash" },
    "eventHash"
  );

  await expectInvalid(
    { eventHash: undefined },
    "eventHash"
  );

  console.log("PASS: Missing or invalid event hash rejected");

  for (const status of [
    "PENDING",
    "SHIPPING",
    "DELIVERED",
    "CANCELLED",
  ]) {
    const candidate = new Shipment({
      ...validInput(),
      status,
    });

    await candidate.validate();
  }

  console.log("PASS: All four documented statuses accepted");

  await expectInvalid({ status: "IN_TRANSIT" }, "status");
  await expectInvalid({ status: "" }, "status");

  console.log("PASS: Unsupported shipment status rejected");

  console.log("Shipment model checks completed successfully");
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