const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { grpc, client, callAuth } = require("../src/auth-client");
const authenticate = require("../src/middleware/authenticate");
const requireRoles = require("../src/middleware/require-roles");

// Chạy middleware và nhận lỗi được chuyển vào next().
function invoke(middleware, req) {
  return new Promise((resolve, reject) => {
    try {
      const pending = middleware(req, {}, (err) => resolve(err));

      if (pending && typeof pending.catch === "function") {
        pending.catch(reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function main() {
  const input = {
    username: `mw_${randomUUID()}`,
    password: "P@ss123",
  };

  const registered = await callAuth("register", input);
  const loggedIn = await callAuth("login", input);

  // 1. Thiếu token
  let err = await invoke(authenticate, { headers: {} });
  assert.equal(err.code, grpc.status.UNAUTHENTICATED);
  console.log("PASS: Missing token rejected");

  // 2. Sai định dạng Authorization
  err = await invoke(authenticate, {
    headers: { authorization: "Basic abc" },
  });
  assert.equal(err.code, grpc.status.UNAUTHENTICATED);
  console.log("PASS: Invalid Authorization header rejected");

  // 3. Token không hợp lệ
  err = await invoke(authenticate, {
    headers: { authorization: "Bearer invalid-token" },
  });
  assert.equal(err.code, grpc.status.UNAUTHENTICATED);
  console.log("PASS: Invalid token rejected");

  // 4. Token hợp lệ: lấy danh tính qua Auth gRPC
  const req = {
    headers: {
      authorization: `Bearer ${loggedIn.accessToken}`,
    },
  };

  err = await invoke(authenticate, req);
  assert.equal(err, undefined);
  assert.deepEqual(req.user, {
    uid: registered.uid,
    role: "CUSTOMER",
  });
  console.log("PASS: Valid token populates req.user");

  // 5. Customer được phép vào chức năng dành cho Customer
  err = await invoke(requireRoles("CUSTOMER", "ADMIN"), req);
  assert.equal(err, undefined);
  console.log("PASS: Allowed role accepted");

  // 6. Customer không được vào chức năng dành cho Admin
  err = await invoke(requireRoles("ADMIN"), req);
  assert.equal(err.code, grpc.status.PERMISSION_DENIED);
  console.log("PASS: Customer cannot access admin operation");

  // 7. Phân quyền khi chưa xác thực
  err = await invoke(requireRoles("ADMIN"), {});
  assert.equal(err.code, grpc.status.UNAUTHENTICATED);
  console.log("PASS: Authorization requires authentication");

  console.log("Auth middleware checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => client.close());