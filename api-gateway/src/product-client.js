const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../proto/product.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const { ProductService } =
  grpc.loadPackageDefinition(definition).product;

const client = new ProductService(
  process.env.PRODUCT_GRPC_URL || "127.0.0.1:50053",
  grpc.credentials.createInsecure()
);

function callProduct(method, request, authorization) {
  const metadata = new grpc.Metadata();

  if (authorization) {
    metadata.set("authorization", authorization);
  }

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 10000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

module.exports = { client, callProduct };