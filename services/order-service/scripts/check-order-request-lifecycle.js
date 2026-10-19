const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestLifecycle = require(
  "../src/infrastructure/order-request-lifecycle"
);

const lifecycle = new OrderRequestLifecycle();
const orders = new OrderRepository();
const createdIds = [];

async function createRequest() {
  const requestId = randomUUID();
  createdIds.push(requestId);

  const input = {
    requestId,
    uid: 2147483000,
    items: [{ pid: 101, qty: 2 }],
  };

  await lifecycle.ensureRequest(input);

  return {
    ...input,
    subtotal: "25.00",
    discount: "0.00",
    totalAmount: "25.00",
    items: [{ pid: 101, qty: 2, unit_price: "12.50" }],
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

async function main() {
  const pending = await createRequest();

  await expectError(
    () => lifecycle.markCompleted(pending.requestId),
    "CONFLICT"
  );

  console.log("PASS: PENDING request cannot become COMPLETED");

  await expectError(
    () => lifecycle.markCancelled(pending.requestId),
    "CONFLICT"
  );

  console.log("PASS: Cancellation must begin before marking CANCELLED");

  const cancellationResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      lifecycle.beginCancellation(pending.requestId)
    )
  );

  assert.ok(
    cancellationResults.every(
      (result) => result.status === "CANCEL_PENDING"
    )
  );

  console.log("PASS: Concurrent cancellation requests remain CANCEL_PENDING");

  await expectError(
    () => orders.createOrderForRequest(pending),
    "CONFLICT"
  );

  console.log("PASS: CANCEL_PENDING request cannot create an order");

  const cancelled = await lifecycle.markCancelled(pending.requestId);
  const cancelledAgain = await lifecycle.markCancelled(pending.requestId);
  const cancellationReplay = await lifecycle.beginCancellation(
    pending.requestId
  );

  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelledAgain.status, "CANCELLED");
  assert.equal(cancellationReplay.status, "CANCELLED");

  await expectError(
    () => lifecycle.markCompleted(pending.requestId),
    "CONFLICT"
  );

  console.log("PASS: Cancelled request stays CANCELLED on retries");

  const storedInput = await createRequest();
  const order = await orders.createOrderForRequest(storedInput);

  await expectError(
    () => lifecycle.beginCancellation(storedInput.requestId),
    "CONFLICT"
  );

  console.log("PASS: Stored order cannot begin inventory cancellation");

  // Bài kiểm tra này chỉ kiểm tra chuyển trạng thái DB.
  // Chưa gọi Inventory Commit thật.
  const completionResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      lifecycle.markCompleted(storedInput.requestId)
    )
  );

  assert.ok(
    completionResults.every(
      (result) =>
        result.status === "COMPLETED" &&
        result.oid === order.oid
    )
  );

  await expectError(
    () => lifecycle.beginCancellation(storedInput.requestId),
    "CONFLICT"
  );

  console.log("PASS: Completion is repeatable and preserves the stored order");

  await expectError(
    () => lifecycle.markCompleted(randomUUID()),
    "NOT_FOUND"
  );

  console.log("PASS: Missing request returns NOT_FOUND");

  console.log("Order request lifecycle checks completed successfully");
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