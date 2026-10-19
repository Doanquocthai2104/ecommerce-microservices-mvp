const pool = require("./infrastructure/database");

const {
  grpc,
  CustomerService: CustomerGrpcService,
} = require("./infrastructure/customer-proto");

const protoLoader = require("@grpc/proto-loader");

const createGrpcHealth = require(
  "../../../shared/grpc-health"
);

const { AuthService } = require("./infrastructure/auth-proto");

const CustomerRepository = require(
  "./infrastructure/customer-repository"
);

const CustomerService = require(
  "./application/customer-service"
);

const createCustomerHandlers = require(
  "./interfaces/customer-handlers"
);

const server = new grpc.Server();

let authClient = null;
let stopping = false;
let cleanupTask = null;

async function main() {
  await pool.query("SELECT 1");

  authClient = new AuthService(
    process.env.AUTH_GRPC_URL || "127.0.0.1:50051",
    grpc.credentials.createInsecure()
  );

  const service = new CustomerService(
    new CustomerRepository()
  );

  server.addService(
    CustomerGrpcService.service,
    createCustomerHandlers(service, authClient)
  );

  const health = createGrpcHealth({
    grpc,
    protoLoader,
    serviceName: "customer.CustomerService",
    isStopping: () => stopping,

    checkReady: async () => {
      await pool.query({
        text: "SELECT 1",
        query_timeout: 1000,
      });

      return true;
    },
  });

  server.addService(health.service, health.handlers);

  const host = process.env.GRPC_HOST || "127.0.0.1";
  const port = Number(process.env.GRPC_PORT || 50052);

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

  console.log(`Customer gRPC server listening on ${address}`);
  console.log("Customer health Check RPC registered");
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

    await pool.end();
  })();

  return cleanupTask;
}

const startupTask = main();

async function shutdown() {
  if (stopping) return;
  stopping = true;

  console.log("Stopping Customer Service...");

  try {
    await startupTask.catch(() => {});
    await cleanup();

    console.log("Customer Service stopped");
  } catch (err) {
    console.error("Customer shutdown failed:", err.message);
    process.exitCode = 1;
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startupTask.catch(async (err) => {
  console.error("Customer Service startup failed:", err.message);

  stopping = true;
  process.exitCode = 1;

  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("Customer cleanup failed:", cleanupError.message);
  }
});