const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../../../proto/auth.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const { AuthService } =
  grpc.loadPackageDefinition(definition).auth;

const client = new AuthService(
  process.env.AUTH_GRPC_URL || "127.0.0.1:50051",
  grpc.credentials.createInsecure()
);

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    client.verifyToken(
      { token },
      { deadline: new Date(Date.now() + 5000) },
      (err, identity) => {
        if (err) return reject(err);
        resolve(identity);
      }
    );
  });
}

function closeAuthClient() {
  client.close();
}

module.exports = {
  verifyToken,
  closeAuthClient,
};