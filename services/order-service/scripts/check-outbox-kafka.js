const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");

const {
  kafka,
  producer,
} = require("../src/infrastructure/kafka-client");

const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestProgress = require(
  "../src/infrastructure/order-request-progress"
);
const OutboxPublisher = require(
  "../src/infrastructure/outbox-publisher"
);

const topic = "prompt3-outbox-integration-test";
const requestId = randomUUID();

const orders = new OrderRepository();
const requests = new OrderRequestProgress();

const admin = kafka.admin();

const consumer = kafka.consumer({
  groupId: `prompt3-outbox-check-${randomUUID()}`,
  allowAutoTopicCreation: false,
});

let receiveTimer = null;
let eventId = null;

async function createFixture() {
  await requests.ensureRequest({
    requestId,
    uid: 2147483000,
    items: [{ pid: 101, qty: 1 }],
  });

  const order = await orders.createOrderForRequest({
    requestId,
    uid: 2147483000,
    subtotal: "12.50",
    discount: "0.00",
    totalAmount: "12.50",
    items: [
      { pid: 101, qty: 1, unit_price: "12.50" },
    ],
  });

  // Chỉ đổi topic của sự kiện thuộc fixture này.
  const result = await pool.query(
    `
    UPDATE public."OutboxEvent"
    SET topic = $2
    WHERE oid = $1
    RETURNING *
    `,
    [order.oid, topic]
  );

  assert.equal(result.rowCount, 1);

  eventId = result.rows[0].event_id;

  return {
    order,
    event: result.rows[0],
  };
}

async function readEvent() {
  const result = await pool.query(
    `
    SELECT *
    FROM public."OutboxEvent"
    WHERE event_id = $1
    `,
    [eventId]
  );

  return result.rows[0];
}

async function main() {
  await admin.connect();

  const topics = await admin.listTopics();

  if (!topics.includes(topic)) {
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
  }

  await producer.connect();

  const { order, event } = await createFixture();

  const publisher = new OutboxPublisher({
    pool,
    producer,
  });

  const beforeCompletion = await publisher.runOnce([eventId]);

  assert.equal(beforeCompletion.published, 0);
  assert.equal((await readEvent()).published_at, null);

  console.log("PASS: Real publisher skips an order that is not COMPLETED");

  await consumer.connect();

  await consumer.subscribe({
    topic,
    fromBeginning: true,
  });

  let resolveReceived;

  const received = new Promise((resolve) => {
    resolveReceived = resolve;
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const receivedId =
        message.headers?.["event-id"]?.toString();

      if (receivedId !== eventId) {
        return;
      }

      resolveReceived({
        key: message.key?.toString(),
        value: message.value?.toString(),
        eventId: receivedId,
        eventType:
          message.headers?.["event-type"]?.toString(),
      });
    },
  });

  // Chỉ kiểm tra trạng thái DB ở đây.
  // Inventory thật đã được kiểm tra ở các bước trước.
  await requests.markCompleted(requestId);

  const timeout = new Promise((resolve, reject) => {
    receiveTimer = setTimeout(() => {
      reject(new Error("Timed out waiting for Outbox event"));
    }, 30000);
  });

  const [summary, message] = await Promise.all([
    publisher.runOnce([eventId]),
    Promise.race([received, timeout]),
  ]);

  clearTimeout(receiveTimer);
  receiveTimer = null;

  assert.equal(summary.published, 1);
  assert.equal(summary.failed, 0);

  console.log("PASS: Outbox publisher sends the event to real Kafka");

  const payload = JSON.parse(message.value);

  assert.equal(message.key, String(order.oid));
  assert.equal(message.eventId, eventId);
  assert.equal(message.eventType, "OrderCreated");
  assert.deepEqual(payload, event.payload);

  console.log("PASS: Consumer receives the original event ID, key and payload");

  const published = await readEvent();

  assert.ok(published.published_at);
  assert.equal(published.attempts, 1);
  assert.equal(published.last_error, null);

  console.log("PASS: PostgreSQL records publication after Kafka acknowledgment");

  const repeated = await publisher.runOnce([eventId]);
  const afterReplay = await readEvent();

  assert.equal(repeated.published, 0);
  assert.equal(repeated.failed, 0);
  assert.equal(afterReplay.attempts, 1);

  assert.equal(
    afterReplay.published_at.toISOString(),
    published.published_at.toISOString()
  );

  console.log("PASS: Repeated publisher run leaves the published event unchanged");

  console.log("Outbox Kafka checks completed successfully");
}

async function cleanupDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM public."OrderRequest"
      WHERE request_id = $1
      `,
      [requestId]
    );

    await client.query(
      `
      DELETE FROM public."OutboxEvent"
      WHERE oid IN (
        SELECT oid
        FROM public."Order"
        WHERE request_id = $1
      )
      `,
      [requestId]
    );

    await client.query(
      `
      DELETE FROM public."Order"
      WHERE request_id = $1
      `,
      [requestId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    if (receiveTimer) {
      clearTimeout(receiveTimer);
    }

    for (const [name, disconnect] of [
      ["consumer", () => consumer.disconnect()],
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
      await cleanupDatabase();
    } catch (err) {
      console.error("Database cleanup failed:", err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});