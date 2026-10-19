const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const {
  mongoose,
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const {
  grpc,
  InventoryService,
} = require("../src/infrastructure/inventory-proto");

const address =
  process.env.PRODUCT_GRPC_URL ||
  `${process.env.GRPC_HOST || "127.0.0.1"}:${process.env.GRPC_PORT || 50053}`;

const client = new InventoryService(
  address,
  grpc.credentials.createInsecure()
);

const createdPids = [];
const operationIds = [];

function newOperationId() {
  const id = randomUUID();
  operationIds.push(id);
  return id;
}

function callInventory(method, request, credentials = "valid") {
  const metadata = new grpc.Metadata();

  if (credentials === "valid") {
    metadata.set("x-order-service-key", process.env.ORDER_SERVICE_KEY);
  } else if (credentials === "wrong") {
    metadata.set("x-order-service-key", "incorrect-service-key");
  } else if (credentials === "authorization-only") {
    metadata.set("authorization", "Bearer test-token");
  }

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 5000) },
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

async function createFixture() {
  const counters = mongoose.connection.collection("counters");

  const counter = await counters.findOneAndUpdate(
    {
      _id: "product",
      seq: { $lt: 2147483647 },
    },
    { $inc: { seq: 1 } },
    { returnDocument: "after" }
  );

  assert.ok(counter, "Product counter is missing or exhausted");

  const pid = counter.seq;

  await mongoose.connection.collection("products").insertOne({
    pid,
    pname: `Inventory gRPC test ${randomUUID()}`,
    price: mongoose.Types.Decimal128.fromString("12.50"),
    quantity: 10,
  });

  createdPids.push(pid);
  return pid;
}

async function getStock(pid) {
  const product = await mongoose.connection
    .collection("products")
    .findOne({ pid });

  assert.ok(product, "Test product is missing");
  return product.quantity;
}

async function main() {
  assert.ok(
    process.env.ORDER_SERVICE_KEY &&
      Buffer.byteLength(process.env.ORDER_SERVICE_KEY, "utf8") >= 32,
    "ORDER_SERVICE_KEY must contain at least 32 bytes"
  );

  await connectDatabase();

  const pid = await createFixture();

  // UID này chỉ dùng cho dữ liệu kiểm thử nội bộ.
  // Inventory tin cậy Order Service thông qua service key.
  const uid = 2147483000;

  const request = {
    operationId: newOperationId(),
    uid,
    items: [{ pid, qty: 3 }],
  };

  await expectGrpcError(
    () => callInventory("reserve", request, "missing"),
    grpc.status.UNAUTHENTICATED
  );
  assert.equal(await getStock(pid), 10);
  console.log("PASS: Missing service key rejected without changing stock");

  await expectGrpcError(
    () => callInventory("reserve", request, "wrong"),
    grpc.status.UNAUTHENTICATED
  );
  assert.equal(await getStock(pid), 10);
  console.log("PASS: Wrong service key rejected without changing stock");

  await expectGrpcError(
    () => callInventory("reserve", request, "authorization-only"),
    grpc.status.UNAUTHENTICATED
  );
  console.log("PASS: Authorization header cannot replace service key");

  const reserved = await callInventory("reserve", request);

  assert.equal(reserved.operationId, request.operationId);
  assert.equal(reserved.uid, uid);
  assert.equal(reserved.status, "RESERVED");
  assert.equal(reserved.items.length, 1);
  assert.equal(reserved.items[0].pid, pid);
  assert.equal(reserved.items[0].qty, 3);
  assert.equal(Number(reserved.items[0].unitPrice), 12.5);
  assert.equal(await getStock(pid), 7);

  console.log("PASS: Reserve returns price snapshot and deducts stock");

  const replay = await callInventory("reserve", request);

  assert.deepEqual(replay, reserved);
  assert.equal(await getStock(pid), 7);
  console.log("PASS: Repeated reserve does not deduct stock twice");

  await expectGrpcError(
    () =>
      callInventory("reserve", {
        ...request,
        items: [{ pid, qty: 4 }],
      }),
    grpc.status.ALREADY_EXISTS
  );
  assert.equal(await getStock(pid), 7);
  console.log("PASS: Reusing operation ID with different items rejected");

  const insufficientRequest = {
    operationId: newOperationId(),
    uid,
    items: [{ pid, qty: 8 }],
  };

  await expectGrpcError(
    () => callInventory("reserve", insufficientRequest),
    grpc.status.FAILED_PRECONDITION
  );
  assert.equal(await getStock(pid), 7);
  console.log("PASS: Insufficient stock returns FAILED_PRECONDITION");

  const released = await callInventory("release", request);
  assert.equal(released.status, "RELEASED");
  assert.equal(await getStock(pid), 10);

  const releasedAgain = await callInventory("release", request);
  assert.equal(releasedAgain.status, "RELEASED");
  assert.equal(await getStock(pid), 10);
  console.log("PASS: Release and repeated release restore stock only once");

  await expectGrpcError(
    () => callInventory("reserve", request),
    grpc.status.ALREADY_EXISTS
  );
  assert.equal(await getStock(pid), 10);
  console.log("PASS: Released operation cannot reserve again");

  const commitRequest = {
    operationId: newOperationId(),
    uid,
    items: [{ pid, qty: 2 }],
  };

  await callInventory("reserve", commitRequest);
  assert.equal(await getStock(pid), 8);

  const committed = await callInventory("commit", commitRequest);
  assert.equal(committed.status, "COMMITTED");

  const committedAgain = await callInventory("commit", commitRequest);
  assert.equal(committedAgain.status, "COMMITTED");
  assert.equal(await getStock(pid), 8);
  console.log("PASS: Commit and repeated commit do not deduct stock again");

  await expectGrpcError(
    () => callInventory("release", commitRequest),
    grpc.status.ALREADY_EXISTS
  );
  assert.equal(await getStock(pid), 8);
  console.log("PASS: Committed operation cannot release stock");

  console.log("Inventory gRPC checks completed successfully");
}

async function cleanup() {
  if (mongoose.connection.readyState !== 1) return;

  // Chỉ xóa bản ghi có ID do lần chạy này tạo.
  await mongoose.connection.collection("stock_operations").deleteMany({
    _id: { $in: operationIds },
  });

  await mongoose.connection.collection("products").deleteMany({
    pid: { $in: createdPids },
  });
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
      await cleanup();
    } catch (err) {
      console.error("Cleanup failed:", err.message);
      process.exitCode = 1;
    }

    await disconnectDatabase();
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});