const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const checkGrpcHealth = require(
  "../../../shared/check-grpc-health"
);

checkGrpcHealth({
  grpc: require("@grpc/grpc-js"),
  protoLoader: require("@grpc/proto-loader"),

  address:
    process.env.HEALTH_GRPC_URL ||
    `127.0.0.1:${process.env.GRPC_PORT || 50052}`,

  serviceName: "customer.CustomerService",

  expectedStatus: process.argv.includes("--db-down")
    ? "NOT_SERVING"
    : "SERVING",
}).catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});