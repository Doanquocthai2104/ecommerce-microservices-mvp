const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestLifecycle = require(
  "../src/infrastructure/order-request-lifecycle"
);
const OrderInventoryCoordinator = require(
  "../src/application/order-inventory-coordinator"
);

const {
  grpc,
  callInventory,
  closeInventoryClient,
} = require("../src/infrastructure/inventory-client");

const projectRoot = path.resolve(__dirname, "../../..");

const orders = new OrderRepository();
const requests = new OrderRequestLifecycle();

const coordinator = new OrderInventoryCoordinator({
  requests,
  orders,
  callInventory,
});

const createdIds = [];
let productPid = null;

function mongo(script) {
  return execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "product-db",
      "mongosh",
      "--quiet",
      "--eval",
      script,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30000,
    }
  ).trim();
}

function createProductFixture() {
  const output = mongo(`
    const productDb = db.getSiblingDB("product_db");

    const counter = productDb.counters.findOneAndUpdate(
      {
        _id: "product",
        seq: { $lt: 2147483647 }
      },
      { $inc: { seq: 1 } },
      { returnDocument: "after" }
    );

    if (!counter) {
      throw new Error("Product counter is missing or exhausted");
    }

    productDb.products.insertOne({
      pid: counter.seq,
      pname: "Order inventory integration test",
      price: NumberDecimal("12.50"),
      quantity: 10
    });

    print(JSON.stringify({ pid: counter.seq }));
  `);

  return JSON.parse(output).pid;
}

function readStock() {
  const output = mongo(`
    const product = db.getSiblingDB("product_db")
      .products.findOne({ pid: ${productPid} });

    if (!product) {
      throw new Error("Test product is missing");
    }

    print(JSON.stringify({ quantity: product.quantity }));
  `);

  return JSON.parse(output).quantity;
}

async function createRequest(qty) {
  const requestId = randomUUID();
  createdIds.push(requestId);

  const input = {
    requestId,
    uid: 2147483000,
    items: [{ pid: productPid, qty }],
  };

  await requests.ensureRequest(input);
  return input;
}

function inventoryInput(input) {
  return {
    operationId: input.requestId,
    uid: input.uid,
    items: input.items,
  };
}

async function reserveAndStore(input) {
  const receipt = await callInventory(
    "reserve",
    inventoryInput(input)
  );

  assert.equal(receipt.status, "RESERVED");

  // Fixture có một sản phẩm giá 12.50, không áp dụng discount.
  const total = (input.items[0].qty * 12.5).toFixed(2);

  return orders.createOrderForRequest({
    uid: input.uid,
    requestId: input.requestId,
    subtotal: total,
    discount: "0.00",
    totalAmount: total,
    items: receipt.items,
  });
}

async function main() {
  productPid = createProductFixture();
  assert.equal(readStock(), 10);

  const first = await createRequest(2);
  const savedOrder = await reserveAndStore(first);

  assert.equal(readStock(), 8);

  const completedOrder = await coordinator.complete(first.requestId);

  assert.equal(completedOrder.oid, savedOrder.oid);
  assert.equal(
    (await requests.findByRequestId(first.requestId)).status,
    "COMPLETED"
  );
  assert.equal(readStock(), 8);

  console.log("PASS: Real reservation, order storage and Commit complete successfully");

  const repeated = await coordinator.complete(first.requestId);

  assert.equal(repeated.oid, savedOrder.oid);
  assert.equal(readStock(), 8);

  console.log("PASS: Repeated completion preserves order and stock");

  const cancelled = await createRequest(3);

  await callInventory("reserve", inventoryInput(cancelled));
  assert.equal(readStock(), 5);

  await coordinator.cancel(cancelled.requestId);

  assert.equal(readStock(), 8);
  assert.equal(
    (await requests.findByRequestId(cancelled.requestId)).status,
    "CANCELLED"
  );

  console.log("PASS: Cancellation releases real reserved stock");

  await coordinator.cancel(cancelled.requestId);
  assert.equal(readStock(), 8);

  console.log("PASS: Repeated cancellation does not restore stock twice");

  const earlyCancellation = await createRequest(1);

  await coordinator.cancel(earlyCancellation.requestId);
  assert.equal(readStock(), 8);

  await assert.rejects(
    () =>
      callInventory(
        "reserve",
        inventoryInput(earlyCancellation)
      ),
    (err) => err.code === grpc.status.ALREADY_EXISTS
  );

  assert.equal(readStock(), 8);

  console.log("PASS: Cancellation before reserve blocks late reservation");

  const lostReply = await createRequest(1);
  await reserveAndStore(lostReply);
  assert.equal(readStock(), 7);

  let loseOnce = true;

  const unreliableCoordinator = new OrderInventoryCoordinator({
    requests,
    orders,

    callInventory: async (method, input) => {
      // RPC thật đã thành công tại Product Service.
      const receipt = await callInventory(method, input);

      // Mô phỏng Order không nhận được phản hồi thành công.
      if (method === "commit" && loseOnce) {
        loseOnce = false;
        throw new Error("Simulated lost successful Commit reply");
      }

      return receipt;
    },
  });

  await assert.rejects(
    () => unreliableCoordinator.complete(lostReply.requestId),
    /Simulated lost successful Commit reply/
  );

  assert.equal(
    (await requests.findByRequestId(lostReply.requestId)).status,
    "ORDER_STORED"
  );

  await unreliableCoordinator.complete(lostReply.requestId);

  assert.equal(
    (await requests.findByRequestId(lostReply.requestId)).status,
    "COMPLETED"
  );
  assert.equal(readStock(), 7);

  console.log("PASS: Retry after lost real Commit reply preserves stock");

  await assert.rejects(
    () => coordinator.cancel(first.requestId),
    (err) => err.code === "CONFLICT"
  );

  assert.equal(readStock(), 7);

  console.log("PASS: Completed order cannot release its inventory");

  console.log("Order inventory integration checks completed successfully");
}

async function cleanupOrderData() {
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

function cleanupProductData() {
  if (productPid === null) return;

  // Chỉ xóa fixture và operation do lần chạy này tạo.
  mongo(`
    const productDb = db.getSiblingDB("product_db");

    productDb.stock_operations.deleteMany({
      _id: { $in: ${JSON.stringify(createdIds)} }
    });

    productDb.products.deleteOne({
      pid: ${productPid}
    });
  `);
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    closeInventoryClient();

    try {
      await cleanupOrderData();
    } catch (err) {
      console.error("Order cleanup failed:", err.message);
      process.exitCode = 1;
    }

    try {
      cleanupProductData();
    } catch (err) {
      console.error("Product cleanup failed:", err.message);
      process.exitCode = 1;
    }

    await pool.end();
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});