const path = require("node:path");
const assert = require("node:assert/strict");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const baseUrl =
  process.env.GATEWAY_URL || "http://127.0.0.1:3000";

const names = [
  "gateway",
  "redis",
  "auth",
  "customer",
  "product",
  "order",
  "shipment",
];

async function get(endpoint) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    signal: AbortSignal.timeout(6000),
  });

  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

async function main() {
  const downArgument = process.argv.find(
    (argument) => argument.startsWith("--down=")
  );

  const downComponent = downArgument
    ? downArgument.slice("--down=".length)
    : null;

  if (downArgument) {
    assert.ok(
      names.includes(downComponent) &&
        downComponent !== "gateway",
      "Unknown component in --down argument"
    );
  }

  const expectDown =
    Boolean(downComponent) ||
    process.argv.includes("--not-ready");

  const live = await get("/api/live");

  assert.equal(live.status, 200);
  assert.equal(live.body.status, "UP");

  console.log("PASS: Gateway liveness returns 200 without JWT");

  const health = await get("/api/health");

  assert.equal(health.status, expectDown ? 503 : 200);
  assert.equal(health.body.status, expectDown ? "DOWN" : "UP");

  console.log(
    `PASS: Aggregate readiness returns ${expectDown ? 503 : 200}`
  );

  assert.deepEqual(
    Object.keys(health.body.checks).sort(),
    [...names].sort()
  );

  assert.equal(health.body.checks.gateway, "UP");

  assert.ok(
    Object.values(health.body.checks).every(
      (value) => ["UP", "DOWN"].includes(value)
    )
  );

  if (downComponent) {
    assert.equal(
      health.body.checks[downComponent],
      "DOWN"
    );
  } else if (expectDown) {
    assert.ok(
      Object.values(health.body.checks).includes("DOWN")
    );
  } else {
    assert.ok(
      Object.values(health.body.checks).every(
        (value) => value === "UP"
      )
    );
  }

  console.log(
    "PASS: Component statuses match the expected condition"
  );

  assert.ok(
    health.headers.get("cache-control")?.includes("no-store")
  );

  console.log("PASS: Health response disables caching");

  console.log(JSON.stringify(health.body, null, 2));
  console.log("Gateway health checks completed successfully");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});