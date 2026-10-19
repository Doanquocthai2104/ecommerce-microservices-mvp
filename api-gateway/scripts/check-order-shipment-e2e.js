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

const requestId = randomUUID();

let productPid = null;
let orderId = null;

function docker(args) {
  return execFileSync("docker", ["compose", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 30000,
  }).trim();
}

function mongo(service, script) {
  return docker([
    "exec",
    "-T",
    service,
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

async function http(method, endpoint, options = {}) {
  const headers = {};

  if (options.authorization) {
    headers.Authorization = options.authorization;
  }

  if (options.key) {
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
    body,
  };
}

function expectStatus(result, expected) {
  assert.equal(
    result.status,
    expected,
    `Expected HTTP ${expected}, received ${result.status}: ${
      result.body.error || "Unexpected response"
    }`
  );
}

function createProduct() {
  const output = mongo(
    "product-db",
    `
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
      pname: "E2E Order Shipment ${requestId}",
      price: NumberDecimal("12.50"),
      quantity: 5
    });

    print(JSON.stringify({ pid: counter.seq }));
    `
  );

  return JSON.parse(output).pid;
}

function readStock() {
  const output = mongo(
    "product-db",
    `
    const product = db.getSiblingDB("product_db")
      .products.findOne({ pid: ${productPid} });

    if (!product) {
      throw new Error("E2E product is missing");
    }

    print(JSON.stringify({ quantity: product.quantity }));
    `
  );

  return JSON.parse(output).quantity;
}

function readShipment() {
  const output = mongo(
    "shipment-db",
    `
    const shipment = db.getSiblingDB("shipment_db")
      .shipments.findOne(
        { oid: ${orderId} },
        {
          _id: 0,
          shipid: 1,
          oid: 1,
          uid: 1,
          status: 1,
          sourceEventId: 1
        }
      );

    print(JSON.stringify(shipment));
    `
  );

  return JSON.parse(output);
}

function countShipments() {
  return Number(
    mongo(
      "shipment-db",
      `
      print(
        db.getSiblingDB("shipment_db")
          .shipments.countDocuments({ oid: ${orderId} })
      );
      `
    )
  );
}

function readOutbox() {
  // requestId được script sinh bằng randomUUID().
  const output = sql(`
    SELECT json_build_object(
      'status', r.status,
      'eventId', e.event_id,
      'published', e.published_at IS NOT NULL
    )
    FROM public."OrderRequest" r
    JOIN public."OutboxEvent" e ON e.oid = r.oid
    WHERE r.request_id = '${requestId}'::uuid
      AND e.event_type = 'OrderCreated';
  `);

  return output ? JSON.parse(output) : null;
}

async function waitForShipment() {
  const deadline = Date.now() + 45000;

  while (Date.now() < deadline) {
    const shipment = readShipment();

    if (shipment) return shipment;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Timed out waiting for Shipment consumer");
}

async function waitForPublishedOutbox() {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const event = readOutbox();

    if (event?.published) return event;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Timed out waiting for Outbox publication");
}

async function main() {
  productPid = createProduct();

  const username = `e2e_${randomUUID().replaceAll("-", "")}`;
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

  const uid = registered.body.uid;
  const authorization = `Bearer ${login.body.accessToken}`;

  console.log("PASS: Customer registers and logs in through Gateway");

  const body = {
    items: [{ pid: productPid, qty: 2 }],
  };

  const created = await http("POST", "/api/orders", {
    authorization,
    key: requestId,
    body,
  });

  expectStatus(created, 201);

  orderId = created.body.oid;

  assert.ok(Number.isInteger(orderId) && orderId > 0);
  assert.equal(created.body.uid, uid);
  assert.equal(created.body.subtotal, 25);
  assert.equal(
    created.body.total_amount,
    created.body.subtotal - created.body.discount
  );
  assert.equal(created.body.items[0].unit_price, 12.5);

  console.log("PASS: REST request creates an order with server-calculated amounts");

  const shipment = await waitForShipment();

  assert.equal(shipment.oid, orderId);
  assert.equal(shipment.uid, uid);
  assert.equal(shipment.status, "PENDING");
  assert.ok(shipment.shipid > 0);

  console.log("PASS: Kafka consumer creates the matching PENDING shipment");

    assert.ok(
    Object.hasOwn(created.body, "shipment"),
    "Create response must include shipment"
  );

  if (created.body.shipment !== null) {
    assert.equal(
      created.body.shipment.shipid,
      shipment.shipid
    );
  }

  const orderWithShipment = await http(
    "GET",
    `/api/orders/${orderId}`,
    { authorization }
  );

  expectStatus(orderWithShipment, 200);

  assert.deepEqual(orderWithShipment.body.shipment, {
    shipid: shipment.shipid,
    oid: orderId,
    status: "PENDING",
  });

  console.log("PASS: Order REST response includes its matching shipment");

  const outbox = await waitForPublishedOutbox();

  assert.equal(outbox.status, "COMPLETED");
  assert.equal(outbox.published, true);
  assert.equal(shipment.sourceEventId, outbox.eventId);

  console.log("PASS: Shipment references the published OrderCreated event");

  assert.equal(readStock(), 3);

  console.log("PASS: Product inventory decreases by the ordered quantity");

  const replay = await http("POST", "/api/orders", {
    authorization,
    key: requestId,
    body,
  });

  expectStatus(replay, 201);
  assert.equal(replay.body.oid, orderId);

  console.log("PASS: Repeating the REST request returns the same order");

  assert.equal(readStock(), 3);
  assert.equal(countShipments(), 1);
  assert.equal(readShipment().shipid, shipment.shipid);

  console.log("PASS: Replay preserves stock and the existing shipment");

  console.table([
    {
      uid,
      pid: productPid,
      oid: orderId,
      shipid: shipment.shipid,
      shipmentStatus: shipment.status,
      remainingStock: 3,
    },
  ]);

  console.log("Order Shipment E2E checks completed successfully");
  console.log("E2E records are retained for inspection.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);

  console.error(
    "E2E context:",
    JSON.stringify({
      requestId,
      pid: productPid,
      oid: orderId,
    })
  );

  process.exitCode = 1;
});