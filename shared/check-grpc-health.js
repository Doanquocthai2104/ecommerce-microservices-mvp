const path = require("node:path");
const assert = require("node:assert/strict");

async function checkGrpcHealth({
  grpc,
  protoLoader,
  address,
  serviceName,
  expectedStatus = "SERVING",
}) {
  const definition = protoLoader.loadSync(
    path.resolve(__dirname, "../proto/health.proto"),
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

  const client = new Health(
    address,
    grpc.credentials.createInsecure()
  );

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

  try {
    const live = await check("live");

    assert.equal(live.status, "SERVING");
    console.log("PASS: Liveness responds without a JWT");

    const overall = await check("");

    assert.equal(overall.status, expectedStatus);
    console.log(
      `PASS: Overall readiness is ${expectedStatus}`
    );

    const service = await check(serviceName);

    assert.equal(service.status, expectedStatus);
    console.log(
      `PASS: ${serviceName} readiness is ${expectedStatus}`
    );

    await assert.rejects(
      () => check("unknown-service"),
      (err) => err.code === grpc.status.NOT_FOUND
    );

    console.log("PASS: Unknown health service returns NOT_FOUND");
    console.log("Health checks completed successfully");
  } finally {
    client.close();
  }
}

module.exports = checkGrpcHealth;