const path = require("node:path");
const assert = require("node:assert/strict");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../../proto/health.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const loaded = grpc.loadPackageDefinition(definition);
const Health = loaded.grpc.health.v1.Health;

const address =
  process.env.HEALTH_GRPC_URL ||
  `127.0.0.1:${process.env.GRPC_PORT || 50051}`;

const client = new Health(
  address,
  grpc.credentials.createInsecure()
);

const databaseDown = process.argv.includes("--db-down");

function check(service) {
  return new Promise((resolve, reject) => {
    client.check(
      { service },
      { deadline: new Date(Date.now() + 3000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

async function main() {
  const live = await check("live");

  assert.equal(live.status, "SERVING");
  console.log("PASS: Liveness responds without a JWT");

  const expected =
    databaseDown ? "NOT_SERVING" : "SERVING";

  const overall = await check("");

  assert.equal(overall.status, expected);
  console.log(`PASS: Overall readiness is ${expected}`);

  const auth = await check("auth.AuthService");

  assert.equal(auth.status, expected);
  console.log(`PASS: Auth readiness is ${expected}`);

  await assert.rejects(
    () => check("unknown-service"),
    (err) => err.code === grpc.status.NOT_FOUND
  );

  console.log("PASS: Unknown health service returns NOT_FOUND");
  console.log("Auth health checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    client.close();
  });