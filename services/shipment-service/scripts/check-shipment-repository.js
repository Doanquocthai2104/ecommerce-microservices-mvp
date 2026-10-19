const assert = require("node:assert/strict");
const { randomUUID, randomInt } = require("node:crypto");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Shipment = require("../src/infrastructure/shipment-model");
const ShipmentRepository = require(
  "../src/infrastructure/shipment-repository"
);

const repository = new ShipmentRepository();
const createdEventIds = [];

async function newInput() {
  let oid;

  do {
    oid = randomInt(1000000000, 2147483647);
  } while (await Shipment.exists({ oid }));

  const sourceEventId = randomUUID();
  createdEventIds.push(sourceEventId);

  return {
    oid,
    uid: 2147483000,
    sourceEventId,
    eventHash: "a".repeat(64),
  };
}

async function expectError(action, expectedCode) {
  await assert.rejects(action, (err) => {
    assert.equal(
      err.code,
      expectedCode,
      `Expected ${expectedCode}, received ${err.code}: ${err.message}`
    );

    return true;
  });
}

async function waitAll(promises) {
  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  return results.map((result) => result.value);
}

async function main() {
  await connectDatabase();
  await repository.initialize();

  const input = await newInput();
  const created = await repository.ensureShipment(input);

  assert.ok(
    Number.isInteger(created.shipid) &&
    created.shipid > 0
  );

  assert.equal(created.oid, input.oid);
  assert.equal(created.uid, input.uid);
  assert.equal(created.status, "PENDING");

  console.log("PASS: Shipment created with generated ID and PENDING status");

  const byId = await repository.findByShipid(created.shipid);
  const byOrder = await repository.findByOid(input.oid);

  assert.equal(byId.shipid, created.shipid);
  assert.equal(byOrder.shipid, created.shipid);

  console.log("PASS: Shipment retrieved by shipment ID and order ID");

  // Chuẩn bị trạng thái để kiểm tra replay không ghi đè.
  // Quyền và quy tắc cập nhật sẽ triển khai ở tầng application.
  await Shipment.updateOne(
    { shipid: created.shipid },
    { $set: { status: "SHIPPING" } },
    { runValidators: true }
  );

  const repeated = await repository.ensureShipment(input);

  assert.equal(repeated.shipid, created.shipid);
  assert.equal(repeated.status, "SHIPPING");

  assert.equal(
    await Shipment.countDocuments({
      sourceEventId: input.sourceEventId,
    }),
    1
  );

  console.log("PASS: Repeated event preserves existing shipment and status");

  await expectError(
    () =>
      repository.ensureShipment({
        ...input,
        eventHash: "b".repeat(64),
      }),
    "CONFLICT"
  );

  console.log("PASS: Same event with changed content rejected");

  await expectError(
    () =>
      repository.ensureShipment({
        ...input,
        uid: input.uid - 1,
      }),
    "CONFLICT"
  );

  await expectError(
    () =>
      repository.ensureShipment({
        ...input,
        sourceEventId: randomUUID(),
      }),
    "CONFLICT"
  );

  console.log("PASS: Changed customer or event identity cannot reuse the order");

  const concurrentInput = await newInput();

  const concurrent = await waitAll(
    Array.from({ length: 10 }, () =>
      repository.ensureShipment(concurrentInput)
    )
  );

  assert.equal(
    new Set(concurrent.map((item) => item.shipid)).size,
    1
  );

  assert.equal(
    await Shipment.countDocuments({
      sourceEventId: concurrentInput.sourceEventId,
    }),
    1
  );

  console.log("PASS: Concurrent identical events create one shipment");

  // Chọn OID khác nhau cho các fixture trong nhóm này.
  const distinctInputs = [];
  const selectedOids = new Set();

  while (distinctInputs.length < 5) {
    const candidate = await newInput();

    if (!selectedOids.has(candidate.oid)) {
      selectedOids.add(candidate.oid);
      distinctInputs.push(candidate);
    }
  }

  const distinct = await waitAll(
    distinctInputs.map((item) =>
      repository.ensureShipment(item)
    )
  );

  assert.equal(
    new Set(distinct.map((item) => item.shipid)).size,
    distinctInputs.length
  );

  console.log("PASS: Concurrent different events receive distinct shipment IDs");

  await expectError(
    () =>
      repository.ensureShipment({
        ...input,
        oid: 0,
      }),
    "INVALID_INPUT"
  );

  await expectError(
    () =>
      repository.ensureShipment({
        ...input,
        sourceEventId: "invalid-id",
      }),
    "INVALID_INPUT"
  );

  await expectError(
    () =>
      repository.ensureShipment({
        ...input,
        eventHash: "invalid-hash",
      }),
    "INVALID_INPUT"
  );

  console.log("PASS: Invalid creation data rejected");

  const unusedInput = await newInput();

  assert.equal(
    await repository.findByOid(unusedInput.oid),
    null
  );

  console.log("PASS: Missing shipment returns null");

  console.log("Shipment repository checks completed successfully");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    try {
      if (createdEventIds.length > 0) {
        await Shipment.deleteMany({
          sourceEventId: { $in: createdEventIds },
        });
      }
    } catch (err) {
      console.error("Cleanup failed:", err.message);
      process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});