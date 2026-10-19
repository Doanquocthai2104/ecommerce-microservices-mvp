const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../proto/shipment.proto"),
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
  throw new Error("ShipmentService is missing from shipment.proto");
}

const client = new loaded.shipment.ShipmentService(
  process.env.SHIPMENT_GRPC_URL || "127.0.0.1:50055",
  grpc.credentials.createInsecure()
);

function callShipment(
  method,
  request,
  authorization,
  timeoutMs = 10000
) {
  const metadata = new grpc.Metadata();

  if (typeof authorization === "string") {
    metadata.set("authorization", authorization);
  }

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + timeoutMs) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

module.exports = {
  callShipment,
};