const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestProgress = require(
  "../src/infrastructure/order-request-progress"
);
const OrderInventoryCoordinator = require(
  "../src/application/order-inventory-coordinator"
);
const OrderPricing = require("../src/domain/order-pricing");
const CreateOrder = require("../src/application/create-order");

const requests = new OrderRequestProgress();
const orders = new OrderRepository();
const createdIds = [];

const actor = {
  uid: 2147483000,
  role: "CUSTOMER",
};

// Cấu hình riêng cho bài kiểm tra.
const pricing = new OrderPricing([
  { minScore: 0, percent: 0 },
  { minScore: 100, percent: 5 },
  { minScore: 1000, percent: 15 },
]);

let currentScore = 100;
let membershipCalls = 0;
let stock = 100;

const operations = new Map();
const loseCommitReply = new Set();

async function getMembership(uid) {
  membershipCalls += 1;

  return {
    uid,
    score: currentScore,
  };
}

async function callInventory(method, input) {
  let receipt = operations.get(input.operationId);

  if (method === "reserve") {
    if (receipt) {
      assert.notEqual(receipt.status, "RELEASED");
      return receipt;
    }

    const qty = input.items[0].qty;

    if (qty > stock) {
      const err = new Error("Insufficient stock");
      err.code = 9;
      throw err;
    }

    stock -= qty;

    receipt = {
      operationId: input.operationId,
      uid: input.uid,
      status: "RESERVED",
      items: input.items.map((item) => ({
        ...item,
        unit_price: "12.50",
      })),
    };

    operations.set(input.operationId, receipt);
    return receipt;
  }

  if (method === "commit") {
    assert.ok(receipt);
    assert.notEqual(receipt.status, "RELEASED");

    receipt.status = "COMMITTED";

    if (loseCommitReply.delete(input.operationId)) {
      throw new Error("Simulated lost Commit reply");
    }

    return receipt;
  }

  if (method === "release") {
    if (!receipt) {
      receipt = {
        operationId: input.operationId,
        uid: input.uid,
        status: "RELEASED",
        items: [],
      };

      operations.set(input.operationId, receipt);
    } else if (receipt.status === "RESERVED") {
      stock += receipt.items.reduce(
        (sum, item) => sum + item.qty,
        0
      );

      receipt.status = "RELEASED";
    } else {
      assert.equal(receipt.status, "RELEASED");
    }

    return receipt;
  }

  throw new Error("Unexpected inventory method");
}

const coordinator = new OrderInventoryCoordinator({
  requests,
  orders,
  callInventory,
});

function makeUseCase(orderRepository = orders) {
  return new CreateOrder({
    requests,
    orders: orderRepository,
    pricing,
    getMembership,
    callInventory,
    coordinator,
  });
}

const createOrder = makeUseCase();

function input(qty = 2) {
  const requestId = randomUUID();
  createdIds.push(requestId);

  return {
    actor,
    authorization: "Bearer mock-token",
    requestId,
    items: [{ pid: 101, qty }],
  };
}

async function main() {
  const first = input();
  const firstOrder = await createOrder.execute(first);
  const firstRequest = await requests.findByRequestId(first.requestId);

  assert.equal(firstOrder.uid, actor.uid);
  assert.equal(firstOrder.subtotal, "25.00");
  assert.equal(firstOrder.discount, "1.25");
  assert.equal(firstOrder.total_amount, "23.75");
  assert.equal(firstRequest.score, 100);
  assert.equal(firstRequest.status, "COMPLETED");
  assert.equal(firstRequest.pricing.discountPercent, 5);
  assert.equal(stock, 98);

  console.log("PASS: Order uses membership score and inventory price snapshots");

  const callsBeforeReplay = membershipCalls;
  currentScore = 1000;

  const repeated = await createOrder.execute(first);

  assert.equal(repeated.oid, firstOrder.oid);
  assert.equal(repeated.total_amount, "23.75");
  assert.equal(membershipCalls, callsBeforeReplay);
  assert.equal(stock, 98);

  console.log("PASS: Completed replay preserves original score, price and stock");

  const concurrent = input(1);
  const stockBeforeConcurrent = stock;

  const concurrentOrders = await Promise.all(
    Array.from({ length: 5 }, () =>
      createOrder.execute(concurrent)
    )
  );

  assert.equal(
    new Set(concurrentOrders.map((order) => order.oid)).size,
    1
  );

  assert.equal(stock, stockBeforeConcurrent - 1);

  console.log("PASS: Concurrent identical requests create one order and reserve once");

  const lostReply = input(1);
  loseCommitReply.add(lostReply.requestId);
  const stockBeforeLostReply = stock;

  await assert.rejects(
    () => createOrder.execute(lostReply),
    /Simulated lost Commit reply/
  );

  assert.equal(
    (await requests.findByRequestId(lostReply.requestId)).status,
    "ORDER_STORED"
  );

  await createOrder.execute(lostReply);

  assert.equal(
    (await requests.findByRequestId(lostReply.requestId)).status,
    "COMPLETED"
  );
  assert.equal(stock, stockBeforeLostReply - 1);

  console.log("PASS: Retry recovers a lost Commit reply without another deduction");

  const insufficient = input(1000);
  const stockBeforeFailure = stock;

  await assert.rejects(
    () => createOrder.execute(insufficient),
    (err) => err.code === 9
  );

  assert.equal(
    (await requests.findByRequestId(insufficient.requestId)).status,
    "CANCELLED"
  );
  assert.equal(stock, stockBeforeFailure);

  console.log("PASS: Insufficient stock cancels the request without creating an order");

  const uncertainStorage = input(1);
  let failOnce = true;

  const unreliableOrders = {
    async createOrderForRequest(data) {
      const order = await orders.createOrderForRequest(data);

      if (failOnce) {
        failOnce = false;
        throw new Error("Simulated lost database success response");
      }

      return order;
    },
  };

  const unreliableUseCase = makeUseCase(unreliableOrders);
  const stockBeforeStorage = stock;

  await assert.rejects(
    () => unreliableUseCase.execute(uncertainStorage),
    /Simulated lost database success response/
  );

  assert.equal(
    (await requests.findByRequestId(uncertainStorage.requestId)).status,
    "ORDER_STORED"
  );

  await unreliableUseCase.execute(uncertainStorage);

  assert.equal(
    (await requests.findByRequestId(uncertainStorage.requestId)).status,
    "COMPLETED"
  );
  assert.equal(stock, stockBeforeStorage - 1);

  console.log("PASS: Uncertain database response is recovered without releasing stock");

  const clientPrice = input();
  clientPrice.items[0].unit_price = "0.01";
  const stockBeforeClientPrice = stock;

  await assert.rejects(
    () => createOrder.execute(clientPrice),
    (err) => err.code === "INVALID_INPUT"
  );

  assert.equal(stock, stockBeforeClientPrice);

  console.log("PASS: Client-supplied price is rejected before reservation");

  await assert.rejects(
    () =>
      createOrder.execute({
        ...input(),
        actor: { uid: actor.uid, role: "ADMIN" },
      }),
    (err) => err.code === "FORBIDDEN"
  );

  await assert.rejects(
    () => createOrder.execute({ ...input(), actor: null }),
    (err) => err.code === "INVALID_CREDENTIALS"
  );

  console.log("PASS: Non-customer and unauthenticated actors cannot place orders");

  console.log("Create order checks completed successfully");
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