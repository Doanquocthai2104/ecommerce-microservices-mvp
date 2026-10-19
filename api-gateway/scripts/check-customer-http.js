const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { client, callAuth } = require("../src/auth-client");

const baseUrl = "http://127.0.0.1:3000";

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

async function createAccount() {
  const input = {
    username: `httpcus_${randomUUID()}`,
    password: "P@ss123",
  };

  const registered = await request(
    "POST",
    "/api/auth/register",
    input
  );
  expectStatus(registered, 201);

  const login = await request(
    "POST",
    "/api/auth/login",
    input
  );
  expectStatus(login, 200);
  assert.ok(login.body.accessToken);

  return {
    uid: registered.body.uid,
    token: login.body.accessToken,
    input,
  };
}

async function main() {
  const customer = await createAccount();
  const endpoint = `/api/customers/${customer.uid}`;

  // 1. Gateway tự tạo hồ sơ khi đăng nhập.
  const profile = await request(
    "GET", endpoint, undefined, customer.token
  );

  expectStatus(profile, 200);
  assert.equal(profile.body.uid, customer.uid);
  assert.equal(profile.body.fullname, customer.input.username);
  assert.ok(Number.isInteger(profile.body.mid));
  console.log("PASS: Login automatically creates Customer profile");

  // 2. Cập nhật và đọc lại.
  const updated = await request(
    "PUT",
    endpoint,
    { fullname: "Nguyen Van An" },
    customer.token
  );

  expectStatus(updated, 200);
  assert.equal(updated.body.uid, customer.uid);
  assert.equal(
    updated.body.message,
    "Customer updated successfully"
  );

  const loaded = await request(
    "GET", endpoint, undefined, customer.token
  );

  expectStatus(loaded, 200);
  assert.equal(loaded.body.fullname, "Nguyen Van An");
  assert.equal(loaded.body.mid, profile.body.mid);
  console.log("PASS: Customer updates own fullname");

  // 3. Đăng nhập lại không ghi đè họ tên.
  const relogin = await request(
    "POST", "/api/auth/login", customer.input
  );
  expectStatus(relogin, 200);

  const preserved = await request(
    "GET", endpoint, undefined, relogin.body.accessToken
  );

  expectStatus(preserved, 200);
  assert.equal(preserved.body.fullname, "Nguyen Van An");
  console.log("PASS: Repeated login preserves updated profile");

  // 4. Không có JWT.
  expectStatus(
    await request("GET", endpoint),
    401
  );
  console.log("PASS: Missing token returns 401");

  const other = await createAccount();

  // 5. Không được đọc hồ sơ người khác.
  expectStatus(
    await request("GET", endpoint, undefined, other.token),
    403
  );
  console.log("PASS: Reading another profile returns 403");

  // 6. Không được sửa hồ sơ người khác.
  expectStatus(
    await request(
      "PUT",
      endpoint,
      { fullname: "Unauthorized change" },
      other.token
    ),
    403
  );
  console.log("PASS: Updating another profile returns 403");

  // 7. Customer không được tự đổi hạng.
  expectStatus(
    await request(
      "PUT",
      endpoint,
      { mid: profile.body.mid },
      customer.token
    ),
    403
  );
  console.log("PASS: Customer membership update returns 403");

  // 8. Họ tên rỗng.
  expectStatus(
    await request(
      "PUT", endpoint, { fullname: "" }, customer.token
    ),
    400
  );
  console.log("PASS: Empty fullname returns 400");

  // 9. UID không hợp lệ.
  expectStatus(
    await request(
      "GET", "/api/customers/abc", undefined, customer.token
    ),
    400
  );
  console.log("PASS: Invalid UID returns 400");

  // 10. Không cho sửa score trực tiếp.
  expectStatus(
    await request(
      "PUT", endpoint, { score: 9999 }, customer.token
    ),
    400
  );
  console.log("PASS: Direct score update returns 400");

  // 11. Tạo tài khoản qua Auth trực tiếp để chưa có Customer.
  const missingInput = {
    username: `missing_${randomUUID()}`,
    password: "P@ss123",
  };

  const missingAccount = await callAuth("register", missingInput);
  const missingLogin = await callAuth("login", missingInput);

  expectStatus(
    await request(
      "GET",
      `/api/customers/${missingAccount.uid}`,
      undefined,
      missingLogin.accessToken
    ),
    404
  );
  console.log("PASS: Missing Customer profile returns 404");

  console.log("Customer HTTP checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => client.close());