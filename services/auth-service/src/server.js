const pool = require("./infrastructure/database");

const {
  grpc,
  AuthService,
} = require("./infrastructure/auth-proto");

const protoLoader = require("@grpc/proto-loader");

const createGrpcHealth = require(
  "../../../shared/grpc-health"
);

const UserRepository = require(
  "./infrastructure/user-repository"
);

const TokenService = require(
  "./infrastructure/token-service"
);

const RegisterUser = require("./application/register-user");
const LoginUser = require("./application/login-user");

const createAuthHandlers = require(
  "./interfaces/auth-handlers"
);

const server = new grpc.Server();

let stopping = false;
let cleanupTask = null;

async function main() {
  await pool.query("SELECT 1");

  const repository = new UserRepository();
  const tokenService = new TokenService(
    process.env.JWT_SECRET
  );

  server.addService(
    AuthService.service,
    createAuthHandlers({
      register: new RegisterUser(repository),
      login: new LoginUser(repository, tokenService),
      tokenService,
    })
  );

  const health = createGrpcHealth({
    grpc,
    protoLoader,
    serviceName: "auth.AuthService",
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
  const port = Number(process.env.GRPC_PORT || 50051);

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

  console.log(`Auth gRPC server listening on ${address}`);
  console.log("Auth health Check RPC registered");
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
    await pool.end();
  })();

  return cleanupTask;
}

const startupTask = main();

async function shutdown() {
  if (stopping) return;
  stopping = true;

  console.log("Stopping Auth Service...");

  try {
    await startupTask.catch(() => {});
    await cleanup();

    console.log("Auth Service stopped");
  } catch (err) {
    console.error("Auth shutdown failed:", err.message);
    process.exitCode = 1;
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startupTask.catch(async (err) => {
  console.error("Auth Service startup failed:", err.message);

  stopping = true;
  process.exitCode = 1;

  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("Auth cleanup failed:", cleanupError.message);
  }
});