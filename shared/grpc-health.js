const path = require("node:path");

function createGrpcHealth({
  grpc,
  protoLoader,
  serviceName,
  checkReady,
  isStopping = () => false,
  timeoutMs = 1500,
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

  async function check(call, callback) {
    const requestedService = call.request.service || "";

    if (
      !["", "live", serviceName].includes(requestedService)
    ) {
      return callback({
        code: grpc.status.NOT_FOUND,
        details: "Unknown health service",
      });
    }

    if (requestedService === "live") {
      return callback(null, { status: "SERVING" });
    }

    if (isStopping()) {
      return callback(null, { status: "NOT_SERVING" });
    }

    let timer;

    try {
      const ready = await Promise.race([
        Promise.resolve().then(checkReady),

        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);

      callback(null, {
        status: ready === true ? "SERVING" : "NOT_SERVING",
      });
    } catch {
      // Health response không lộ chi tiết kết nối database.
      callback(null, { status: "NOT_SERVING" });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    service: Health.service,
    handlers: { check },
  };
}

module.exports = createGrpcHealth;