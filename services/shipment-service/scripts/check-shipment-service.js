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

const ShipmentService = require(
  "../src/application/shipment-service"
);

const repository = new ShipmentRepository();
const service = new ShipmentService(repository);
const eventIds = [];

const customer = { uid: 2147483000, role: "CUSTOMER" };
const otherCustomer = { uid: 2147482999, role: "CUSTOMER" };
const staff = { uid: 2147482998, role: "SHIPMENT_STAFF" };
const admin = { uid: 2147482997, role: "ADMIN" };

async function createFixture() {
  let oid;

  do {
    oid = randomInt(1000000000, 2147483647);
  } while (await Shipment.exists({ oid }));

  const sourceEventId = randomUUID();
  eventIds.push(sourceEventId);

  return repository.ensureShipment({
    oid,
    uid: customer.uid,
    sourceEventId,
    eventHash: "a".repeat(64),
  });
}

async function expectError(action, code) {
  await assert.rejects(action, (err) => {
    assert.equal(
      err.code,
      code,
      `Expected ${code}, received ${err.code}: ${err.message}`
    );
    return true;
  });
}

async function main() {
  await connectDatabase();
  await repository.initialize();

  const shipment = await createFixture();

  const own = await service.getShipment(
    customer,
    shipment.shipid
  );

  assert.equal(own.shipid, shipment.shipid);

  console.log("PASS: Customer reads own shipment");

  await expectError(
    () =>
      service.getShipment(otherCustomer, shipment.shipid),
    "FORBIDDEN"
  );

  console.log("PASS: Customer cannot read another customer's shipment");

  for (const actor of [staff, admin]) {
    const result = await service.getShipment(
      actor,
      shipment.shipid
    );

    assert.equal(result.shipid, shipment.shipid);
  }

  console.log("PASS: Shipment staff and admin can read shipment");

  await expectError(
    () =>
      service.updateStatus(
        customer,
        shipment.shipid,
        "SHIPPING"
      ),
    "FORBIDDEN"
  );

  console.log("PASS: Customer cannot update shipment status");

  const shipping = await service.updateStatus(
    staff,
    shipment.shipid,
    "SHIPPING"
  );

  const repeated = await service.updateStatus(
    staff,
    shipment.shipid,
    "SHIPPING"
  );

  assert.equal(shipping.status, "SHIPPING");
  assert.equal(repeated.status, "SHIPPING");
  assert.equal(
    repeated.updatedAt.toISOString(),
    shipping.updatedAt.toISOString()
  );

  console.log("PASS: Staff updates to SHIPPING and repeated update preserves it");

  const delivered = await service.updateStatus(
    admin,
    shipment.shipid,
    "DELIVERED"
  );

  assert.equal(delivered.status, "DELIVERED");

  for (const status of ["SHIPPING", "CANCELLED"]) {
    await expectError(
      () =>
        service.updateStatus(admin, shipment.shipid, status),
      "INVALID_INPUT"
    );
  }

  console.log("PASS: Admin delivers shipment and terminal state cannot be reversed");

  const cancellation = await createFixture();

  const cancelled = await service.updateStatus(
    staff,
    cancellation.shipid,
    "CANCELLED"
  );

  assert.equal(cancelled.status, "CANCELLED");

  await expectError(
    () =>
      service.updateStatus(
        staff,
        cancellation.shipid,
        "SHIPPING"
      ),
    "INVALID_INPUT"
  );

  console.log("PASS: Pending shipment can be cancelled and remains terminal");

  const pending = await createFixture();

  await expectError(
    () =>
      service.updateStatus(
        staff,
        pending.shipid,
        "DELIVERED"
      ),
    "INVALID_INPUT"
  );

  console.log("PASS: PENDING cannot skip directly to DELIVERED");

  await expectError(
    () =>
      service.updateStatus(
        staff,
        pending.shipid,
        "IN_TRANSIT"
      ),
    "INVALID_INPUT"
  );

  await expectError(
    () => service.getShipment(customer, 0),
    "INVALID_INPUT"
  );

  console.log("PASS: Invalid status and shipment ID rejected");

  // Một ID đã cấp nhưng xóa fixture trước khi gọi application.
  const missing = await createFixture();

  await Shipment.deleteOne({
    sourceEventId: missing.sourceEventId,
  });

  await expectError(
    () => service.getShipment(admin, missing.shipid),
    "NOT_FOUND"
  );

  await expectError(
    () =>
      service.updateStatus(
        staff,
        missing.shipid,
        "SHIPPING"
      ),
    "NOT_FOUND"
  );

  console.log("PASS: Missing shipment operations return NOT_FOUND");

  await expectError(
    () => service.getShipment(null, pending.shipid),
    "INVALID_CREDENTIALS"
  );

  await expectError(
    () =>
      service.updateStatus(
        null,
        pending.shipid,
        "SHIPPING"
      ),
    "INVALID_CREDENTIALS"
  );

  console.log("PASS: Unauthenticated access rejected");

  const competing = await createFixture();

  const results = await Promise.allSettled([
    repository.updateStatus(
      competing.shipid,
      "PENDING",
      "SHIPPING"
    ),
    repository.updateStatus(
      competing.shipid,
      "PENDING",
      "CANCELLED"
    ),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  const successful = results
    .map((result) => result.value)
    .filter(Boolean);

  assert.equal(successful.length, 1);

  const final = await repository.findByShipid(
    competing.shipid
  );

  assert.equal(final.status, successful[0].status);

  console.log("PASS: Concurrent updates cannot overwrite the same expected state");

  console.log("Shipment service checks completed successfully");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    try {
      await Shipment.deleteMany({
        sourceEventId: { $in: eventIds },
      });
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