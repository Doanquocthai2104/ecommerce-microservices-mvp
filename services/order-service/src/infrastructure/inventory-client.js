const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const definition = protoLoader.loadSync(
  path.resolve(__dirname, "../../../../proto/inventory.proto"),
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }
);

const { InventoryService } =
  grpc.loadPackageDefinition(definition).inventory;

const serviceKey = process.env.ORDER_SERVICE_KEY;

if (
  typeof serviceKey !== "string" ||
  Buffer.byteLength(serviceKey, "utf8") < 32
) {
  throw new Error("ORDER_SERVICE_KEY must contain at least 32 bytes");
}

const client = new InventoryService(
  process.env.PRODUCT_GRPC_URL || "127.0.0.1:50053",
  grpc.credentials.createInsecure()
);

function callInventory(method, request) {
  if (!["reserve", "release", "commit"].includes(method)) {
    return Promise.reject(new Error("Unsupported inventory operation"));
  }

  const metadata = new grpc.Metadata();
  metadata.set("x-order-service-key", serviceKey);

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 5000) },
      (err, response) => {
        if (err) return reject(err);

        // Chuyển tên trường protobuf sang định dạng
        // mà phần tính giá của Order đang sử dụng.
        resolve({
          operationId: response.operationId,
          uid: response.uid,
          status: response.status,
          items: (response.items || []).map((item) => ({
            pid: item.pid,
            qty: item.qty,
            unit_price: item.unitPrice,
          })),
        });
      }
    );
  });
}

function closeInventoryClient() {
  client.close();
}

module.exports = {
  grpc,
  callInventory,
  closeInventoryClient,
};