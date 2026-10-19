const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const dotenv = require("dotenv");

// Chỉ script kiểm tra đọc thông tin Admin đã lưu ở Product.
const adminConfig = dotenv.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../services/product-service/.env"),
    "utf8"
  )
);

const baseUrl = "http://127.0.0.1:3000";
const createdPids = new Set();

let adminToken;

async function request(method, endpoint, body, token) {
  const headers = {};

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function expectStatus(response, status) {
  assert.equal(
    response.status,
    status,
    `Expected ${status}, received ${response.status}: ` +
      JSON.stringify(response.body)
  );
}

async function main() {
  assert.ok(
    adminConfig.TEST_ADMIN_USERNAME &&
    adminConfig.TEST_ADMIN_PASSWORD,
    "Missing Admin credentials in product-service/.env"
  );

  // Đăng nhập Admin thật qua Gateway.
  const adminLogin = await request(
    "POST",
    "/api/auth/login",
    {
      username: adminConfig.TEST_ADMIN_USERNAME,
      password: adminConfig.TEST_ADMIN_PASSWORD,
    }
  );

  expectStatus(adminLogin, 200);
  assert.ok(adminLogin.body.accessToken);
  adminToken = adminLogin.body.accessToken;

  // Tạo Customer thật.
  const customerInput = {
    username: `prohttp_${randomUUID()}`,
    password: "P@ss123",
  };

  expectStatus(
    await request("POST", "/api/auth/register", customerInput),
    201
  );

  const customerLogin = await request(
    "POST", "/api/auth/login", customerInput
  );

  expectStatus(customerLogin, 200);
  const customerToken = customerLogin.body.accessToken;
  assert.ok(customerToken);

  // 1. Admin tạo sản phẩm.
  const created = await request(
    "POST",
    "/api/products",
    {
      pname: "HTTP test laptop",
      price: 1500.50,
      quantity: 10,
    },
    adminToken
  );

  expectStatus(created, 201);
  const product = created.body;
  assert.ok(Number.isInteger(product.pid) && product.pid > 0);
  createdPids.add(product.pid);

  assert.equal(product.pname, "HTTP test laptop");
  assert.equal(product.price, 1500.5);
  assert.equal(typeof product.price, "number");
  assert.equal(product.quantity, 10);
  console.log("PASS: Admin creates product with 201");

  const endpoint = `/api/products/${product.pid}`;

  // 2. Xem danh sách.
  const list = await request(
    "GET", "/api/products", undefined, customerToken
  );

  expectStatus(list, 200);
  assert.ok(list.body.items.some((item) => item.pid === product.pid));
  console.log("PASS: Customer reads product list with 200");

  // 3. Xem chi tiết.
  const detail = await request(
    "GET", endpoint, undefined, customerToken
  );

  expectStatus(detail, 200);
  assert.deepEqual(detail.body, product);
  console.log("PASS: Customer reads product details with 200");

  // 4. Customer không được thêm, sửa, xóa.
  const forbiddenRequests = [
    ["POST", "/api/products", {
      pname: "Forbidden",
      price: 10,
      quantity: 1,
    }],
    ["PUT", endpoint, { quantity: 20 }],
    ["DELETE", endpoint, undefined],
  ];

  for (const [method, url, body] of forbiddenRequests) {
    expectStatus(
      await request(method, url, body, customerToken),
      403
    );
  }
  console.log("PASS: Customer write operations return 403");

  // 5. Thiếu JWT.
  expectStatus(
    await request("GET", endpoint),
    401
  );
  console.log("PASS: Missing token returns 401");

  // 6. JWT không hợp lệ.
  expectStatus(
    await request("GET", endpoint, undefined, "invalid-token"),
    401
  );
  console.log("PASS: Invalid token returns 401");

  // 7. Admin cập nhật và đọc lại.
  const updated = await request(
    "PUT",
    endpoint,
    {
      pname: "Updated HTTP laptop",
      price: 1700.25,
      quantity: 15,
    },
    adminToken
  );

  expectStatus(updated, 200);
  assert.equal(updated.body.pid, product.pid);
  assert.equal(updated.body.message, "Product updated successfully");

  const loaded = await request(
    "GET", endpoint, undefined, customerToken
  );

  expectStatus(loaded, 200);
  assert.equal(loaded.body.pname, "Updated HTTP laptop");
  assert.equal(loaded.body.price, 1700.25);
  assert.equal(loaded.body.quantity, 15);
  console.log("PASS: Admin update returns 200 and persists changes");

  // 8. Dữ liệu không hợp lệ.
  const invalidBodies = [
    { price: -1 },
    { quantity: 1.5 },
    { pname: "" },
    { pid: 999 },
    { price: "1500.50" },
  ];

  for (const body of invalidBodies) {
    expectStatus(
      await request("PUT", endpoint, body, adminToken),
      400
    );
  }
  console.log("PASS: Invalid data and PID modification return 400");

  // 9. PID trên URL không hợp lệ.
  expectStatus(
    await request(
      "GET", "/api/products/abc", undefined, customerToken
    ),
    400
  );
  console.log("PASS: Invalid URL PID returns 400");

  // 10. Số lượng 0 phải được giữ đúng qua gRPC.
  expectStatus(
    await request("PUT", endpoint, { quantity: 0 }, adminToken),
    200
  );

  const zeroStock = await request(
    "GET", endpoint, undefined, customerToken
  );

  expectStatus(zeroStock, 200);
  assert.equal(zeroStock.body.quantity, 0);
  assert.equal(zeroStock.body.price, 1700.25);
  console.log("PASS: Zero stock update preserves other fields");

  // 11. Admin xóa sản phẩm.
  const deleted = await request(
    "DELETE", endpoint, undefined, adminToken
  );

  expectStatus(deleted, 200);
  assert.equal(deleted.body.pid, product.pid);
  assert.equal(deleted.body.message, "Product deleted successfully");

  createdPids.delete(product.pid);
  console.log("PASS: Admin deletes product with 200");

  // 12. Đọc, sửa, xóa sản phẩm đã xóa.
  const missingRequests = [
    ["GET", undefined],
    ["PUT", { quantity: 1 }],
    ["DELETE", undefined],
  ];

  for (const [method, body] of missingRequests) {
    expectStatus(
      await request(method, endpoint, body, adminToken),
      404
    );
  }
  console.log("PASS: Missing product operations return 404");

  console.log("Product HTTP checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const pid of createdPids) {
      try {
        const result = await request(
          "DELETE",
          `/api/products/${pid}`,
          undefined,
          adminToken
        );

        if (![200, 404].includes(result.status)) {
          throw new Error(`Cleanup returned ${result.status}`);
        }
      } catch (err) {
        console.error("Test cleanup failed:", err.message);
        process.exitCode = 1;
      }
    }
  });