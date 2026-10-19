const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestProgress = require(
  "../src/infrastructure/order-request-progress"
);
const OutboxPublisher = require(
  "../src/infrastructure/outbox-publisher"
);

const orders = new OrderRepository();
const requests = new OrderRequestProgress();

const requestIds = [];
const eventIds = [];
const sent = [];

let failNextSend = false;

const producer = {
  async send(message) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("Simulated Kafka unavailable");
    }

    // Tạo một khoảng chờ ngắn để kiểm tra tranh chấp khóa.
    await new Promise((resolve) => setTimeout(resolve, 25));

    sent.push(message);
    return [{ topicName: message.topic, partition: 0 }];
  },
};

function newPublisher(databasePool = pool) {
  return new OutboxPublisher({
    pool: databasePool,
    producer,
    batchSize: 10,
  });
}

async function createFixture(completed = false) {
  const requestId = randomUUID();
  requestIds.push(requestId);

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

  if (completed) {
    await requests.markCompleted(requestId);
  }

  const result = await pool.query(
    `
    SELECT *
    FROM public."OutboxEvent"
    WHERE oid = $1
    `,
    [order.oid]
  );

  const event = result.rows[0];
  eventIds.push(event.event_id);

  return { requestId, order, event };
}

async function readEvent(eventId) {
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
  const publisher = newPublisher();

  const pending = await createFixture(false);

  const skipped = await publisher.runOnce([
    pending.event.event_id,
  ]);

  assert.equal(skipped.published, 0);
  assert.equal(sent.length, 0);
  assert.equal(
    (await readEvent(pending.event.event_id)).published_at,
    null
  );

  console.log("PASS: ORDER_STORED event is not published before completion");

  await requests.markCompleted(pending.requestId);

  const published = await publisher.runOnce([
    pending.event.event_id,
  ]);

  assert.equal(published.published, 1);

  const saved = await readEvent(pending.event.event_id);
  assert.ok(saved.published_at);
  assert.equal(saved.attempts, 1);
  assert.equal(saved.last_error, null);

  const message = sent[0];

  assert.equal(message.topic, "order-created");
  assert.equal(message.acks, -1);
  assert.equal(message.messages[0].key, String(pending.order.oid));
  assert.equal(
    message.messages[0].headers["event-id"],
    pending.event.event_id
  );
  assert.equal(
    JSON.parse(message.messages[0].value).eventId,
    pending.event.event_id
  );

  console.log("PASS: Completed event is sent and marked published after acknowledgment");

  const sentBeforeReplay = sent.length;

  const replay = await publisher.runOnce([
    pending.event.event_id,
  ]);

  assert.equal(replay.published, 0);
  assert.equal(sent.length, sentBeforeReplay);

  console.log("PASS: Published event is not sent again");

  const failed = await createFixture(true);
  failNextSend = true;

  const failureResult = await publisher.runOnce([
    failed.event.event_id,
  ]);

  assert.equal(failureResult.failed, 1);

  const failedEvent = await readEvent(failed.event.event_id);

  assert.equal(failedEvent.published_at, null);
  assert.equal(failedEvent.attempts, 1);
  assert.match(
    failedEvent.last_error,
    /Simulated Kafka unavailable/
  );

  console.log("PASS: Kafka failure preserves unpublished event and records the error");

  const retried = await publisher.runOnce([
    failed.event.event_id,
  ]);

  assert.equal(retried.published, 1);

  const retriedEvent = await readEvent(failed.event.event_id);

  assert.ok(retriedEvent.published_at);
  assert.equal(retriedEvent.attempts, 2);
  assert.equal(retriedEvent.last_error, null);

  assert.equal(
    JSON.parse(sent[sent.length - 1].messages[0].value).eventId,
    failed.event.event_id
  );

  console.log("PASS: Retry publishes the same event ID");

  const concurrent = await createFixture(true);
  const sentBeforeConcurrent = sent.length;

  const concurrentResults = await Promise.allSettled([
    newPublisher().runOnce([concurrent.event.event_id]),
    newPublisher().runOnce([concurrent.event.event_id]),
  ]);

  for (const result of concurrentResults) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  assert.equal(sent.length, sentBeforeConcurrent + 1);

  console.log("PASS: Concurrent publishers do not send the locked event twice");

  const uncertain = await createFixture(true);
  let injectDatabaseFailure = true;

  const unreliablePool = {
    async connect() {
      const client = await pool.connect();

      return {
        async query(statement, parameters) {
          if (
            injectDatabaseFailure &&
            typeof statement === "string" &&
            statement.includes("published_at = NOW()")
          ) {
            injectDatabaseFailure = false;

            throw new Error(
              "Simulated database failure after Kafka acknowledgment"
            );
          }

          return client.query(statement, parameters);
        },

        release() {
          client.release();
        },
      };
    },
  };

  const sentBeforeUncertain = sent.length;

  await assert.rejects(
    () =>
      newPublisher(unreliablePool).runOnce([
        uncertain.event.event_id,
      ]),
    /Simulated database failure/
  );

  assert.equal(
    (await readEvent(uncertain.event.event_id)).published_at,
    null
  );

  await publisher.runOnce([uncertain.event.event_id]);

  assert.equal(sent.length, sentBeforeUncertain + 2);

  const resentMessages = sent.slice(sentBeforeUncertain);

  assert.ok(
    resentMessages.every(
      (item) =>
        JSON.parse(item.messages[0].value).eventId ===
        uncertain.event.event_id
    )
  );

  assert.ok(
    (await readEvent(uncertain.event.event_id)).published_at
  );

  console.log("PASS: Database failure after send allows replay with unchanged event ID");

  console.log("Outbox publisher checks completed successfully");
}

async function cleanup() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM public."OrderRequest"
      WHERE request_id = ANY($1::uuid[])
      `,
      [requestIds]
    );

    await client.query(
      `
      DELETE FROM public."OutboxEvent"
      WHERE event_id = ANY($1::uuid[])
      `,
      [eventIds]
    );

    await client.query(
      `
      DELETE FROM public."Order"
      WHERE request_id = ANY($1::uuid[])
      `,
      [requestIds]
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
    try {
      await cleanup();
    } catch (err) {
      console.error("Cleanup failed:", err.message);
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