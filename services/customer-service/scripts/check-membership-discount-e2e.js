const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const pool = require("../src/infrastructure/database");
const CustomerRepository = require(
  "../src/infrastructure/customer-repository"
);

const repository = new CustomerRepository();

const projectRoot = path.resolve(__dirname, "../../..");
const baseUrl =
  process.env.GATEWAY_URL || "http://127.0.0.1:3000";

const scenarios = [
  { name: "BASIC", score: 0, discount: 0 },
  { name: "SILVER", score: 100, discount: 5 },
  { name: "GOLD", score: 500, discount: 10 },
  { name: "PLATINUM", score: 1000, discount: 15 },
];

async function http(method, endpoint, options = {}) {
  const headers = {};

  if (options.authorization) {
    headers.Authorization = options.authorization;
  }

  if (options.key) {
    headers["Idempotency-Key"] = options.key;
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
    signal: AbortSignal.timeout(40000),
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
  assert.ok(["CUSTOMER", "ADMIN"].includes(role));

  const username = `member_${randomUUID().replaceAll("-", "")}`;
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

  if (role === "ADMIN") {
    // Bootstrap tài khoản kiểm thử local.
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
          WHERE rolename = 'ADMIN'
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

async function main() {
  const membershipResult = await pool.query(
    `
    SELECT mid, mname, score
    FROM public."MemberShip"
    WHERE mname = ANY($1::varchar[])
    `,
    [scenarios.map((item) => item.name)]
  );

  const memberships = new Map(
    membershipResult.rows.map((item) => [
      item.mname,
      item,
    ])
  );

  for (const scenario of scenarios) {
    const membership = memberships.get(scenario.name);

    assert.ok(
      membership,
      `Missing membership ${scenario.name}`
    );

    assert.equal(membership.score, scenario.score);
  }

  const customer = await createIdentity();
  const admin = await createIdentity("ADMIN");

  const initialProfile = await repository.findByUid(
    customer.uid
  );

  assert.equal(initialProfile.mname, "BASIC");
  assert.equal(initialProfile.score, 0);

  console.log("PASS: New customer starts with BASIC membership and score zero");

  const unauthorizedMembership = await http(
    "PUT",
    `/api/customers/${customer.uid}`,
    {
      authorization: customer.authorization,
      body: {
        mid: memberships.get("PLATINUM").mid,
      },
    }
  );

  expectStatus(unauthorizedMembership, 403);

  const directScore = await http(
    "PUT",
    `/api/customers/${customer.uid}`,
    {
      authorization: customer.authorization,
      body: { score: 1000 },
    }
  );

  expectStatus(directScore, 400);

  console.log("PASS: Customer cannot change membership or submit a direct score");

  const product = await http("POST", "/api/products", {
    authorization: admin.authorization,
    body: {
      pname: `Membership E2E ${randomUUID()}`,
      price: 100,
      quantity: 10,
    },
  });

  expectStatus(product, 201);

  const pid = product.body.pid;
  assert.ok(Number.isInteger(pid) && pid > 0);

  const orderBody = {
    items: [{ pid, qty: 1 }],
  };

  const results = [];

  for (const scenario of scenarios) {
    const membership = memberships.get(scenario.name);

    const assigned = await http(
      "PUT",
      `/api/customers/${customer.uid}`,
      {
        authorization: admin.authorization,
        body: { mid: membership.mid },
      }
    );

    expectStatus(assigned, 200);

    const profile = await repository.findByUid(customer.uid);

    assert.equal(profile.mid, membership.mid);
    assert.equal(profile.mname, scenario.name);
    assert.equal(profile.score, scenario.score);

    const requestId = randomUUID();

    const order = await http("POST", "/api/orders", {
      authorization: customer.authorization,
      key: requestId,
      body: orderBody,
    });

    expectStatus(order, 201);

    assert.equal(order.body.uid, customer.uid);
    assert.equal(order.body.subtotal, 100);
    assert.equal(order.body.discount, scenario.discount);
    assert.equal(
      order.body.total_amount,
      100 - scenario.discount
    );

    results.push({
      membership: scenario.name,
      mid: membership.mid,
      score: scenario.score,
      oid: order.body.oid,
      discount: order.body.discount,
      total: order.body.total_amount,
      requestId,
    });

    console.log(
      `PASS: Admin assigns ${scenario.name} and order receives ${scenario.discount}% discount`
    );
  }

  // Customer hiện đã là PLATINUM.
  // Gửi lại yêu cầu SILVER cũ phải giữ đơn và discount cũ.
  const silverOrder = results.find(
    (item) => item.membership === "SILVER"
  );

  const replay = await http("POST", "/api/orders", {
    authorization: customer.authorization,
    key: silverOrder.requestId,
    body: orderBody,
  });

  expectStatus(replay, 201);
  assert.equal(replay.body.oid, silverOrder.oid);
  assert.equal(replay.body.discount, 5);
  assert.equal(replay.body.total_amount, 95);

  const stock = await http("GET", `/api/products/${pid}`, {
    authorization: customer.authorization,
  });

  expectStatus(stock, 200);
  assert.equal(stock.body.quantity, 6);

  console.log("PASS: Membership change does not alter replayed order or deduct stock again");

  for (const result of results) {
    const storedOrder = await http(
      "GET",
      `/api/orders/${result.oid}`,
      { authorization: customer.authorization }
    );

    expectStatus(storedOrder, 200);
    assert.equal(storedOrder.body.discount, result.discount);
    assert.equal(storedOrder.body.total_amount, result.total);
  }

  console.log("PASS: Previously stored orders retain their original discounts");

  const unusedIdResult = await pool.query(`
    SELECT COALESCE(MAX(mid), 0) + 1 AS mid
    FROM public."MemberShip"
  `);

  const unusedMid = unusedIdResult.rows[0].mid;

  assert.ok(
    Number.isInteger(unusedMid) &&
    unusedMid > 0 &&
    unusedMid <= 2147483647
  );

  const invalidMembership = await http(
    "PUT",
    `/api/customers/${customer.uid}`,
    {
      authorization: admin.authorization,
      body: { mid: unusedMid },
    }
  );

  expectStatus(invalidMembership, 400);

  const finalProfile = await repository.findByUid(
    customer.uid
  );

  assert.equal(finalProfile.mname, "PLATINUM");
  assert.equal(finalProfile.score, 1000);

  console.log("PASS: Unknown membership is rejected without changing the profile");

  console.table(
    results.map(({ requestId, ...result }) => result)
  );

  console.log(`Customer UID: ${customer.uid}`);
  console.log(`Product PID: ${pid}`);
  console.log("Membership discount E2E checks completed successfully");
  console.log("E2E records are retained for inspection.");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});