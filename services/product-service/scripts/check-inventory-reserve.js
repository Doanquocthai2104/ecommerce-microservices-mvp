const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Product = require("../src/infrastructure/product-model");
const StockOperation = require("../src/infrastructure/stock-operation-model");
const ProductRepository = require("../src/infrastructure/product-repository");
const InventoryRepository = require("../src/infrastructure/inventory-repository");

const productIds = [];
const operationIds = [];

function makeRequest(items) {
  const operationId = randomUUID();
  operationIds.push(operationId);

  return {
    operationId,
    uid: 1, // Dữ liệu giả lập cho kiểm tra repository.
    items,
  };
}

async function main() {
  await connectDatabase();

  const products = new ProductRepository();
  const inventory = new InventoryRepository();

  await products.initialize();
  await inventory.initialize();

  const a = await products.create({
    pname: "Inventory test A",
    price: "100.00",
    quantity: 5,
  });
  productIds.push(a.pid);

  const b = await products.create({
    pname: "Inventory test B",
    price: "25.00",
    quantity: 2,
  });
  productIds.push(b.pid);

  const request = makeRequest([
    { pid: a.pid, qty: 2 },
    { pid: b.pid, qty: 1 },
  ]);

  // 1. Giữ kho cho cả hai sản phẩm.
  const first = await inventory.reserve(request);

  assert.equal(first.status, "RESERVED");
  assert.deepEqual(first.items, [
    { pid: a.pid, qty: 2, unit_price: "100.00" },
    { pid: b.pid, qty: 1, unit_price: "25.00" },
  ]);

  assert.equal((await products.findByPid(a.pid)).quantity, 3);
  assert.equal((await products.findByPid(b.pid)).quantity, 1);
  console.log("PASS: Multiple products reserved with price snapshots");

  // 2. Retry cùng mã không trừ lại.
  const repeated = await inventory.reserve(request);

  assert.deepEqual(repeated, first);
  assert.equal((await products.findByPid(a.pid)).quantity, 3);
  assert.equal((await products.findByPid(b.pid)).quantity, 1);
  console.log("PASS: Retrying the same operation does not deduct again");

  // 3. Cùng mã nhưng đổi nội dung.
  await assert.rejects(
    () => inventory.reserve({
      ...request,
      items: [{ pid: a.pid, qty: 1 }],
    }),
    { code: "CONFLICT" }
  );
  console.log("PASS: Reusing operation ID with different items rejected");

  // 4. Hai request đồng thời có cùng mã.
  const concurrentRequest = makeRequest([
    { pid: a.pid, qty: 1 },
    { pid: b.pid, qty: 1 },
  ]);

  const concurrent = await Promise.all([
    inventory.reserve(concurrentRequest),
    inventory.reserve(concurrentRequest),
  ]);

  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal((await products.findByPid(a.pid)).quantity, 2);
  assert.equal((await products.findByPid(b.pid)).quantity, 0);

  assert.equal(
    await StockOperation.countDocuments({
      _id: concurrentRequest.operationId,
    }),
    1
  );
  console.log("PASS: Concurrent identical requests deduct only once");

  // 5. A đủ hàng nhưng B hết hàng: rollback cả A.
  const insufficientRequest = makeRequest([
    { pid: a.pid, qty: 1 },
    { pid: b.pid, qty: 1 },
  ]);

  await assert.rejects(
    () => inventory.reserve(insufficientRequest),
    { code: "INSUFFICIENT_STOCK" }
  );

  assert.equal((await products.findByPid(a.pid)).quantity, 2);
  assert.equal(
    await StockOperation.findById(
      insufficientRequest.operationId
    ),
    null
  );
  console.log("PASS: Insufficient item rolls back the entire reservation");

  // 6. Hai mã khác nhau cùng mua 2, A chỉ còn 2.
  const contenders = [
    makeRequest([{ pid: a.pid, qty: 2 }]),
    makeRequest([{ pid: a.pid, qty: 2 }]),
  ];

  const outcomes = await Promise.allSettled(
    contenders.map((input) => inventory.reserve(input))
  );

  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1
  );

  const rejected = outcomes.filter(
    (result) => result.status === "rejected"
  );

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "INSUFFICIENT_STOCK");
  assert.equal((await products.findByPid(a.pid)).quantity, 0);
  console.log("PASS: Competing operations cannot oversell");

  // 7. Retry thao tác cũ vẫn thành công dù hàng hiện đã hết.
  const replay = await inventory.reserve(request);
  assert.deepEqual(replay, first);
  assert.equal((await products.findByPid(a.pid)).quantity, 0);
  console.log("PASS: Replay returns saved receipt even when stock is zero");

  console.log("Inventory reserve checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await StockOperation.deleteMany({
        _id: { $in: operationIds },
      });

      await Product.deleteMany({
        pid: { $in: productIds },
      });
    } finally {
      await disconnectDatabase();
    }
  });