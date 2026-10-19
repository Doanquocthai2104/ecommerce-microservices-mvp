const assert = require("node:assert/strict");
const { randomUUID, randomInt } = require("node:crypto");
const { Partitioners } = require("kafkajs");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const { kafka } = require("../src/infrastructure/kafka-client");

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

const createOrderConsumer = require(
  "../src/infrastructure/order-consumer"
);

const topic = `shipment-consumer-check-${randomUUID()}`;
const groupId = `shipment-check-${randomUUID()}`;

const admin = kafka.admin();

const producer = kafka.producer({
  allowAutoTopicCreation: false,
  createPartitioner: Partitioners.DefaultPartitioner,
});

const eventIds = [];
const selectedOids = new Set();
let orderConsumer = null;

async function validEvent() {
  let oid;

  do {
    oid = randomInt(1000000000, 2147483647);
  } while (
    selectedOids.has(oid) ||
    await Shipment.exists({ oid })
  );

  selectedOids.add(oid);

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

async function waitUntil(check, message) {
  const deadline = Date.now() + 40000;

  while (Date.now() < deadline) {
    if (await check()) return;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(message);
}

async function main() {
  await connectDatabase();

  const repository = new ShipmentRepository();
  const rejectedMessages = new RejectedMessageRepository();

  await repository.initialize();
  await rejectedMessages.initialize();

  const processor = new ProcessOrderMessage({
    handler: new HandleOrderCreated(repository),
    rejectedMessages,
  });

  await admin.connect();

  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic,
        numPartitions: 1,
        replicationFactor: 1,
      },
    ],
  });

  orderConsumer = createOrderConsumer({
    processor,
    topic,
    groupId,
  });

  await orderConsumer.start();
  await producer.connect();

  const first = await validEvent();
  const second = await validEvent();

  const missingOid = structuredClone(first);
  missingOid.eventId = randomUUID();
  delete missingOid.data.oid;

  const conflicting = structuredClone(first);
  conflicting.data.discount = "1.00";
  conflicting.data.total_amount = "24.00";

  const values = [
    JSON.stringify(first),
    JSON.stringify(first),
    "{invalid-json",
    JSON.stringify(missingOid),
    JSON.stringify(conflicting),
    JSON.stringify(second),
  ];

  const acknowledgements = await producer.send({
    topic,
    acks: -1,
    messages: values.map((value) => ({
      key: "shipment-test",
      value,
    })),
  });

  const expectedOffset = (
    BigInt(acknowledgements[0].baseOffset) +
    BigInt(values.length)
  ).toString();

  await waitUntil(
    async () =>
      (await Shipment.countDocuments({
        sourceEventId: {
          $in: [first.eventId, second.eventId],
        },
      })) === 2 &&
      (await RejectedMessage.countDocuments({ topic })) === 3,
    "Timed out waiting for shipments and rejected messages"
  );

  const firstShipment = await repository.findByOid(first.data.oid);

  assert.ok(firstShipment);
  assert.equal(firstShipment.uid, first.data.uid);
  assert.equal(firstShipment.status, "PENDING");

  console.log("PASS: Real Kafka event creates a PENDING shipment");

  assert.equal(
    await Shipment.countDocuments({
      sourceEventId: first.eventId,
    }),
    1
  );

  console.log("PASS: Duplicate Kafka event creates only one shipment");

  assert.equal(
    await RejectedMessage.countDocuments({
      topic,
      errorCode: "INVALID_INPUT",
    }),
    2
  );

  console.log("PASS: Invalid JSON and missing order ID are stored as rejected messages");

  assert.equal(
    await RejectedMessage.countDocuments({
      topic,
      errorCode: "CONFLICT",
    }),
    1
  );

  console.log("PASS: Conflicting event is recorded without duplicating shipment");

  const secondShipment = await repository.findByOid(
    second.data.oid
  );

  assert.ok(secondShipment);
  assert.equal(secondShipment.status, "PENDING");

  console.log("PASS: Valid event after rejected messages is still processed");

  await waitUntil(
    async () => {
      const offsets = await admin.fetchOffsets({
        groupId,
        topics: [topic],
      });

      const partition = offsets
        .find((item) => item.topic === topic)
        ?.partitions.find((item) => item.partition === 0);

      return (
        partition &&
        BigInt(partition.offset) >= BigInt(expectedOffset)
      );
    },
    "Timed out waiting for committed consumer offset"
  );

  console.log("PASS: Consumer commits offsets after durable processing");

  console.log("Shipment consumer checks completed successfully");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    for (const [name, disconnect] of [
      ["consumer", () => orderConsumer?.stop()],
      ["producer", () => producer.disconnect()],
      ["admin", () => admin.disconnect()],
    ]) {
      try {
        await disconnect();
      } catch (err) {
        console.error(`${name} disconnect failed:`, err.message);
        process.exitCode = 1;
      }
    }

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