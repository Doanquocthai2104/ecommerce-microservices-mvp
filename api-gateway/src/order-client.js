const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../proto/order.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const { OrderService } =
  grpc.loadPackageDefinition(definition).order;

const client = new OrderService(
  process.env.ORDER_GRPC_URL || "127.0.0.1:50054",
  grpc.credentials.createInsecure()
);

function callOrder(method, request, authorization) {
  const metadata = new grpc.Metadata();

  if (typeof authorization === "string") {
    metadata.set("authorization", authorization);
  }

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 30000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

module.exports = {
  callOrder,
};