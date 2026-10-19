// Load database configuration before creating upstream clients.
const pool = require("./infrastructure/database");

const {
  grpc,
  OrderService,
} = require("./infrastructure/order-proto");

const protoLoader = require("@grpc/proto-loader");
const { Kafka } = require("kafkajs");

const createGrpcHealth = require(
  "../../../shared/grpc-health"
);

const createKafkaReadiness = require(
  "../../../shared/kafka-readiness"
);

const {
  verifyToken,
  closeAuthClient,
} = require("./infrastructure/auth-client");

const {
  getMembership,
  closeCustomerClient,
} = require("./infrastructure/customer-client");

const {
  callInventory,
  closeInventoryClient,
} = require("./infrastructure/inventory-client");

const { producer } = require("./infrastructure/kafka-client");

const OrderRepository = require(
  "./infrastructure/order-repository"
);

const OrderRequestProgress = require(
  "./infrastructure/order-request-progress"
);

const OutboxPublisher = require(
  "./infrastructure/outbox-publisher"
);

const OrderPricing = require("./domain/order-pricing");
const CreateOrder = require("./application/create-order");

const OrderInventoryCoordinator = require(
  "./application/order-inventory-coordinator"
);

const OrderRecovery = require("./application/order-recovery");

const createOrderHandlers = require(
  "./interfaces/order-handlers"
);

const server = new grpc.Server();
const workers = [];

const kafkaHealth = createKafkaReadiness({
  Kafka,

  brokers: (
    process.env.KAFKA_BROKERS || "127.0.0.1:9092"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),

  clientId: "order-health",
});

let stopping = false;
let cleanupTask = null;

function closeClients() {
  closeAuthClient();
  closeCustomerClient();
  closeInventoryClient();
}

async function runWorker(worker) {
  if (stopping) return;

  worker.task = Promise.resolve()
    .then(() => worker.execute())
    .then((summary) => {
      if (
        summary.recovered > 0 ||
        summary.published > 0 ||
        summary.failed > 0
      ) {
        console.log(
          `${worker.name}: ${JSON.stringify(summary)}`
        );
      }
    })
    .catch((err) => {
      console.error(
        `${worker.name} loop failed:`,
        err.message
      );
    });

  await worker.task;
  worker.task = null;

  if (!stopping) {
    worker.timer = setTimeout(() => {
      void runWorker(worker);
    }, worker.intervalMs);
  }
}

async function main() {
  await pool.query("SELECT 1");

  if (!process.env.DISCOUNT_TIERS) {
    throw new Error("DISCOUNT_TIERS is required");
  }

  const pricing = new OrderPricing(
    JSON.parse(process.env.DISCOUNT_TIERS)
  );

  const orders = new OrderRepository();
  const requests = new OrderRequestProgress();

  const coordinator = new OrderInventoryCoordinator({
    requests,
    orders,
    callInventory,
  });

  const createOrder = new CreateOrder({
    requests,
    orders,
    pricing,
    getMembership,
    callInventory,
    coordinator,
  });

  const recovery = new OrderRecovery({
    pool,
    coordinator,
    pendingTimeoutMs: 300000,
    retryDelayMs: 10000,
    batchSize: 25,
  });

  const outbox = new OutboxPublisher({
    pool,
    producer,
    batchSize: 10,
  });

  const health = createGrpcHealth({
    grpc,
    protoLoader,
    serviceName: "order.OrderService",
    timeoutMs: 2500,
    isStopping: () => stopping,

    checkReady: async () => {
      const [, kafkaReady] = await Promise.all([
        pool.query({
          text: "SELECT 1",
          query_timeout: 1000,
        }),
        kafkaHealth.check(),
      ]);

      return kafkaReady;
    },
  });

  server.addService(
    health.service,
    health.handlers
  );

  server.addService(
    OrderService.service,
    createOrderHandlers({
      createOrder,
      orders,
      verifyToken,
    })
  );

  const host = process.env.GRPC_HOST || "127.0.0.1";
  const port = Number(process.env.GRPC_PORT || 50054);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid GRPC_PORT");
  }

  if (stopping) return;

  await producer.connect();
  console.log("Order Service connected to Kafka");

  if (stopping) return;

  const address = `${host}:${port}`;

  await new Promise((resolve, reject) => {
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });

  if (stopping) return;

  workers.push(
    {
      name: "Order recovery",
      intervalMs: 10000,
      timer: null,
      task: null,

      execute: () =>
        recovery.runOnce(null, () => stopping),
    },
    {
      name: "Outbox publisher",
      intervalMs: 2000,
      timer: null,
      task: null,

      execute: async () => {
        await producer.connect();

        if (stopping) {
          return {
            skipped: true,
            published: 0,
            failed: 0,
          };
        }

        return outbox.runOnce(null, () => stopping);
      },
    }
  );

  console.log(`Order gRPC server listening on ${address}`);
  console.log("Order creation, list and detail RPCs registered");
  console.log("Order health Check RPC registered");
  console.log("Order recovery worker started (interval: 10 seconds)");
  console.log("Outbox publisher started (interval: 2 seconds)");

  for (const worker of workers) {
    void runWorker(worker);
  }
}

function stopGrpc() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.forceShutdown();
      resolve();
    }, 10000);

    server.tryShutdown(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function cleanup() {
  if (cleanupTask) return cleanupTask;

  cleanupTask = (async () => {
    for (const worker of workers) {
      if (worker.timer) {
        clearTimeout(worker.timer);
        worker.timer = null;
      }
    }

    await Promise.all([
      stopGrpc(),
      ...workers.map(
        (worker) => worker.task || Promise.resolve()
      ),
    ]);

    await kafkaHealth.close();

    closeClients();

    try {
      await producer.disconnect();
    } finally {
      await pool.end();
    }
  })();

  return cleanupTask;
}

const startupTask = main();

async function shutdown() {
  if (stopping) return;
  stopping = true;

  console.log("Stopping Order Service...");

  try {
    await startupTask.catch(() => {});
    await cleanup();

    console.log("Order Service stopped");
  } catch (err) {
    console.error("Order shutdown failed:", err.message);
    process.exitCode = 1;
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startupTask.catch(async (err) => {
  console.error("Order Service startup failed:", err.message);

  stopping = true;
  process.exitCode = 1;

  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("Order cleanup failed:", cleanupError.message);
  }
});