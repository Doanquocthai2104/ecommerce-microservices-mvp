const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const projectRoot = path.resolve(__dirname, "../..");
const baseUrl =
  process.env.GATEWAY_URL || "http://127.0.0.1:3000";

const requestIds = [];
let productPid = null;

function docker(args) {
  return execFileSync("docker", ["compose", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 30000,
  }).trim();
}

function mongo(script) {
  return docker([
    "exec",
    "-T",
    "product-db",
    "mongosh",
    "--quiet",
    "--eval",
    script,
  ]);
}

function sql(statement) {
  return docker([
    "exec",
    "-T",
    "order-db",
    "psql",
    "-U",
    "order_user",
    "-d",
    "order_db",
    "-v",
    "ON_ERROR_STOP=1",
    "-t",
    "-A",
    "-c",
    statement,
  ]);
}

function newRequestId() {
  const id = randomUUID();
  requestIds.push(id);
  return id;
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
      pname: "Order HTTP integration test",
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

async function http(method, endpoint, options = {}) {
  const headers = {};

  if (options.authorization) {
    headers.Authorization = options.authorization;
  }

  if (options.key !== undefined) {
    headers["Idempotency-Key"] = options.key;
  }

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    signal: AbortSignal.timeout(40000),
  });

  const body = await response.json();

  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

function expectStatus(result, status) {
  assert.equal(
    result.status,
    status,
    `Expected HTTP ${status}, received ${result.status}: ${
      result.body.error || "Unexpected response"
    }`
  );
}

async function createCustomer() {
  const username = `httpord_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();

  const registered = await http("POST", "/api/auth/register", {
    body: { username, password },
  });

  expectStatus(registered, 201);

  const login = await http("POST", "/api/auth/login", {
    body: { username, password },
  });

  expectStatus(login, 200);

  assert.ok(Number.isInteger(registered.body.uid));
  assert.equal(typeof login.body.accessToken, "string");

  return {
    uid: registered.body.uid,
    authorization: `Bearer ${login.body.accessToken}`,
  };
}

async function main() {
  productPid = createProductFixture();

  const customer = await createCustomer();
  const otherCustomer = await createCustomer();

  const key = newRequestId();
  const body = {
    items: [{ pid: productPid, qty: 2 }],
  };

  const created = await http("POST", "/api/orders", {
    authorization: customer.authorization,
    key,
    body,
  });

  expectStatus(created, 201);

  const order = created.body;

  assert.ok(order.oid > 0);
  assert.equal(order.uid, customer.uid);
  assert.equal(order.subtotal, 25);
  assert.equal(typeof order.discount, "number");
  assert.equal(
    order.total_amount,
    order.subtotal - order.discount
  );
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].pid, productPid);
  assert.equal(order.items[0].qty, 2);
  assert.equal(order.items[0].unit_price, 12.5);

  assert.equal(created.headers.get("idempotency-key"), key);
  assert.equal(
    created.headers.get("location"),
    `/api/orders/${order.oid}`
  );

  assert.equal(readStock(), 8);

  console.log("PASS: Create returns 201, calculated amounts and response headers");

  const replay = await http("POST", "/api/orders", {
    authorization: customer.authorization,
    key,
    body,
  });

  expectStatus(replay, 201);
  assert.equal(replay.body.oid, order.oid);
  assert.equal(readStock(), 8);

  console.log("PASS: Same Idempotency-Key returns the existing order");

  const conflict = await http("POST", "/api/orders", {
    authorization: customer.authorization,
    key,
    body: {
      items: [{ pid: productPid, qty: 3 }],
    },
  });

  expectStatus(conflict, 409);
  assert.equal(readStock(), 8);

  console.log("PASS: Reusing key with different items returns 409");

  const list = await http("GET", "/api/orders", {
    authorization: customer.authorization,
  });

  expectStatus(list, 200);

  assert.ok(
    list.body.items.some((item) => item.oid === order.oid)
  );

  assert.ok(
    list.body.items.every((item) => item.uid === customer.uid)
  );

  const detail = await http(
    "GET",
    `/api/orders/${order.oid}`,
    { authorization: customer.authorization }
  );

  expectStatus(detail, 200);
  assert.equal(detail.body.oid, order.oid);
  assert.equal(detail.body.items[0].unit_price, 12.5);

  console.log("PASS: Customer reads own list and order details with 200");

  const forbidden = await http(
    "GET",
    `/api/orders/${order.oid}`,
    { authorization: otherCustomer.authorization }
  );

  expectStatus(forbidden, 403);

  const otherList = await http("GET", "/api/orders", {
    authorization: otherCustomer.authorization,
  });

  expectStatus(otherList, 200);

  assert.ok(
    !otherList.body.items.some((item) => item.oid === order.oid)
  );

  console.log("PASS: Another customer cannot read the order");

  const missingToken = await http("POST", "/api/orders", {
    key: newRequestId(),
    body,
  });

  expectStatus(missingToken, 401);

  const invalidToken = await http("GET", "/api/orders", {
    authorization: "Bearer invalid-token",
  });

  expectStatus(invalidToken, 401);

  console.log("PASS: Missing or invalid JWT returns 401");

  const missingKey = await http("POST", "/api/orders", {
    authorization: customer.authorization,
    body,
  });

  expectStatus(missingKey, 400);

  const invalidKey = await http("POST", "/api/orders", {
    authorization: customer.authorization,
    key: "invalid-key",
    body,
  });

  expectStatus(invalidKey, 400);

  console.log("PASS: Missing or invalid Idempotency-Key returns 400");

  const invalidBodies = [
    {},
    { items: [] },
    { items: [{ pid: productPid, qty: 0 }] },
    { items: [{ pid: productPid, qty: 1.5 }] },
    { items: [{ pid: String(productPid), qty: 1 }] },
    {
      items: [
        { pid: productPid, qty: 1 },
        { pid: productPid, qty: 1 },
      ],
    },
    {
      items: [
        { pid: productPid, qty: 1, unit_price: 0.01 },
      ],
    },
    {
      items: [{ pid: productPid, qty: 1 }],
      uid: otherCustomer.uid,
    },
    {
      items: [{ pid: productPid, qty: 1 }],
      discount: 999,
    },
  ];

  for (const invalidBody of invalidBodies) {
    const result = await http("POST", "/api/orders", {
      authorization: customer.authorization,
      key: newRequestId(),
      body: invalidBody,
    });

    expectStatus(result, 400);
  }

  assert.equal(readStock(), 8);

  console.log("PASS: Invalid items and client-supplied identity or prices return 400");

  for (const oid of ["0", "-1", "abc", "2147483648"]) {
    const result = await http("GET", `/api/orders/${oid}`, {
      authorization: customer.authorization,
    });

    expectStatus(result, 400);
  }

  const queryAttempt = await http(
    "GET",
    `/api/orders?uid=${otherCustomer.uid}`,
    { authorization: customer.authorization }
  );

  expectStatus(queryAttempt, 400);

  console.log("PASS: Invalid order IDs and UID query override return 400");

  const insufficient = await http("POST", "/api/orders", {
    authorization: customer.authorization,
    key: newRequestId(),
    body: {
      items: [{ pid: productPid, qty: 1000 }],
    },
  });

  expectStatus(insufficient, 409);
  assert.equal(readStock(), 8);

  console.log("PASS: Insufficient stock returns 409 without changing inventory");

  const missingOid = Number(
    sql('SELECT COALESCE(MAX(oid), 0) + 1 FROM public."Order";')
  );

  assert.ok(
    Number.isInteger(missingOid) &&
    missingOid > 0 &&
    missingOid <= 2147483647
  );

  const notFound = await http(
    "GET",
    `/api/orders/${missingOid}`,
    { authorization: customer.authorization }
  );

  expectStatus(notFound, 404);

  console.log("PASS: Missing order returns 404");

  const concurrentKey = newRequestId();

  const concurrentResults = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      http("POST", "/api/orders", {
        authorization: customer.authorization,
        key: concurrentKey,
        body: {
          items: [{ pid: productPid, qty: 1 }],
        },
      })
    )
  );

  for (const result of concurrentResults) {
    if (result.status === "rejected") {
      throw result.reason;
    }

    expectStatus(result.value, 201);
  }

  assert.equal(
    new Set(
      concurrentResults.map((result) => result.value.body.oid)
    ).size,
    1
  );

  assert.equal(readStock(), 7);

  console.log("PASS: Concurrent HTTP requests create one order and reserve once");

  console.log("Order HTTP checks completed successfully");
}

function cleanupOrderData() {
  if (requestIds.length === 0) return;

  // Các UUID này do script sinh, không lấy từ request bên ngoài.
  const ids = requestIds
    .map((id) => `'${id}'::uuid`)
    .join(",");

  sql(`
    BEGIN;

    DELETE FROM public."OrderRequest"
    WHERE request_id IN (${ids});

    DELETE FROM public."OutboxEvent"
    WHERE oid IN (
      SELECT oid
      FROM public."Order"
      WHERE request_id IN (${ids})
    );

    DELETE FROM public."Order"
    WHERE request_id IN (${ids});

    COMMIT;
  `);
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
    try {
      cleanupOrderData();
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
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});