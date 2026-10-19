const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../../../proto/shipment.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const loaded = grpc.loadPackageDefinition(definition);

if (!loaded.shipment?.ShipmentService) {
  throw new Error(
    "shipment.proto must declare package shipment and service ShipmentService"
  );
}

module.exports = {
  grpc,
  ShipmentService: loaded.shipment.ShipmentService,
};