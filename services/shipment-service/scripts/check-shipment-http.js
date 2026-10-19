const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, randomInt } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Shipment = require("../src/infrastructure/shipment-model");

const ShipmentRepository = require(
  "../src/infrastructure/shipment-repository"
);

const projectRoot = path.resolve(__dirname, "../../..");

const baseUrl =
  process.env.GATEWAY_URL || "http://127.0.0.1:3000";

const repository = new ShipmentRepository();
const eventIds = [];

async function http(method, endpoint, options = {}) {
  const headers = {};

  if (options.authorization) {
    headers.Authorization = options.authorization;
  }

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15000),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function expectStatus(result, expected) {
  assert.equal(
    result.status,
    expected,
    `Expected HTTP ${expected}, received ${result.status}: ${
      result.body.error || "Unexpected response"
    }`
  );
}

async function createIdentity(role = "CUSTOMER") {
  assert.ok(
    ["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"].includes(role)
  );

  const username = `shphttp_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();

  const registered = await http("POST", "/api/auth/register", {
    body: { username, password },
  });

  expectStatus(registered, 201);

  const uid = registered.body.uid;

  assert.ok(
    Number.isInteger(uid) &&
    uid > 0 &&
    uid <= 2147483647
  );

  if (role !== "CUSTOMER") {
    // Chỉ dùng để cấp quyền cho tài khoản thử nghiệm local.
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

  const login = await http("POST", "/api/auth/login", {
    body: { username, password },
  });

  expectStatus(login, 200);
  assert.equal(typeof login.body.accessToken, "string");

  return {
    uid,
    authorization: `Bearer ${login.body.accessToken}`,
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

async function main() {
  await connectDatabase();
  await repository.initialize();

  const customer = await createIdentity();
  const otherCustomer = await createIdentity();
  const staff = await createIdentity("SHIPMENT_STAFF");
  const admin = await createIdentity("ADMIN");

  const fixture = await createFixture(customer.uid);
  const endpoint = `/api/shipments/${fixture.shipid}`;

  const own = await http("GET", endpoint, {
    authorization: customer.authorization,
  });

  expectStatus(own, 200);

  assert.deepEqual(own.body, {
    shipid: fixture.shipid,
    oid: fixture.oid,
    status: "PENDING",
  });

  console.log("PASS: Customer reads own shipment with 200 and documented response");

  const forbidden = await http("GET", endpoint, {
    authorization: otherCustomer.authorization,
  });

  expectStatus(forbidden, 403);

  console.log("PASS: Another customer receives 403");

  const missingToken = await http("GET", endpoint);
  expectStatus(missingToken, 401);

  const invalidToken = await http("GET", endpoint, {
    authorization: "Bearer invalid-token",
  });

  expectStatus(invalidToken, 401);

  const missingUpdateToken = await http(
    "PATCH",
    `${endpoint}/status`,
    { body: { status: "SHIPPING" } }
  );

  expectStatus(missingUpdateToken, 401);

  console.log("PASS: Missing or invalid JWT returns 401");

  const customerUpdate = await http(
    "PATCH",
    `${endpoint}/status`,
    {
      authorization: customer.authorization,
      body: { status: "SHIPPING" },
    }
  );

  expectStatus(customerUpdate, 403);

  console.log("PASS: Customer cannot update shipment status");

  const staffRead = await http("GET", endpoint, {
    authorization: staff.authorization,
  });

  expectStatus(staffRead, 200);

  const shipping = await http(
    "PATCH",
    `${endpoint}/status`,
    {
      authorization: staff.authorization,
      body: { status: "SHIPPING" },
    }
  );

  expectStatus(shipping, 200);
  assert.equal(shipping.body.status, "SHIPPING");

  console.log("PASS: Staff reads and updates shipment to SHIPPING with 200");

  const repeated = await http(
    "PATCH",
    `${endpoint}/status`,
    {
      authorization: staff.authorization,
      body: { status: "SHIPPING" },
    }
  );

  expectStatus(repeated, 200);
  assert.deepEqual(repeated.body, shipping.body);

  console.log("PASS: Repeated status update returns the same result");

  const adminRead = await http("GET", endpoint, {
    authorization: admin.authorization,
  });

  expectStatus(adminRead, 200);

  const delivered = await http(
    "PATCH",
    `${endpoint}/status`,
    {
      authorization: admin.authorization,
      body: { status: "DELIVERED" },
    }
  );

  expectStatus(delivered, 200);
  assert.equal(delivered.body.status, "DELIVERED");

  console.log("PASS: Admin reads and updates shipment to DELIVERED");

  const reverse = await http(
    "PATCH",
    `${endpoint}/status`,
    {
      authorization: staff.authorization,
      body: { status: "SHIPPING" },
    }
  );

  expectStatus(reverse, 400);

  console.log("PASS: Reversing a terminal status returns 400");

  const invalidBodies = [
    {},
    null,
    [],
    { status: 1 },
    { status: "IN_TRANSIT" },
    { status: "shipping" },
    { status: "SHIPPING", uid: otherCustomer.uid },
    { status: "SHIPPING", oid: fixture.oid },
  ];

  for (const body of invalidBodies) {
    const result = await http(
      "PATCH",
      `${endpoint}/status`,
      {
        authorization: staff.authorization,
        body,
      }
    );

    expectStatus(result, 400);
  }

  for (const id of ["0", "-1", "abc", "2147483648"]) {
    const result = await http(
      "GET",
      `/api/shipments/${id}`,
      { authorization: customer.authorization }
    );

    expectStatus(result, 400);
  }

  console.log("PASS: Invalid bodies, extra fields and URL IDs return 400");

  const missing = await createFixture(customer.uid);

  await Shipment.deleteOne({
    sourceEventId: missing.sourceEventId,
  });

  const missingRead = await http(
    "GET",
    `/api/shipments/${missing.shipid}`,
    { authorization: customer.authorization }
  );

  expectStatus(missingRead, 404);

  const missingUpdate = await http(
    "PATCH",
    `/api/shipments/${missing.shipid}/status`,
    {
      authorization: staff.authorization,
      body: { status: "SHIPPING" },
    }
  );

  expectStatus(missingUpdate, 404);

  console.log("PASS: Missing shipment read and update return 404");

  const cancellation = await createFixture(customer.uid);

  const cancelled = await http(
    "PATCH",
    `/api/shipments/${cancellation.shipid}/status`,
    {
      authorization: staff.authorization,
      body: { status: "CANCELLED" },
    }
  );

  expectStatus(cancelled, 200);
  assert.equal(cancelled.body.status, "CANCELLED");

  const cancelledAgain = await http(
    "PATCH",
    `/api/shipments/${cancellation.shipid}/status`,
    {
      authorization: staff.authorization,
      body: { status: "CANCELLED" },
    }
  );

  expectStatus(cancelledAgain, 200);

  console.log("PASS: Cancellation and repeated cancellation return 200");

  const persisted = await repository.findByShipid(
    fixture.shipid
  );

  assert.equal(persisted.uid, customer.uid);
  assert.equal(persisted.oid, fixture.oid);
  assert.equal(persisted.status, "DELIVERED");

  const customerFinalRead = await http("GET", endpoint, {
    authorization: customer.authorization,
  });

  expectStatus(customerFinalRead, 200);
  assert.equal(customerFinalRead.body.status, "DELIVERED");

  console.log("PASS: Customer observes persisted status and rejected requests preserve identity");

  console.log("Shipment HTTP checks completed successfully");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
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