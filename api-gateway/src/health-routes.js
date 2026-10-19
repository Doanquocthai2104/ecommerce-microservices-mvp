const path = require("node:path");
const express = require("express");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const redis = require("./redis-client");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../proto/health.proto"),
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

const services = [
  {
    name: "auth",
    address: process.env.AUTH_GRPC_URL || "127.0.0.1:50051",
    serviceName: "auth.AuthService",
  },
  {
    name: "customer",
    address:
      process.env.CUSTOMER_GRPC_URL || "127.0.0.1:50052",
    serviceName: "customer.CustomerService",
  },
  {
    name: "product",
    address:
      process.env.PRODUCT_GRPC_URL || "127.0.0.1:50053",
    serviceName: "product.ProductService",
  },
  {
    name: "order",
    address: process.env.ORDER_GRPC_URL || "127.0.0.1:50054",
    serviceName: "order.OrderService",
  },
  {
    name: "shipment",
    address:
      process.env.SHIPMENT_GRPC_URL || "127.0.0.1:50055",
    serviceName: "shipment.ShipmentService",
  },
].map((service) => ({
  ...service,
  client: new Health(
    service.address,
    grpc.credentials.createInsecure()
  ),
}));

const router = express.Router();

function checkService(service) {
  return new Promise((resolve) => {
    service.client.check(
      { service: service.serviceName },
      { deadline: new Date(Date.now() + 3500) },
      (err, response) => {
        resolve([
          service.name,
          !err && response?.status === "SERVING"
            ? "UP"
            : "DOWN",
        ]);
      }
    );
  });
}

async function checkRedis() {
  if (!redis.isReady) {
    return ["redis", "DOWN"];
  }

  let timer;

  try {
    const result = await Promise.race([
      redis.ping(),

      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Redis health timeout"));
        }, 1000);
      }),
    ]);

    return ["redis", result === "PONG" ? "UP" : "DOWN"];
  } catch {
    return ["redis", "DOWN"];
  } finally {
    clearTimeout(timer);
  }
}

router.get("/live", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    status: "UP",
    service: "api-gateway",
  });
});

router.get("/health", async (req, res, next) => {
  try {
    // Kiểm tra song song để không cộng dồn thời gian chờ.
    const results = await Promise.all([
      checkRedis(),
      ...services.map(checkService),
    ]);

    const checks = Object.fromEntries([
      ["gateway", "UP"],
      ...results,
    ]);

    const ready = Object.values(checks).every(
      (status) => status === "UP"
    );

    res.setHeader("Cache-Control", "no-store");

    res.status(ready ? 200 : 503).json({
      status: ready ? "UP" : "DOWN",
      checks,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;