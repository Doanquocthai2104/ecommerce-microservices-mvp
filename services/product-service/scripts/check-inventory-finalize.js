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

let testPid;
const operationIds = [];

function makeRequest(qty) {
  const operationId = randomUUID();
  operationIds.push(operationId);

  return {
    operationId,
    uid: 1,
    items: [{ pid: testPid, qty }],
  };
}

async function main() {
  await connectDatabase();

  const products = new ProductRepository();
  const inventory = new InventoryRepository();

  await products.initialize();
  await inventory.initialize();

  const product = await products.create({
    pname: "Inventory finalize test",
    price: "100.00",
    quantity: 5,
  });

  testPid = product.pid;

  async function expectQuantity(expected) {
    const current = await products.findByPid(testPid);
    assert.equal(current.quantity, expected);
  }

  // 1. Giữ 2 rồi hoàn lại.
  const releasedRequest = makeRequest(2);

  await inventory.reserve(releasedRequest);
  await expectQuantity(3);

  const released = await inventory.release(releasedRequest);
  assert.equal(released.status, "RELEASED");
  await expectQuantity(5);
  console.log("PASS: Release restores reserved stock");

  // 2. Retry hoàn kho không cộng lần nữa.
  const releasedAgain = await inventory.release(releasedRequest);
  assert.deepEqual(releasedAgain, released);
  await expectQuantity(5);
  console.log("PASS: Repeated release does not restore twice");

  // 3. Không giữ lại thao tác đã hủy.
  await assert.rejects(
    () => inventory.reserve(releasedRequest),
    { code: "CONFLICT" }
  );
  await expectQuantity(5);
  console.log("PASS: Released operation cannot reserve again");

  // 4. Không xác nhận thao tác đã hủy.
  await assert.rejects(
    () => inventory.commit(releasedRequest),
    { code: "CONFLICT" }
  );
  console.log("PASS: Released operation cannot be committed");

  // 5. Hủy trước khi yêu cầu giữ kho đến.
  const cancelledRequest = makeRequest(1);

  const cancelled = await inventory.release(cancelledRequest);
  assert.equal(cancelled.status, "RELEASED");
  assert.deepEqual(cancelled.items, []);
  await expectQuantity(5);
  console.log("PASS: Cancellation before reservation does not add stock");

  // 6. Yêu cầu giữ kho đến muộn bị chặn.
  await assert.rejects(
    () => inventory.reserve(cancelledRequest),
    { code: "CONFLICT" }
  );
  await expectQuantity(5);
  console.log("PASS: Late reservation after cancellation is rejected");

  // 7. Commit và retry commit không đổi số lượng.
  const committedRequest = makeRequest(1);

  await inventory.reserve(committedRequest);
  await expectQuantity(4);

  const committed = await inventory.commit(committedRequest);
  assert.equal(committed.status, "COMMITTED");

  const committedAgain = await inventory.commit(committedRequest);
  assert.deepEqual(committedAgain, committed);
  await expectQuantity(4);
  console.log("PASS: Commit and repeated commit do not deduct again");

  // 8. Không hoàn thao tác đã xác nhận.
  await assert.rejects(
    () => inventory.release(committedRequest),
    { code: "CONFLICT" }
  );
  await expectQuantity(4);
  console.log("PASS: Committed operation cannot be released");

  // 9. Hai yêu cầu hoàn kho đồng thời.
  const concurrentRequest = makeRequest(1);
  await inventory.reserve(concurrentRequest);
  await expectQuantity(3);

  const results = await Promise.all([
    inventory.release(concurrentRequest),
    inventory.release(concurrentRequest),
  ]);

  assert.deepEqual(results[0], results[1]);
  await expectQuantity(4);
  console.log("PASS: Concurrent releases restore stock only once");

  // 10. Không dùng mã thao tác với UID khác.
  await assert.rejects(
    () => inventory.release({
      ...releasedRequest,
      uid: 2,
    }),
    { code: "CONFLICT" }
  );
  await expectQuantity(4);
  console.log("PASS: Different customer cannot reuse operation ID");

  // 11. Giữ kho và hủy đồng thời: trạng thái cuối phải hủy.
  const racingRequest = makeRequest(1);

  const race = await Promise.allSettled([
    inventory.reserve(racingRequest),
    inventory.release(racingRequest),
  ]);

  assert.equal(race[1].status, "fulfilled");

  if (race[0].status === "rejected") {
    assert.equal(race[0].reason.code, "CONFLICT");
  }

  const finalOperation = await StockOperation.findById(
    racingRequest.operationId
  ).lean();

  assert.equal(finalOperation.status, "RELEASED");
  await expectQuantity(4);
  console.log("PASS: Reservation and cancellation race leaves correct stock");

  console.log("Inventory finalize checks completed successfully");
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

      if (testPid !== undefined) {
        await Product.deleteOne({ pid: testPid });
      }
    } finally {
      await disconnectDatabase();
    }
  });