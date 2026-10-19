const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../../../proto/customer.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const { CustomerService } =
  grpc.loadPackageDefinition(definition).customer;

const client = new CustomerService(
  process.env.CUSTOMER_GRPC_URL || "127.0.0.1:50052",
  grpc.credentials.createInsecure()
);

function getMembership(uid, authorization) {
  const metadata = new grpc.Metadata();

  if (typeof authorization === "string" && authorization.length > 0) {
    metadata.set("authorization", authorization);
  }

  return new Promise((resolve, reject) => {
    client.getMembership(
      { uid },
      metadata,
      { deadline: new Date(Date.now() + 5000) },
      (err, response) => {
        if (err) return reject(err);

        if (
          response.uid !== uid ||
          !Number.isInteger(response.score) ||
          response.score < 0 ||
          response.score > 2147483647
        ) {
          return reject(
            new Error("Customer Service returned invalid membership data")
          );
        }

        resolve(response);
      }
    );
  });
}

function closeCustomerClient() {
  client.close();
}

module.exports = {
  grpc,
  getMembership,
  closeCustomerClient,
};