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

async function main() {
  await connectDatabase();

  const products = new ProductRepository();
  const inventory = new InventoryRepository();

  await products.initialize();
  await inventory.initialize();

  async function createProduct(quantity) {
    const product = await products.create({
      pname: "Reservation guard test",
      price: "100.00",
      quantity,
    });

    productIds.push(product.pid);
    return product;
  }

  function makeRequest(pid, qty) {
    const operationId = randomUUID();
    operationIds.push(operationId);

    return {
      operationId,
      uid: 1,
      items: [{ pid, qty }],
    };
  }

  const a = await createProduct(5);
  const request = makeRequest(a.pid, 2);

  await inventory.reserve(request);

  // 1. Không ghi đè tồn kho đang giữ.
  await assert.rejects(
    () => products.update(a.pid, { quantity: 99 }),
    { code: "CONFLICT" }
  );

  assert.equal((await products.findByPid(a.pid)).quantity, 3);
  console.log("PASS: Stock overwrite blocked during reservation");

  // 2. Không xóa sản phẩm đang giữ.
  await assert.rejects(
    () => products.delete(a.pid),
    { code: "CONFLICT" }
  );

  assert.ok(await products.findByPid(a.pid));
  console.log("PASS: Product deletion blocked during reservation");

  // 3. Đổi giá không thay đổi snapshot đã chốt.
  const edited = await products.update(a.pid, {
    pname: "Renamed product",
    price: "120.00",
  });

  assert.equal(edited.price, "120.00");
  assert.equal(edited.quantity, 3);

  const receipt = await inventory.reserve(request);
  assert.equal(receipt.items[0].unit_price, "100.00");
  console.log("PASS: Catalog edits preserve reserved price snapshot");

  // 4. Sau khi hoàn kho, được cập nhật số lượng.
  await inventory.release(request);

  assert.equal((await products.findByPid(a.pid)).quantity, 5);

  const afterRelease = await products.update(a.pid, {
    quantity: 8,
  });

  assert.equal(afterRelease.quantity, 8);
  console.log("PASS: Stock update allowed after release");

  // 5. Sau khi hoàn, được xóa.
  await products.delete(a.pid);
  assert.equal(await products.findByPid(a.pid), null);
  console.log("PASS: Product deletion allowed after release");

  // 6. Thao tác đã COMMITTED không còn chặn sửa/xóa.
  const b = await createProduct(3);
  const committedRequest = makeRequest(b.pid, 1);

  await inventory.reserve(committedRequest);
  await inventory.commit(committedRequest);

  const afterCommit = await products.update(b.pid, {
    quantity: 4,
  });

  assert.equal(afterCommit.quantity, 4);

  await products.delete(b.pid);
  assert.equal(await products.findByPid(b.pid), null);
  console.log("PASS: Committed operation does not block catalog maintenance");

  // 7. Giữ kho và xóa sản phẩm đồng thời.
  const c = await createProduct(2);
  const racingRequest = makeRequest(c.pid, 1);

  const results = await Promise.allSettled([
    inventory.reserve(racingRequest),
    products.delete(c.pid),
  ]);

  if (results[0].status === "fulfilled") {
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.code, "CONFLICT");

    const remaining = await products.findByPid(c.pid);
    assert.equal(remaining.quantity, 1);
  } else {
    assert.equal(results[0].reason.code, "NOT_FOUND");
    assert.equal(results[1].status, "fulfilled");
    assert.equal(await products.findByPid(c.pid), null);

    assert.equal(
      await StockOperation.findById(racingRequest.operationId),
      null
    );
  }

  console.log("PASS: Concurrent reservation and deletion remain consistent");

  console.log("Product reservation guard checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      // Dọn trực tiếp dữ liệu thử, kể cả thao tác còn RESERVED.
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