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

const {
  RejectedMessage,
  RejectedMessageRepository,
} = require("../src/infrastructure/rejected-message-repository");

const HandleOrderCreated = require(
  "../src/application/handle-order-created"
);

const ProcessOrderMessage = require(
  "../src/application/process-order-message"
);

const topic = `shipment-check-${randomUUID()}`;
const eventIds = [];
let nextOffset = 0;

function messageInput(value) {
  return {
    topic,
    partition: 0,
    message: {
      offset: String(nextOffset++),
      key: Buffer.from("test-key"),
      value:
        value === null
          ? null
          : Buffer.from(
              typeof value === "string"
                ? value
                : JSON.stringify(value)
            ),
    },
  };
}

async function validEvent() {
  let oid;

  do {
    oid = randomInt(1000000000, 2147483647);
  } while (await Shipment.exists({ oid }));

  const eventId = randomUUID();
  eventIds.push(eventId);

  return {
    eventId,
    eventType: "OrderCreated",
    occurredAt: "2026-10-19T08:00:00.000Z",
    data: {
      oid,
      uid: 2147483000,
      subtotal: "25.00",
      discount: "0.00",
      total_amount: "25.00",
      items: [
        { pid: 101, qty: 2, unit_price: "12.50" },
      ],
    },
  };
}

async function main() {
  await connectDatabase();

  const repository = new ShipmentRepository();
  const rejectedMessages = new RejectedMessageRepository();

  await repository.initialize();
  await rejectedMessages.initialize();

  const handler = new HandleOrderCreated(repository);

  const processor = new ProcessOrderMessage({
    handler,
    rejectedMessages,
  });

  const event = await validEvent();
  const first = await processor.execute(messageInput(event));

  assert.equal(first.status, "PROCESSED");
  assert.ok(first.shipid > 0);

  console.log("PASS: Valid message creates a shipment");

  const repeated = await processor.execute(messageInput(event));

  assert.equal(repeated.shipid, first.shipid);

  assert.equal(
    await Shipment.countDocuments({
      sourceEventId: event.eventId,
    }),
    1
  );

  console.log("PASS: Repeated event does not create another shipment");

  const invalidJson = messageInput("{invalid-json");
  invalidJson.message.offset = "9007199254740993";

  const rejected = await processor.execute(invalidJson);
  assert.equal(rejected.status, "REJECTED");

  const storedError = await RejectedMessage.findOne({
    topic,
    partition: 0,
    offset: invalidJson.message.offset,
  }).lean();

  assert.ok(storedError);
  assert.equal(storedError.errorCode, "INVALID_INPUT");
  assert.equal(
    storedError.rawValue.toString("utf8"),
    "{invalid-json"
  );
  assert.equal(storedError.offset, "9007199254740993");

  console.log("PASS: Invalid JSON is stored with its exact Kafka offset");

  await processor.execute(invalidJson);

  assert.equal(
    await RejectedMessage.countDocuments({
      topic,
      partition: 0,
      offset: invalidJson.message.offset,
    }),
    1
  );

  console.log("PASS: Repeated invalid message produces one rejection record");

  const missingOid = await validEvent();
  delete missingOid.data.oid;

  const missingResult = await processor.execute(
    messageInput(missingOid)
  );

  assert.equal(missingResult.status, "REJECTED");

  assert.equal(
    await Shipment.countDocuments({
      sourceEventId: missingOid.eventId,
    }),
    0
  );

  console.log("PASS: Event missing order ID is rejected without creating shipment");

  const conflicting = structuredClone(event);
  conflicting.data.discount = "1.00";
  conflicting.data.total_amount = "24.00";

  const conflictResult = await processor.execute(
    messageInput(conflicting)
  );

  assert.equal(conflictResult.status, "REJECTED");

  const original = await repository.findByShipid(first.shipid);
  assert.equal(original.status, "PENDING");

  assert.equal(
    await Shipment.countDocuments({
      sourceEventId: event.eventId,
    }),
    1
  );

  console.log("PASS: Conflicting event is recorded without changing the shipment");

  const errorCountBefore = await RejectedMessage.countDocuments({
    topic,
  });

  const unavailableProcessor = new ProcessOrderMessage({
    handler: {
      async execute() {
        throw new Error("Simulated MongoDB unavailable");
      },
    },
    rejectedMessages,
  });

  await assert.rejects(
    () =>
      unavailableProcessor.execute(messageInput(event)),
    /Simulated MongoDB unavailable/
  );

  assert.equal(
    await RejectedMessage.countDocuments({ topic }),
    errorCountBefore
  );

  console.log("PASS: Infrastructure failure propagates for retry");

  const failedRejectionProcessor = new ProcessOrderMessage({
    handler,
    rejectedMessages: {
      async save() {
        throw new Error("Simulated rejection storage failure");
      },
    },
  });

  await assert.rejects(
    () =>
      failedRejectionProcessor.execute(
        messageInput("{invalid-json")
      ),
    /Simulated rejection storage failure/
  );

  console.log("PASS: Failed rejection storage propagates instead of skipping message");

  console.log("Order message checks completed successfully");
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

      await RejectedMessage.deleteMany({ topic });
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