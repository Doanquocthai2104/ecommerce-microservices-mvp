const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestLifecycle = require(
  "../src/infrastructure/order-request-lifecycle"
);
const OrderInventoryCoordinator = require(
  "../src/application/order-inventory-coordinator"
);

const orders = new OrderRepository();
const requests = new OrderRequestLifecycle();
const createdIds = [];

// Trạng thái Inventory mô phỏng, tách biệt với PostgreSQL.
const inventoryStates = new Map();
const calls = [];
const loseReplyOnce = new Set();

async function fakeInventory(method, input) {
  calls.push({
    method,
    operationId: input.operationId,
  });

  const current = inventoryStates.get(input.operationId);

  if (method === "commit") {
    assert.ok(
      current === "RESERVED" || current === "COMMITTED",
      "Mock inventory cannot commit this operation"
    );

    inventoryStates.set(input.operationId, "COMMITTED");
  } else if (method === "release") {
    assert.notEqual(current, "COMMITTED");
    inventoryStates.set(input.operationId, "RELEASED");
  } else {
    throw new Error("Unexpected inventory method");
  }

  // Thao tác đã thực hiện nhưng phía gọi không nhận được phản hồi.
  if (loseReplyOnce.delete(input.operationId)) {
    throw new Error("Simulated lost RPC reply");
  }

  return {
    operationId: input.operationId,
    uid: input.uid,
    status: inventoryStates.get(input.operationId),
    items: [],
  };
}

const coordinator = new OrderInventoryCoordinator({
  requests,
  orders,
  callInventory: fakeInventory,
});

async function createRequest(storeOrder = false) {
  const requestId = randomUUID();
  createdIds.push(requestId);

  const input = {
    requestId,
    uid: 2147483000,
    items: [{ pid: 101, qty: 2 }],
  };

  await requests.ensureRequest(input);

  if (storeOrder) {
    inventoryStates.set(requestId, "RESERVED");

    await orders.createOrderForRequest({
      ...input,
      subtotal: "25.00",
      discount: "0.00",
      totalAmount: "25.00",
      items: [{ pid: 101, qty: 2, unit_price: "12.50" }],
    });
  }

  return requestId;
}

function countCalls(requestId, method) {
  return calls.filter(
    (call) =>
      call.operationId === requestId &&
      call.method === method
  ).length;
}

async function expectConflict(action) {
  await assert.rejects(
    action,
    (err) => err.code === "CONFLICT"
  );
}

async function main() {
  const normalId = await createRequest(true);

  const order = await coordinator.complete(normalId);
  const repeated = await coordinator.complete(normalId);
  const normalRequest = await requests.findByRequestId(normalId);

  assert.equal(normalRequest.status, "COMPLETED");
  assert.equal(repeated.oid, order.oid);
  assert.equal(countCalls(normalId, "commit"), 1);

  console.log("PASS: Completion commits inventory and supports repeated calls");

  const lostReplyId = await createRequest(true);
  loseReplyOnce.add(lostReplyId);

  await assert.rejects(
    () => coordinator.complete(lostReplyId),
    /Simulated lost RPC reply/
  );

  assert.equal(inventoryStates.get(lostReplyId), "COMMITTED");

  assert.equal(
    (await requests.findByRequestId(lostReplyId)).status,
    "ORDER_STORED"
  );

  await coordinator.complete(lostReplyId);

  assert.equal(
    (await requests.findByRequestId(lostReplyId)).status,
    "COMPLETED"
  );

  assert.equal(countCalls(lostReplyId, "release"), 0);

  console.log("PASS: Lost Commit reply is recovered without releasing stock");

  const databaseFailureId = await createRequest(true);

  const failingRequests = Object.create(requests);
  let failOnce = true;

  failingRequests.markCompleted = async (requestId) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("Simulated database update failure");
    }

    return requests.markCompleted(requestId);
  };

  const failingCoordinator = new OrderInventoryCoordinator({
    requests: failingRequests,
    orders,
    callInventory: fakeInventory,
  });

  await assert.rejects(
    () => failingCoordinator.complete(databaseFailureId),
    /Simulated database update failure/
  );

  assert.equal(
    inventoryStates.get(databaseFailureId),
    "COMMITTED"
  );

  assert.equal(
    (await requests.findByRequestId(databaseFailureId)).status,
    "ORDER_STORED"
  );

  await failingCoordinator.complete(databaseFailureId);

  assert.equal(
    (await requests.findByRequestId(databaseFailureId)).status,
    "COMPLETED"
  );

  assert.equal(countCalls(databaseFailureId, "release"), 0);

  console.log("PASS: Database failure after Commit can be retried safely");

  const cancellationId = await createRequest();
  inventoryStates.set(cancellationId, "RESERVED");
  loseReplyOnce.add(cancellationId);

  await assert.rejects(
    () => coordinator.cancel(cancellationId),
    /Simulated lost RPC reply/
  );

  assert.equal(
    inventoryStates.get(cancellationId),
    "RELEASED"
  );

  assert.equal(
    (await requests.findByRequestId(cancellationId)).status,
    "CANCEL_PENDING"
  );

  await coordinator.cancel(cancellationId);

  const releaseCount = countCalls(cancellationId, "release");
  await coordinator.cancel(cancellationId);

  assert.equal(
    (await requests.findByRequestId(cancellationId)).status,
    "CANCELLED"
  );

  assert.equal(
    countCalls(cancellationId, "release"),
    releaseCount
  );

  console.log("PASS: Lost Release reply is recovered and cancellation is repeatable");

  const storedId = await createRequest(true);

  await expectConflict(() => coordinator.cancel(storedId));

  assert.equal(countCalls(storedId, "release"), 0);

  console.log("PASS: Stored order cannot call Inventory Release");

  const pendingId = await createRequest();

  await expectConflict(() => coordinator.complete(pendingId));

  assert.equal(countCalls(pendingId, "commit"), 0);

  console.log("PASS: Pending request cannot call Inventory Commit");

  const invalidReceiptId = await createRequest(true);

  const invalidCoordinator = new OrderInventoryCoordinator({
    requests,
    orders,
    callInventory: async (method, input) => ({
      operationId: input.operationId,
      uid: input.uid,
      status: "RESERVED",
    }),
  });

  await assert.rejects(
    () => invalidCoordinator.complete(invalidReceiptId),
    /unexpected receipt/
  );

  assert.equal(
    (await requests.findByRequestId(invalidReceiptId)).status,
    "ORDER_STORED"
  );

  console.log("PASS: Unexpected receipt cannot mark the order COMPLETED");

  console.log("Order inventory coordinator checks completed successfully");
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