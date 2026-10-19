const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../../../proto/product.proto"),
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

module.exports = { grpc, ProductService };