const assert = require("node:assert/strict");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Product = require("../src/infrastructure/product-model");
const ProductRepository = require("../src/infrastructure/product-repository");

let testPid;

async function main() {
  await connectDatabase();

  const repository = new ProductRepository();
  await repository.initialize();

  const product = await repository.create({
    pname: "Atomic stock test",
    price: "100.00",
    quantity: 5,
  });

  testPid = product.pid;

  // 1. Trừ kho khi đủ hàng: 5 - 2 = 3.
  const decreased = await repository.decreaseStock(testPid, 2);

  assert.equal(decreased.quantity, 3);
  console.log("PASS: Stock decreases when quantity is sufficient");

  // 2. Không đủ hàng: giữ nguyên 3.
  const insufficient = await repository.decreaseStock(testPid, 4);

  assert.equal(insufficient, null);

  const unchanged = await repository.findByPid(testPid);
  assert.equal(unchanged.quantity, 3);
  console.log("PASS: Insufficient stock is not changed");

  // 3. Hai yêu cầu cùng mua 2, trong khi chỉ còn 3.
  const results = await Promise.allSettled([
    repository.decreaseStock(testPid, 2),
    repository.decreaseStock(testPid, 2),
  ]);

  assert.ok(
    results.every((result) => result.status === "fulfilled")
  );

  const values = results.map((result) => result.value);

  assert.equal(values.filter((value) => value !== null).length, 1);
  assert.equal(values.filter((value) => value === null).length, 1);

  const afterConcurrent = await repository.findByPid(testPid);
  assert.equal(afterConcurrent.quantity, 1);
  console.log("PASS: Concurrent purchases cannot oversell");

  // 4. Hoàn lại 2: 1 + 2 = 3.
  const restored = await repository.restoreStock(testPid, 2);

  assert.equal(restored.quantity, 3);
  console.log("PASS: Stock restoration increases quantity");

  // 5. Từ chối số lượng không hợp lệ.
  for (const qty of [0, -1, 1.5]) {
    await assert.rejects(
      () => repository.decreaseStock(testPid, qty),
      { code: "INVALID_INPUT" }
    );

    await assert.rejects(
      () => repository.restoreStock(testPid, qty),
      { code: "INVALID_INPUT" }
    );
  }
  console.log("PASS: Invalid stock quantities rejected");

  // 6. Cho phép bán hết, tồn kho bằng 0.
  const soldOut = await repository.decreaseStock(testPid, 3);

  assert.equal(soldOut.quantity, 0);
  assert.equal(
    await repository.decreaseStock(testPid, 1),
    null
  );
  console.log("PASS: Stock can reach zero but cannot become negative");

  // 7. Không cho hoàn kho vượt giới hạn.
  await repository.update(testPid, {
    quantity: 2147483647,
  });

  assert.equal(
    await repository.restoreStock(testPid, 1),
    null
  );

  const maximum = await repository.findByPid(testPid);
  assert.equal(maximum.quantity, 2147483647);
  console.log("PASS: Stock restoration cannot exceed integer limit");

  // 8. Sản phẩm không tồn tại.
  await repository.delete(testPid);

  assert.equal(
    await repository.decreaseStock(testPid, 1),
    null
  );

  assert.equal(
    await repository.restoreStock(testPid, 1),
    null
  );
  console.log("PASS: Missing product is not updated");

  console.log("Stock checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (testPid !== undefined) {
        await Product.deleteOne({ pid: testPid });
      }
    } finally {
      await disconnectDatabase();
    }
  });