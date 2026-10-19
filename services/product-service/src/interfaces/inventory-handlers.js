const { createHash, timingSafeEqual } = require("node:crypto");
const { grpc } = require("../infrastructure/inventory-proto");
const AppError = require("../domain/app-error");

function hash(value) {
  return createHash("sha256").update(value).digest();
}

function createInventoryHandlers(inventory, serviceKey) {
  if (
    typeof serviceKey !== "string" ||
    Buffer.byteLength(serviceKey, "utf8") < 32
  ) {
    throw new Error("ORDER_SERVICE_KEY must contain at least 32 bytes");
  }

  const expectedHash = hash(serviceKey);

  function authenticateService(call) {
    const values = call.metadata.get("x-order-service-key");

    if (
      values.length !== 1 ||
      typeof values[0] !== "string" ||
      !timingSafeEqual(hash(values[0]), expectedHash)
    ) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid service credentials"
      );
    }
  }

  function toResponse(receipt) {
    return {
      operationId: receipt.operationId,
      uid: receipt.uid,
      status: receipt.status,
      items: receipt.items.map((item) => ({
        pid: item.pid,
        qty: item.qty,
        unitPrice: item.unit_price,
      })),
    };
  }

  function wrap(method) {
    return async (call, callback) => {
      try {
        authenticateService(call);

        const request = {
          operationId: call.request.operationId,
          uid: call.request.uid,
          items: (call.request.items || []).map((item) => ({
            pid: item.pid,
            qty: item.qty,
          })),
        };

        const receipt = await inventory[method](request);

        callback(null, toResponse(receipt));
      } catch (err) {
        const codes = {
          INVALID_INPUT: grpc.status.INVALID_ARGUMENT,
          INVALID_CREDENTIALS: grpc.status.UNAUTHENTICATED,
          NOT_FOUND: grpc.status.NOT_FOUND,
          CONFLICT: grpc.status.ALREADY_EXISTS,
          INSUFFICIENT_STOCK: grpc.status.FAILED_PRECONDITION,
        };

        if (
          err instanceof AppError &&
          codes[err.code] !== undefined
        ) {
          return callback({
            code: codes[err.code],
            details: err.message,
          });
        }

        console.error("Inventory gRPC error:", err.message);

        callback({
          code: grpc.status.INTERNAL,
          details: "Internal server error",
        });
      }
    };
  }

  return {
    reserve: wrap("reserve"),
    release: wrap("release"),
    commit: wrap("commit"),
  };
}

module.exports = createInventoryHandlers;