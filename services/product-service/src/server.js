const {
  mongoose,
  connectDatabase,
  disconnectDatabase,
} = require("./infrastructure/database");

const {
  grpc,
  ProductService: ProductGrpcService,
} = require("./infrastructure/product-proto");

const {
  InventoryService,
} = require("./infrastructure/inventory-proto");

const protoLoader = require("@grpc/proto-loader");

const createGrpcHealth = require(
  "../../../shared/grpc-health"
);

const { AuthService } = require("./infrastructure/auth-proto");

const ProductRepository = require(
  "./infrastructure/product-repository"
);

const InventoryRepository = require(
  "./infrastructure/inventory-repository"
);

const ProductService = require(
  "./application/product-service"
);

const createProductHandlers = require(
  "./interfaces/product-handlers"
);

const createInventoryHandlers = require(
  "./interfaces/inventory-handlers"
);

const server = new grpc.Server();

let authClient = null;
let stopping = false;
let cleanupTask = null;

async function main() {
  await connectDatabase();

  const repository = new ProductRepository();
  const inventory = new InventoryRepository();

  await repository.initialize();
  await inventory.initialize();

  const service = new ProductService(repository);

  authClient = new AuthService(
    process.env.AUTH_GRPC_URL || "127.0.0.1:50051",
    grpc.credentials.createInsecure()
  );

  server.addService(
    ProductGrpcService.service,
    createProductHandlers(service, authClient)
  );

  server.addService(
    InventoryService.service,
    createInventoryHandlers(
      inventory,
      process.env.ORDER_SERVICE_KEY
    )
  );

  const health = createGrpcHealth({
    grpc,
    protoLoader,
    serviceName: "product.ProductService",
    isStopping: () => stopping,

    checkReady: async () => {
      if (
        mongoose.connection.readyState !== 1 ||
        !mongoose.connection.db
      ) {
        return false;
      }

      const hello = await mongoose.connection.db.command({
        hello: 1,
      });

      return (
        hello.isWritablePrimary === true &&
        hello.setName === "product-rs"
      );
    },
  });

  server.addService(health.service, health.handlers);

  const host = process.env.GRPC_HOST || "127.0.0.1";
  const port = Number(process.env.GRPC_PORT || 50053);

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

  console.log(`Product gRPC server listening on ${address}`);
  console.log("Inventory gRPC service registered");
  console.log("Product health Check RPC registered");
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
    await stopGrpc();

    if (authClient) {
      authClient.close();
    }

    await disconnectDatabase();
  })();

  return cleanupTask;
}

const startupTask = main();

async function shutdown() {
  if (stopping) return;
  stopping = true;

  console.log("Stopping Product Service...");

  try {
    await startupTask.catch(() => {});
    await cleanup();

    console.log("Product Service stopped");
  } catch (err) {
    console.error("Product shutdown failed:", err.message);
    process.exitCode = 1;
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startupTask.catch(async (err) => {
  console.error("Product Service startup failed:", err.message);

  stopping = true;
  process.exitCode = 1;

  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("Product cleanup failed:", cleanupError.message);
  }
});