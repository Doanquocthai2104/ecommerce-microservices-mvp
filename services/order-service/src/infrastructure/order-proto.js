const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../../../proto/order.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const loaded = grpc.loadPackageDefinition(definition);

if (!loaded.order || !loaded.order.OrderService) {
  throw new Error(
    "order.proto must declare package order and service OrderService"
  );
}

const OrderService = loaded.order.OrderService;

module.exports = {
  grpc,
  OrderService,
};