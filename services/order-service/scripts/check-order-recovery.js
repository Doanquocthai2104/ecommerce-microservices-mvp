const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestProgress = require(
  "../src/infrastructure/order-request-progress"
);
const OrderRecovery = require("../src/application/order-recovery");

const requests = new OrderRequestProgress();
const orders = new OrderRepository();
const createdIds = [];

async function createRequest(storeOrder = false) {
  const requestId = randomUUID();
  createdIds.push(requestId);

  await requests.ensureRequest({
    requestId,
    uid: 2147483000,
    items: [{ pid: 101, qty: 1 }],
  });

  if (storeOrder) {
    await orders.createOrderForRequest({
      requestId,
      uid: 2147483000,
      subtotal: "12.50",
      discount: "0.00",
      totalAmount: "12.50",
      items: [
        { pid: 101, qty: 1, unit_price: "12.50" },
      ],
    });
  }

  return requestId;
}

async function makeOld(requestId) {
  await pool.query(
    `
    UPDATE public."OrderRequest"
    SET updated_at = NOW() - INTERVAL '10 minutes'
    WHERE request_id = $1
    `,
    [requestId]
  );
}

async function statusOf(requestId) {
  const request = await requests.findByRequestId(requestId);
  return request.status;
}

async function main() {
  const oldPending = await createRequest();
  const freshPending = await createRequest();
  const stored = await createRequest(true);
  const cancelling = await createRequest();
  const failedStored = await createRequest(true);

  await requests.beginCancellation(cancelling);

  for (const id of [
    oldPending,
    stored,
    cancelling,
    failedStored,
  ]) {
    await makeOld(id);
  }

  let simulateFailure = true;

  // Mô phỏng kết quả Inventory để kiểm tra worker và DB.
  // Coordinator với Inventory thật đã được kiểm tra ở bước 8.19.
  const coordinator = {
    async complete(requestId) {
      if (requestId === failedStored && simulateFailure) {
        throw new Error("Simulated Inventory unavailable");
      }

      return requests.markCompleted(requestId);
    },

    async cancel(requestId) {
      await requests.beginCancellation(requestId);
      return requests.markCancelled(requestId);
    },
  };

  const recovery = new OrderRecovery({
    pool,
    coordinator,
    pendingTimeoutMs: 300000,
    retryDelayMs: 10000,
  });

  // Giới hạn bài kiểm tra vào fixture của lần chạy này.
  const first = await recovery.runOnce(createdIds);

  assert.equal(await statusOf(oldPending), "CANCELLED");
  console.log("PASS: Stale PENDING request is cancelled");

  assert.equal(await statusOf(freshPending), "PENDING");
  console.log("PASS: Fresh PENDING request is preserved");

  assert.equal(await statusOf(stored), "COMPLETED");
  console.log("PASS: Stored order is completed during recovery");

  assert.equal(await statusOf(cancelling), "CANCELLED");
  console.log("PASS: Pending cancellation is completed during recovery");

  assert.equal(await statusOf(failedStored), "ORDER_STORED");
  assert.equal(first.recovered, 3);
  assert.equal(first.failed, 1);

  console.log("PASS: Inventory failure preserves stored order for retry");

  simulateFailure = false;
  await makeOld(failedStored);

  const second = await recovery.runOnce(createdIds);

  assert.equal(second.recovered, 1);
  assert.equal(second.failed, 0);
  assert.equal(await statusOf(failedStored), "COMPLETED");

  console.log("PASS: Later recovery completes a previously failed request");

  const third = await recovery.runOnce(createdIds);

  assert.equal(third.recovered, 0);
  assert.equal(third.failed, 0);
  assert.equal(await statusOf(freshPending), "PENDING");

  console.log("PASS: Repeated recovery leaves finished requests unchanged");

  console.log("Order recovery checks completed successfully");
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
      [createdIds]
    );

    await client.query(
      `
      DELETE FROM public."OutboxEvent"
      WHERE oid IN (
        SELECT oid
        FROM public."Order"
        WHERE request_id = ANY($1::uuid[])
      )
      `,
      [createdIds]
    );

    await client.query(
      `
      DELETE FROM public."Order"
      WHERE request_id = ANY($1::uuid[])
      `,
      [createdIds]
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