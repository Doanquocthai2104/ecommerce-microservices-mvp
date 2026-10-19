const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  grpc,
  getMembership,
  closeCustomerClient,
} = require("../src/infrastructure/customer-client");

const gatewayUrl =
  process.env.GATEWAY_URL || "http://127.0.0.1:3000";

async function post(endpoint, body, expectedStatus) {
  const response = await fetch(`${gatewayUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const result = await response.json();

  assert.equal(
    response.status,
    expectedStatus,
    `Unexpected HTTP status: ${response.status}; ${
      result.error || "Request failed"
    }`
  );

  return result;
}

async function expectGrpcError(action, expectedCode) {
  await assert.rejects(action, (err) => {
    assert.equal(
      err.code,
      expectedCode,
      `Expected gRPC code ${expectedCode}, received ${err.code}: ${err.details}`
    );

    return true;
  });
}

async function main() {
  const username = `order_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();

  const registered = await post(
    "/api/auth/register",
    { username, password },
    201
  );

  assert.ok(
    Number.isInteger(registered.uid) && registered.uid > 0,
    "Registration must return a valid UID"
  );

  // Gateway tự tạo Customer profile khi CUSTOMER đăng nhập.
  const login = await post(
    "/api/auth/login",
    { username, password },
    200
  );

  assert.equal(typeof login.accessToken, "string");
  assert.ok(login.accessToken.length > 0);

  const uid = registered.uid;
  const authorization = `Bearer ${login.accessToken}`;

  const membership = await getMembership(uid, authorization);

  assert.equal(membership.uid, uid);
  assert.equal(membership.mname, "BASIC");

  console.log("PASS: Order client reads membership using a real customer JWT");

  assert.equal(membership.score, 0);
  assert.ok(Number.isInteger(membership.mid) && membership.mid > 0);

  console.log("PASS: New customer receives BASIC membership with score zero");

  await expectGrpcError(
    () => getMembership(uid),
    grpc.status.UNAUTHENTICATED
  );

  console.log("PASS: Missing JWT cannot read membership");

  await expectGrpcError(
    () => getMembership(uid, "Bearer invalid-token"),
    grpc.status.UNAUTHENTICATED
  );

  console.log("PASS: Invalid JWT cannot read membership");

  const anotherUid = uid === 2147483647 ? uid - 1 : uid + 1;

  await expectGrpcError(
    () => getMembership(anotherUid, authorization),
    grpc.status.PERMISSION_DENIED
  );

  console.log("PASS: Customer cannot read another UID membership");

  console.log("Order Customer client checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    closeCustomerClient();
  });