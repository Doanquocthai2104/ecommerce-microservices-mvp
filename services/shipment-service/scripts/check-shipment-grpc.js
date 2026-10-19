const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, randomInt } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const {
  grpc,
  ShipmentService,
} = require("../src/infrastructure/shipment-proto");

const {
  verifyToken,
  closeAuthClient,
} = require("../src/infrastructure/auth-client");

const Shipment = require("../src/infrastructure/shipment-model");

const ShipmentRepository = require(
  "../src/infrastructure/shipment-repository"
);

const projectRoot = path.resolve(__dirname, "../../..");
const gatewayUrl =
  process.env.GATEWAY_URL || "http://127.0.0.1:3000";

const client = new ShipmentService(
  process.env.SHIPMENT_GRPC_URL || "127.0.0.1:50055",
  grpc.credentials.createInsecure()
);

const repository = new ShipmentRepository();
const eventIds = [];

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
    `Unexpected HTTP ${response.status}: ${
      result.error || "Request failed"
    }`
  );

  return result;
}

async function createIdentity(role = "CUSTOMER") {
  assert.ok(
    ["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"].includes(role)
  );

  const username = `shp_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();

  const registered = await post(
    "/api/auth/register",
    { username, password },
    201
  );

  const uid = registered.uid;

  assert.ok(
    Number.isInteger(uid) &&
    uid > 0 &&
    uid <= 2147483647
  );

  if (role !== "CUSTOMER") {
    // uid đã kiểm tra là số nguyên; role nằm trong allowlist.
    execFileSync(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "auth-db",
        "psql",
        "-U",
        "auth_user",
        "-d",
        "auth_db",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `
        UPDATE public."User"
        SET roleid = (
          SELECT roleid
          FROM public."Role"
          WHERE rolename = '${role}'
        )
        WHERE uid = ${uid};
        `,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 30000,
      }
    );
  }

  // Đăng nhập sau khi cấp role để nhận JWT đúng quyền.
  const login = await post(
    "/api/auth/login",
    { username, password },
    200
  );

  const identity = await verifyToken(login.accessToken);

  assert.equal(identity.uid, uid);
  assert.equal(identity.role, role);

  return {
    uid,
    role,
    authorization: `Bearer ${login.accessToken}`,
  };
}

async function createFixture(uid) {
  let oid;

  do {
    oid = randomInt(1000000000, 2147483647);
  } while (await Shipment.exists({ oid }));

  const sourceEventId = randomUUID();
  eventIds.push(sourceEventId);

  return repository.ensureShipment({
    oid,
    uid,
    sourceEventId,
    eventHash: "a".repeat(64),
  });
}

function callShipment(method, request, authorization) {
  const metadata = new grpc.Metadata();

  if (authorization) {
    metadata.set("authorization", authorization);
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

async function expectGrpcError(action, expectedCode) {
  await assert.rejects(action, (err) => {
    assert.equal(
      err.code,
      expectedCode,
      `Expected gRPC ${expectedCode}, received ${err.code}: ${err.details}`
    );

    return true;
  });
}

async function main() {
  await connectDatabase();
  await repository.initialize();

  const customer = await createIdentity();
  const otherCustomer = await createIdentity();
  const staff = await createIdentity("SHIPMENT_STAFF");
  const admin = await createIdentity("ADMIN");

  console.log("PASS: Auth issues verified Customer, Staff and Admin identities");

  const fixture = await createFixture(customer.uid);
  const request = { shipid: fixture.shipid };

  await expectGrpcError(
    () => callShipment("getShipment", request),
    grpc.status.UNAUTHENTICATED
  );

  await expectGrpcError(
    () =>
      callShipment(
        "getShipment",
        request,
        "Bearer invalid-token"
      ),
    grpc.status.UNAUTHENTICATED
  );

  console.log("PASS: Missing and invalid JWT rejected");

  const own = await callShipment(
    "getShipment",
    request,
    customer.authorization
  );

  assert.equal(own.shipid, fixture.shipid);
  assert.equal(own.oid, fixture.oid);
  assert.equal(own.uid, customer.uid);
  assert.equal(own.status, "PENDING");

  console.log("PASS: Customer reads own shipment through gRPC");
  const byOrder = await callShipment(
    "getShipmentByOrder",
    { oid: fixture.oid },
    customer.authorization
  );

  assert.equal(byOrder.shipid, fixture.shipid);
  assert.equal(byOrder.oid, fixture.oid);
  assert.equal(byOrder.uid, customer.uid);

  await expectGrpcError(
    () =>
      callShipment(
        "getShipmentByOrder",
        { oid: fixture.oid },
        otherCustomer.authorization
      ),
    grpc.status.PERMISSION_DENIED
  );

  console.log("PASS: Lookup by order ID enforces shipment ownership");
  
  await expectGrpcError(
    () =>
      callShipment(
        "getShipment",
        request,
        otherCustomer.authorization
      ),
    grpc.status.PERMISSION_DENIED
  );

  console.log("PASS: Customer cannot read another customer's shipment");

  await expectGrpcError(
    () =>
      callShipment(
        "updateShipmentStatus",
        { ...request, status: "SHIPPING" },
        customer.authorization
      ),
    grpc.status.PERMISSION_DENIED
  );

  console.log("PASS: Customer cannot update shipment status");

  const staffRead = await callShipment(
    "getShipment",
    request,
    staff.authorization
  );

  assert.equal(staffRead.shipid, fixture.shipid);

  const shipping = await callShipment(
    "updateShipmentStatus",
    { ...request, status: "SHIPPING" },
    staff.authorization
  );

  assert.equal(shipping.status, "SHIPPING");

  console.log("PASS: Shipment Staff reads and updates shipment to SHIPPING");

  const repeated = await callShipment(
    "updateShipmentStatus",
    { ...request, status: "SHIPPING" },
    staff.authorization
  );

  assert.equal(repeated.shipid, fixture.shipid);
  assert.equal(repeated.status, "SHIPPING");

  console.log("PASS: Repeated status update returns the existing state");

  const adminRead = await callShipment(
    "getShipment",
    request,
    admin.authorization
  );

  assert.equal(adminRead.shipid, fixture.shipid);

  const delivered = await callShipment(
    "updateShipmentStatus",
    { ...request, status: "DELIVERED" },
    admin.authorization
  );

  assert.equal(delivered.status, "DELIVERED");

  console.log("PASS: Admin reads and updates shipment to DELIVERED");

  await expectGrpcError(
    () =>
      callShipment(
        "updateShipmentStatus",
        { ...request, status: "SHIPPING" },
        staff.authorization
      ),
    grpc.status.INVALID_ARGUMENT
  );

  console.log("PASS: Delivered shipment cannot return to SHIPPING");

  await expectGrpcError(
    () =>
      callShipment(
        "updateShipmentStatus",
        { ...request, status: "IN_TRANSIT" },
        staff.authorization
      ),
    grpc.status.INVALID_ARGUMENT
  );

  await expectGrpcError(
    () =>
      callShipment(
        "getShipment",
        { shipid: 0 },
        customer.authorization
      ),
    grpc.status.INVALID_ARGUMENT
  );

  console.log("PASS: Invalid status and shipment ID rejected");

  const missing = await createFixture(customer.uid);

  await Shipment.deleteOne({
    sourceEventId: missing.sourceEventId,
  });

  await expectGrpcError(
    () =>
      callShipment(
        "getShipment",
        { shipid: missing.shipid },
        customer.authorization
      ),
    grpc.status.NOT_FOUND
  );

  await expectGrpcError(
    () =>
      callShipment(
        "updateShipmentStatus",
        {
          shipid: missing.shipid,
          status: "SHIPPING",
        },
        staff.authorization
      ),
    grpc.status.NOT_FOUND
  );

  console.log("PASS: Missing shipment operations return NOT_FOUND");

  const cancellation = await createFixture(customer.uid);

  const cancelled = await callShipment(
    "updateShipmentStatus",
    {
      shipid: cancellation.shipid,
      status: "CANCELLED",
    },
    staff.authorization
  );

  assert.equal(cancelled.status, "CANCELLED");

  const persisted = await repository.findByShipid(
    cancellation.shipid
  );

  assert.equal(persisted.status, "CANCELLED");

  console.log("PASS: Cancellation is persisted in MongoDB");

  console.log("Shipment gRPC checks completed successfully");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    client.close();
    closeAuthClient();

    try {
      await Shipment.deleteMany({
        sourceEventId: { $in: eventIds },
      });
    } catch (err) {
      console.error("Cleanup failed:", err.message);
      process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});