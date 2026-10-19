const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../proto/auth.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const { AuthService } = grpc.loadPackageDefinition(definition).auth;

const client = new AuthService(
  process.env.AUTH_GRPC_URL || "127.0.0.1:50051",
  grpc.credentials.createInsecure()
);

function callAuth(method, request) {
  return new Promise((resolve, reject) => {
    client[method](
      request,
      { deadline: new Date(Date.now() + 10000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

module.exports = { grpc, client, callAuth };