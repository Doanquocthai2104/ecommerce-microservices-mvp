const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const baseUrl = "http://127.0.0.1:3000";

async function post(endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function main() {
  const suffix = randomUUID();

  const input = {
    username: `http_${suffix}`,
    password: "P@ss123",
    email: `http_${suffix}@example.com`,
    phone: "0900000000",
  };

  const registered = await post("/api/auth/register", input);
  assert.equal(registered.status, 201);
  assert.ok(registered.body.uid > 0);
  assert.equal(
    registered.body.message,
    "User registered successfully"
  );
  assert.equal(registered.body.password, undefined);
  console.log("PASS: Register returns 201");

  const duplicate = await post("/api/auth/register", input);
  assert.equal(duplicate.status, 409);
  console.log("PASS: Duplicate account returns 409");

  const missing = await post("/api/auth/register", {
    username: `missing_${suffix}`,
  });
  assert.equal(missing.status, 400);
  console.log("PASS: Missing password returns 400");

  const login = await post("/api/auth/login", {
    username: input.username,
    password: input.password,
  });
  assert.equal(login.status, 200);
  assert.equal(typeof login.body.accessToken, "string");
  assert.equal(login.body.tokenType, "Bearer");
  assert.equal(login.body.expiresIn, 3600);
  console.log("PASS: Login returns 200 and JWT");

  const wrong = await post("/api/auth/login", {
    username: input.username,
    password: "Wrong123",
  });
  assert.equal(wrong.status, 401);
  console.log("PASS: Wrong password returns 401");

  const wrongType = await post("/api/auth/register", {
    username: 123,
    password: "P@ss123",
  });
  assert.equal(wrongType.status, 400);
  console.log("PASS: Invalid field type returns 400");

  console.log("Auth HTTP checks completed successfully");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});