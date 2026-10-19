const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { grpc, AuthService } = require("../src/infrastructure/auth-proto");

const client = new AuthService(
  "127.0.0.1:50051",
  grpc.credentials.createInsecure()
);

function call(method, request) {
  return new Promise((resolve, reject) => {
    client[method](
      request,
      { deadline: new Date(Date.now() + 10000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

async function main() {
  const input = {
    username: `grpc_${randomUUID()}`,
    password: "P@ss123",
  };

  const registered = await call("register", input);
  assert.ok(registered.uid > 0);
  console.log("PASS: Register via gRPC");

  const loggedIn = await call("login", input);
  assert.ok(loggedIn.accessToken);
  assert.equal(loggedIn.tokenType, "Bearer");
  assert.equal(loggedIn.expiresIn, 3600);
  console.log("PASS: Login via gRPC");

  const verified = await call("verifyToken", {
    token: loggedIn.accessToken,
  });
  assert.equal(verified.uid, registered.uid);
  assert.equal(verified.role, "CUSTOMER");
  console.log("PASS: VerifyToken via gRPC");

  await assert.rejects(
    () => call("register", input),
    { code: grpc.status.ALREADY_EXISTS }
  );
  console.log("PASS: Duplicate account returns ALREADY_EXISTS");

  await assert.rejects(
    () => call("register", { username: "missing_password" }),
    { code: grpc.status.INVALID_ARGUMENT }
  );
  console.log("PASS: Missing password returns INVALID_ARGUMENT");

  await assert.rejects(
    () => call("login", { ...input, password: "Wrong123" }),
    { code: grpc.status.UNAUTHENTICATED }
  );
  console.log("PASS: Wrong password returns UNAUTHENTICATED");

  await assert.rejects(
    () => call("verifyToken", { token: "invalid-token" }),
    { code: grpc.status.UNAUTHENTICATED }
  );
  console.log("PASS: Invalid token returns UNAUTHENTICATED");

  console.log("Auth gRPC checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => client.close());