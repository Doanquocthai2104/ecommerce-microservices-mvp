const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const pool = require("../src/infrastructure/database");
const {
  grpc,
  OrderService,
} = require("../src/infrastructure/order-proto");

const OrderPricing = require("../src/domain/order-pricing");

const projectRoot = path.resolve(__dirname, "../../..");
const gatewayUrl =
  process.env.GATEWAY_URL || "http://127.0.0.1:3000";

const client = new OrderService(
  process.env.ORDER_GRPC_URL || "127.0.0.1:50054",
  grpc.credentials.createInsecure()
);

const pricing = new OrderPricing(
  JSON.parse(process.env.DISCOUNT_TIERS)
);

const requestIds = [];
let productPid = null;

function newRequestId() {
  const id = randomUUID();
  requestIds.push(id);
  return id;
}

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
      pname: "Order gRPC integration test",
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

async function post(endpoint, body, expectedStatus) {
  const response = await fetch(`${gatewayUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const result = await response.json();

  assert.equal(
    response.status,
    expectedStatus,
    `Unexpected HTTP status ${response.status}: ${
      result.error || "Request failed"
    }`
  );

  return result;
}

async function createCustomer() {
  const username = `ord_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();

  const registered = await post(
    "/api/auth/register",
    { username, password },
    201
  );

  // Gateway tạo Customer profile khi đăng nhập.
  const login = await post(
    "/api/auth/login",
    { username, password },
    200
  );

  assert.ok(Number.isInteger(registered.uid));
  assert.equal(typeof login.accessToken, "string");

  return {
    uid: registered.uid,
    authorization: `Bearer ${login.accessToken}`,
  };
}

function callOrder(method, request, authorization) {
  const metadata = new grpc.Metadata();

  if (authorization) {
    metadata.set("authorization", authorization);
  }

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 30000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

async function expectGrpcError(action, expectedCode) {
  await assert.rejects(action, (err) => {
    assert.equal(
      err.code,
      expectedCode,
      `Expected gRPC code ${expectedCode}, received ${err.code}: ${err.details}`
    );

    return true;
  });
}

async function main() {
  productPid = createProductFixture();

  const customer = await createCustomer();
  const otherCustomer = await createCustomer();

  const request = {
    requestId: newRequestId(),
    items: [{ pid: productPid, qty: 2 }],
  };

  await expectGrpcError(
    () => callOrder("createOrder", request),
    grpc.status.UNAUTHENTICATED
  );

  assert.equal(readStock(), 10);

  console.log("PASS: Missing JWT rejected without changing stock");

  await expectGrpcError(
    () =>
      callOrder(
        "createOrder",
        request,
        "Bearer invalid-token"
      ),
    grpc.status.UNAUTHENTICATED
  );

  assert.equal(readStock(), 10);

  console.log("PASS: Invalid JWT rejected without changing stock");

  const order = await callOrder(
    "createOrder",
    request,
    customer.authorization
  );

  // Customer mới có BASIC, score = 0.
  const expected = pricing.calculate(
    [{ pid: productPid, qty: 2, unit_price: "12.50" }],
    0
  );

  assert.ok(order.oid > 0);
  assert.equal(order.uid, customer.uid);
  assert.equal(order.subtotal, expected.subtotal);
  assert.equal(order.discount, expected.discount);
  assert.equal(order.totalAmount, expected.totalAmount);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].pid, productPid);
  assert.equal(order.items[0].qty, 2);
  assert.equal(Number(order.items[0].unitPrice), 12.5);
  assert.equal(readStock(), 8);

  console.log("PASS: Authenticated customer creates order with server-calculated amounts");

  const stored = await pool.query(
    `
    SELECT status, oid, score
    FROM public."OrderRequest"
    WHERE request_id = $1
    `,
    [request.requestId]
  );

  assert.equal(stored.rows[0].status, "COMPLETED");
  assert.equal(stored.rows[0].oid, order.oid);
  assert.equal(stored.rows[0].score, 0);

  const outbox = await pool.query(
    `
    SELECT payload
    FROM public."OutboxEvent"
    WHERE oid = $1
    `,
    [order.oid]
  );

  assert.equal(outbox.rowCount, 1);
  assert.equal(outbox.rows[0].payload.data.oid, order.oid);

  console.log("PASS: Request completes and one OrderCreated event is stored");

  const repeated = await callOrder(
    "createOrder",
    request,
    customer.authorization
  );

  assert.equal(repeated.oid, order.oid);
  assert.equal(readStock(), 8);

  console.log("PASS: Repeated request returns the same order without another deduction");

  await expectGrpcError(
    () =>
      callOrder(
        "createOrder",
        {
          ...request,
          items: [{ pid: productPid, qty: 3 }],
        },
        customer.authorization
      ),
    grpc.status.ALREADY_EXISTS
  );

  assert.equal(readStock(), 8);

  console.log("PASS: Same request ID with different quantities rejected");

  const detail = await callOrder(
    "getOrder",
    { oid: order.oid },
    customer.authorization
  );

  assert.equal(detail.oid, order.oid);
  assert.equal(detail.uid, customer.uid);
  assert.equal(detail.items.length, 1);

  const list = await callOrder(
    "listOrders",
    {},
    customer.authorization
  );

  assert.ok(
    (list.items || []).some((item) => item.oid === order.oid)
  );

  assert.ok(
    (list.items || []).every((item) => item.uid === customer.uid)
  );

  console.log("PASS: Customer reads own order details and order list");

  await expectGrpcError(
    () =>
      callOrder(
        "getOrder",
        { oid: order.oid },
        otherCustomer.authorization
      ),
    grpc.status.PERMISSION_DENIED
  );

  const otherList = await callOrder(
    "listOrders",
    {},
    otherCustomer.authorization
  );

  assert.ok(
    !(otherList.items || []).some((item) => item.oid === order.oid)
  );

  await expectGrpcError(
    () =>
      callOrder(
        "createOrder",
        request,
        otherCustomer.authorization
      ),
    grpc.status.ALREADY_EXISTS
  );

  console.log("PASS: Another customer cannot read or reuse the order request");

  await expectGrpcError(
    () =>
      callOrder(
        "createOrder",
        {
          requestId: "invalid-id",
          items: [{ pid: productPid, qty: 1 }],
        },
        customer.authorization
      ),
    grpc.status.INVALID_ARGUMENT
  );

  await expectGrpcError(
    () =>
      callOrder(
        "createOrder",
        {
          requestId: newRequestId(),
          items: [{ pid: productPid, qty: 0 }],
        },
        customer.authorization
      ),
    grpc.status.INVALID_ARGUMENT
  );

  await expectGrpcError(
    () =>
      callOrder(
        "getOrder",
        { oid: 0 },
        customer.authorization
      ),
    grpc.status.INVALID_ARGUMENT
  );

  console.log("PASS: Invalid request ID, quantity and order ID rejected");

  const insufficientId = newRequestId();

  await expectGrpcError(
    () =>
      callOrder(
        "createOrder",
        {
          requestId: insufficientId,
          items: [{ pid: productPid, qty: 1000 }],
        },
        customer.authorization
      ),
    grpc.status.FAILED_PRECONDITION
  );

  const insufficientState = await pool.query(
    `
    SELECT status
    FROM public."OrderRequest"
    WHERE request_id = $1
    `,
    [insufficientId]
  );

  assert.equal(insufficientState.rows[0].status, "CANCELLED");
  assert.equal(readStock(), 8);

  console.log("PASS: Insufficient stock cancels request without deducting inventory");

  const concurrentRequest = {
    requestId: newRequestId(),
    items: [{ pid: productPid, qty: 1 }],
  };

  // Đợi tất cả RPC kết thúc trước khi kiểm tra hoặc dọn dữ liệu.
  const concurrentResults = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      callOrder(
        "createOrder",
        concurrentRequest,
        customer.authorization
      )
    )
  );

  for (const result of concurrentResults) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  const concurrentOrders = concurrentResults.map(
    (result) => result.value
  );

  assert.equal(
    new Set(concurrentOrders.map((item) => item.oid)).size,
    1
  );

  assert.equal(readStock(), 7);

  console.log("PASS: Concurrent gRPC requests create one order and deduct stock once");

  console.log("Order gRPC checks completed successfully");
}

async function cleanupOrderData() {
  const connection = await pool.connect();

  try {
    await connection.query("BEGIN");

    await connection.query(
      `
      DELETE FROM public."OrderRequest"
      WHERE request_id = ANY($1::uuid[])
      `,
      [requestIds]
    );

    await connection.query(
      `
      DELETE FROM public."OutboxEvent"
      WHERE oid IN (
        SELECT oid
        FROM public."Order"
        WHERE request_id = ANY($1::uuid[])
      )
      `,
      [requestIds]
    );

    await connection.query(
      `
      DELETE FROM public."Order"
      WHERE request_id = ANY($1::uuid[])
      `,
      [requestIds]
    );

    await connection.query("COMMIT");
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
  }
}

function cleanupProductData() {
  if (productPid === null) return;

  mongo(`
    const productDb = db.getSiblingDB("product_db");

    productDb.stock_operations.deleteMany({
      _id: { $in: ${JSON.stringify(requestIds)} }
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
    client.close();

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