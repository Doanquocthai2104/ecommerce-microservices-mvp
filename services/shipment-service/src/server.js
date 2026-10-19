const {
  mongoose,
  connectDatabase,
  disconnectDatabase,
} = require("./infrastructure/database");

const {
  grpc,
  ShipmentService: ShipmentGrpcService,
} = require("./infrastructure/shipment-proto");

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

const ShipmentRepository = require(
  "./infrastructure/shipment-repository"
);

const {
  RejectedMessageRepository,
} = require("./infrastructure/rejected-message-repository");

const ShipmentService = require(
  "./application/shipment-service"
);

const HandleOrderCreated = require(
  "./application/handle-order-created"
);

const ProcessOrderMessage = require(
  "./application/process-order-message"
);

const createOrderConsumer = require(
  "./infrastructure/order-consumer"
);

const createShipmentHandlers = require(
  "./interfaces/shipment-handlers"
);

const server = new grpc.Server();

const kafkaHealth = createKafkaReadiness({
  Kafka,

  brokers: (
    process.env.KAFKA_BROKERS || "127.0.0.1:9092"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),

  clientId: "shipment-health",
});

let orderConsumer = null;
let consumerReady = false;
let stopping = false;
let cleanupTask = null;

async function main() {
  await connectDatabase();
  console.log("Shipment Service connected to MongoDB");

  const repository = new ShipmentRepository();
  const rejectedMessages = new RejectedMessageRepository();

  await repository.initialize();
  await rejectedMessages.initialize();

  const service = new ShipmentService(repository);

  server.addService(
    ShipmentGrpcService.service,
    createShipmentHandlers({
      service,
      verifyToken,
    })
  );

  const health = createGrpcHealth({
    grpc,
    protoLoader,
    serviceName: "shipment.ShipmentService",
    timeoutMs: 2500,
    isStopping: () => stopping,

    checkReady: async () => {
      if (
        !consumerReady ||
        mongoose.connection.readyState !== 1 ||
        !mongoose.connection.db
      ) {
        return false;
      }

      const [mongo, kafkaReady] = await Promise.all([
        mongoose.connection.db.command({ ping: 1 }),
        kafkaHealth.check(),
      ]);

      return (
        mongo.ok === 1 &&
        kafkaReady &&
        consumerReady
      );
    },
  });

  server.addService(health.service, health.handlers);

  const processor = new ProcessOrderMessage({
    handler: new HandleOrderCreated(repository),
    rejectedMessages,
  });

  orderConsumer = createOrderConsumer({
    topic: "order-created",

    groupId:
      process.env.KAFKA_GROUP_ID || "shipment-service-v1",

    processor: {
      async execute(input) {
        const result = await processor.execute(input);

        if (result.status === "PROCESSED") {
          console.log(
            `Shipment stored: shipid=${result.shipid}, ` +
            `partition=${input.partition}, ` +
            `offset=${input.message.offset}`
          );
        }

        return result;
      },
    },
  });

  const consumer = orderConsumer.consumer;

  consumer.on(consumer.events.GROUP_JOIN, () => {
    if (!stopping) {
      consumerReady = true;
      console.log("Shipment consumer joined group");
    }
  });

  consumer.on(consumer.events.DISCONNECT, () => {
    consumerReady = false;
  });

  consumer.on(consumer.events.STOP, () => {
    consumerReady = false;
  });

  consumer.on(consumer.events.CRASH, ({ payload }) => {
    consumerReady = false;

    console.error(
      "Shipment consumer crashed:",
      payload.error?.message || "Unknown error",
      `restart=${payload.restart}`
    );

    if (!payload.restart) {
      process.exitCode = 1;

      void shutdown().catch((err) => {
        console.error("Shipment shutdown failed:", err.message);
        process.exitCode = 1;
      });
    }
  });

  const host = process.env.GRPC_HOST || "127.0.0.1";
  const port = Number(process.env.GRPC_PORT || 50055);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid GRPC_PORT");
  }

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

  await orderConsumer.start();

  if (stopping) return;

  console.log(`Shipment gRPC server listening on ${address}`);
  console.log("Shipment read and status update RPCs registered");
  console.log("Shipment health Check RPC registered");
  console.log("Shipment consumer started for topic: order-created");
  console.log(
    `Consumer group: ${
      process.env.KAFKA_GROUP_ID || "shipment-service-v1"
    }`
  );
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
    consumerReady = false;

    const results = await Promise.allSettled([
      stopGrpc(),
      orderConsumer
        ? orderConsumer.stop()
        : Promise.resolve(),
      kafkaHealth.close(),
    ]);

    closeAuthClient();
    await disconnectDatabase();

    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  })();

  return cleanupTask;
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  consumerReady = false;

  console.log("Stopping Shipment Service...");

  await startupTask.catch(() => {});
  await cleanup();

  console.log("Shipment Service stopped");
}

const startupTask = main();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown().catch((err) => {
      console.error("Shipment shutdown failed:", err.message);
      process.exitCode = 1;
    });
  });
}

startupTask.catch(async (err) => {
  console.error("Shipment Service startup failed:", err.message);

  stopping = true;
  process.exitCode = 1;

  try {
    await cleanup();
  } catch (cleanupError) {
    console.error(
      "Shipment cleanup failed:",
      cleanupError.message
    );
  }
});