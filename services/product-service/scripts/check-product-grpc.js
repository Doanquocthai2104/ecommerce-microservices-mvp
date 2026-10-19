const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  grpc,
  ProductService: ProductGrpcService,
} = require("../src/infrastructure/product-proto");

const { AuthService } = require("../src/infrastructure/auth-proto");

const authClient = new AuthService(
  process.env.AUTH_GRPC_URL || "127.0.0.1:50051",
  grpc.credentials.createInsecure()
);

const productClient = new ProductGrpcService(
  "127.0.0.1:50053",
  grpc.credentials.createInsecure()
);

const createdPids = new Set();
let adminToken;

function call(client, method, request, token) {
  const metadata = new grpc.Metadata();

  if (token) {
    metadata.set("authorization", `Bearer ${token}`);
  }

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 10000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

async function main() {
  assert.ok(
    process.env.TEST_ADMIN_USERNAME &&
    process.env.TEST_ADMIN_PASSWORD,
    "Missing TEST_ADMIN_USERNAME or TEST_ADMIN_PASSWORD in Product .env"
  );

  // 1. Đăng nhập và xác minh Admin thật.
  const adminLogin = await call(authClient, "login", {
    username: process.env.TEST_ADMIN_USERNAME,
    password: process.env.TEST_ADMIN_PASSWORD,
  });

  adminToken = adminLogin.accessToken;

  const adminIdentity = await call(authClient, "verifyToken", {
    token: adminToken,
  });

  assert.equal(adminIdentity.role, "ADMIN");
  console.log("PASS: Auth issues a verified ADMIN token");

  // Tạo Customer thật để kiểm tra phân quyền.
  const customerInput = {
    username: `progrpc_${randomUUID()}`,
    password: "P@ss123",
  };

  await call(authClient, "register", customerInput);

  const customerLogin = await call(
    authClient,
    "login",
    customerInput
  );

  const customerToken = customerLogin.accessToken;

  // 2. Thiếu JWT.
  await assert.rejects(
    () => call(productClient, "listProducts", {}),
    { code: grpc.status.UNAUTHENTICATED }
  );
  console.log("PASS: Missing token rejected");

  // 3. JWT sai.
  await assert.rejects(
    () => call(
      productClient,
      "listProducts",
      {},
      "invalid-token"
    ),
    { code: grpc.status.UNAUTHENTICATED }
  );
  console.log("PASS: Invalid token rejected");

  // 4. Admin tạo sản phẩm.
  const product = await call(
    productClient,
    "createProduct",
    {
      pname: "gRPC test laptop",
      price: "1500.50",
      quantity: 10,
    },
    adminToken
  );

  createdPids.add(product.pid);

  assert.ok(product.pid > 0);
  assert.equal(product.price, "1500.50");
  assert.equal(product.quantity, 10);
  console.log("PASS: Admin creates product via gRPC");

  // 5. Customer xem danh sách.
  const list = await call(
    productClient,
    "listProducts",
    {},
    customerToken
  );

  assert.ok(
    list.items.some((item) => item.pid === product.pid)
  );
  console.log("PASS: Customer reads product list");

  // 6. Customer xem chi tiết.
  const loaded = await call(
    productClient,
    "getProduct",
    { pid: product.pid },
    customerToken
  );

  assert.deepEqual(loaded, product);
  console.log("PASS: Customer reads product details");

  // 7. Customer không được thêm, sửa, xóa.
  const forbiddenOperations = [
    () => call(
      productClient,
      "createProduct",
      { pname: "Forbidden", price: "10.00", quantity: 1 },
      customerToken
    ),
    () => call(
      productClient,
      "updateProduct",
      { pid: product.pid, quantity: 20 },
      customerToken
    ),
    () => call(
      productClient,
      "deleteProduct",
      { pid: product.pid },
      customerToken
    ),
  ];

  for (const operation of forbiddenOperations) {
    await assert.rejects(operation, {
      code: grpc.status.PERMISSION_DENIED,
    });
  }
  console.log("PASS: Customer cannot create, update or delete");

  // 8. Admin cập nhật sản phẩm.
  const updated = await call(
    productClient,
    "updateProduct",
    {
      pid: product.pid,
      pname: "Updated gRPC laptop",
      price: "1700.25",
      quantity: 15,
    },
    adminToken
  );

  assert.equal(updated.pname, "Updated gRPC laptop");
  assert.equal(updated.price, "1700.25");
  assert.equal(updated.quantity, 15);
  console.log("PASS: Admin updates product via gRPC");

  // 9. Giá âm bị từ chối.
  await assert.rejects(
    () => call(
      productClient,
      "updateProduct",
      { pid: product.pid, price: "-1" },
      adminToken
    ),
    { code: grpc.status.INVALID_ARGUMENT }
  );
  console.log("PASS: Negative price rejected");

  // 10. Tên rỗng bị từ chối.
  await assert.rejects(
    () => call(
      productClient,
      "updateProduct",
      { pid: product.pid, pname: "" },
      adminToken
    ),
    { code: grpc.status.INVALID_ARGUMENT }
  );
  console.log("PASS: Empty product name rejected");

  // 11. Admin xóa sản phẩm.
  const deleted = await call(
    productClient,
    "deleteProduct",
    { pid: product.pid },
    adminToken
  );

  assert.equal(deleted.pid, product.pid);
  createdPids.delete(product.pid);
  console.log("PASS: Admin deletes product via gRPC");

  // 12. Đọc, sửa, xóa sản phẩm không tồn tại.
  const missingOperations = [
    () => call(
      productClient,
      "getProduct",
      { pid: product.pid },
      customerToken
    ),
    () => call(
      productClient,
      "updateProduct",
      { pid: product.pid, quantity: 1 },
      adminToken
    ),
    () => call(
      productClient,
      "deleteProduct",
      { pid: product.pid },
      adminToken
    ),
  ];

  for (const operation of missingOperations) {
    await assert.rejects(operation, {
      code: grpc.status.NOT_FOUND,
    });
  }
  console.log("PASS: Missing product operations return NOT_FOUND");

  console.log("Product gRPC checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      for (const pid of createdPids) {
        try {
          await call(
            productClient,
            "deleteProduct",
            { pid },
            adminToken
          );
        } catch (err) {
          if (err.code !== grpc.status.NOT_FOUND) {
            console.error("Test cleanup failed:", err.message);
            process.exitCode = 1;
          }
        }
      }
    } finally {
      authClient.close();
      productClient.close();
    }
  });