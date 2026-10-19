const assert = require("node:assert/strict");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Product = require("../src/infrastructure/product-model");
const ProductRepository = require("../src/infrastructure/product-repository");

const createdPids = [];

async function main() {
  await connectDatabase();

  const repository = new ProductRepository();
  await repository.initialize();

  // 1. Tạo sản phẩm.
  const product = await repository.create({
    pname: "Repository test laptop",
    price: "1500.50",
    quantity: 10,
  });

  createdPids.push(product.pid);

  assert.ok(Number.isInteger(product.pid));
  assert.ok(product.pid > 0);
  assert.equal(product.price, "1500.50");
  assert.equal(product.quantity, 10);
  console.log("PASS: Product created with generated PID");

  // 2. Đọc theo PID.
  const loaded = await repository.findByPid(product.pid);
  assert.deepEqual(loaded, product);
  console.log("PASS: Product retrieved by PID");

  // 3. Đọc danh sách.
  const list = await repository.findAll();
  assert.ok(list.some((item) => item.pid === product.pid));
  console.log("PASS: Product appears in list");

  // 4. Cập nhật.
  const updated = await repository.update(product.pid, {
    pname: "Updated test laptop",
    price: "1700.25",
    quantity: 15,
  });

  assert.equal(updated.pname, "Updated test laptop");
  assert.equal(updated.price, "1700.25");
  assert.equal(updated.quantity, 15);
  console.log("PASS: Product updated");

  // 5. Validator hoạt động khi cập nhật.
  await assert.rejects(
    () => repository.update(product.pid, { quantity: -1 }),
    (err) => err.name === "ValidationError"
  );

  const unchanged = await repository.findByPid(product.pid);
  assert.equal(unchanged.quantity, 15);
  console.log("PASS: Invalid update rejected without changing stock");

  // 6. MongoDB từ chối PID trùng.
  await assert.rejects(
    () => Product.create({
      pid: product.pid,
      pname: "Duplicate PID test",
      price: "10.00",
      quantity: 1,
    }),
    (err) => err.code === 11000
  );
  console.log("PASS: Duplicate PID rejected by MongoDB");

  // 7. Tạo đồng thời ba sản phẩm.
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, async (_, index) => {
      const item = await repository.create({
        pname: `Concurrent test ${index}`,
        price: "10.00",
        quantity: 1,
      });

      createdPids.push(item.pid);
      return item;
    })
  );

  assert.ok(results.every((result) => result.status === "fulfilled"));

  const concurrentPids = results.map(
    (result) => result.value.pid
  );

  assert.equal(new Set(concurrentPids).size, 3);
  assert.ok(concurrentPids.every((pid) => pid !== product.pid));
  console.log("PASS: Concurrent creates receive distinct PIDs");

  // 8. Xóa sản phẩm.
  const deleted = await repository.delete(product.pid);
  assert.equal(deleted.pid, product.pid);
  console.log("PASS: Product deleted");

  // 9. Đọc sản phẩm đã xóa.
  assert.equal(
    await repository.findByPid(product.pid),
    null
  );
  console.log("PASS: Deleted product returns null");

  console.log("Product repository checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (createdPids.length) {
        await Product.deleteMany({
          pid: { $in: createdPids },
        });
      }
    } finally {
      await disconnectDatabase();
    }
  });