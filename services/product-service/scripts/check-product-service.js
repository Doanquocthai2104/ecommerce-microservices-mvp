const assert = require("node:assert/strict");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Product = require("../src/infrastructure/product-model");
const ProductRepository = require("../src/infrastructure/product-repository");
const ProductService = require("../src/application/product-service");

// Danh tính giả lập để kiểm tra quy tắc nghiệp vụ.
// Chưa phải kiểm tra JWT hoặc đăng nhập Admin.
const admin = { uid: 1, role: "ADMIN" };
const customer = { uid: 2, role: "CUSTOMER" };

const createdPids = [];

async function main() {
  await connectDatabase();

  const repository = new ProductRepository();
  await repository.initialize();

  const service = new ProductService(repository);

  // 1. Admin tạo sản phẩm.
  const product = await service.create(
    {
      pname: "Service test laptop",
      price: 1500,
      quantity: 10,
    },
    admin
  );

  createdPids.push(product.pid);

  assert.equal(product.price, "1500.00");
  assert.equal(product.quantity, 10);
  console.log("PASS: Admin creates product with normalized price");

  // 2. Customer xem danh sách và chi tiết.
  const list = await service.list(customer);
  assert.ok(list.some((item) => item.pid === product.pid));

  const loaded = await service.get(product.pid, customer);
  assert.deepEqual(loaded, product);
  console.log("PASS: Customer reads product list and details");

  // 3. Customer không được thêm, sửa hoặc xóa.
  const forbiddenOperations = [
    () => service.create(
      { pname: "Forbidden", price: 10, quantity: 1 },
      customer
    ),
    () => service.update(
      product.pid,
      { quantity: 20 },
      customer
    ),
    () => service.delete(product.pid, customer),
  ];

  for (const operation of forbiddenOperations) {
    await assert.rejects(operation, { code: "FORBIDDEN" });
  }
  console.log("PASS: Customer cannot create, update or delete");

  // 4. Admin cập nhật riêng tồn kho.
  const updated = await service.update(
    product.pid,
    { quantity: 15 },
    admin
  );

  assert.equal(updated.quantity, 15);
  assert.equal(updated.price, product.price);
  assert.equal(updated.pname, product.pname);
  console.log("PASS: Admin updates stock and preserves other fields");

  // 5. Giá âm.
  await assert.rejects(
    () => service.update(product.pid, { price: -1 }, admin),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Negative price rejected");

  // 6. Số lượng thập phân.
  await assert.rejects(
    () => service.update(product.pid, { quantity: 1.5 }, admin),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Fractional quantity rejected");

  // 7. Không cho đổi PID.
  await assert.rejects(
    () => service.update(product.pid, { pid: 999 }, admin),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: PID modification rejected");

  // 8. Admin xóa; đọc lại nhận NOT_FOUND.
  const deleted = await service.delete(product.pid, admin);
  assert.equal(deleted.pid, product.pid);

  await assert.rejects(
    () => service.get(product.pid, customer),
    { code: "NOT_FOUND" }
  );
  console.log("PASS: Admin deletes product and missing product is rejected");

  // 9. Chưa xác thực.
  await assert.rejects(
    () => service.list(undefined),
    { code: "INVALID_CREDENTIALS" }
  );
  console.log("PASS: Unauthenticated access rejected");

  console.log("Product service checks completed successfully");
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