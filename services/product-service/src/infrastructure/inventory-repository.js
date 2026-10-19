const { createHash } = require("node:crypto");
const { mongoose } = require("./database");
const Product = require("./product-model");
const StockOperation = require("./stock-operation-model");
const AppError = require("../domain/app-error");

function invalid(message) {
  throw new AppError("INVALID_INPUT", message);
}

function normalizeRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("Invalid inventory request");
  }

  const { operationId, uid, items } = input;

  if (
    typeof operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(operationId)
  ) {
    invalid("Operation ID must be a UUID");
  }

  if (
    !Number.isInteger(uid) ||
    uid <= 0 ||
    uid > 2147483647
  ) {
    invalid("Invalid customer UID");
  }

  if (!Array.isArray(items) || items.length === 0) {
    invalid("Inventory request must contain items");
  }

  const seen = new Set();

  const requestItems = items.map((item) => {
    if (
      !item ||
      !Number.isInteger(item.pid) ||
      item.pid <= 0 ||
      item.pid > 2147483647 ||
      !Number.isInteger(item.qty) ||
      item.qty <= 0 ||
      item.qty > 2147483647
    ) {
      invalid("Invalid product ID or quantity");
    }

    if (seen.has(item.pid)) {
      invalid("Each product must appear only once");
    }

    seen.add(item.pid);

    return {
      pid: item.pid,
      qty: item.qty,
    };
  }).sort((a, b) => a.pid - b.pid);

  const requestHash = createHash("sha256")
    .update(JSON.stringify({ uid, items: requestItems }))
    .digest("hex");

  return {
    operationId: operationId.toLowerCase(),
    uid,
    requestItems,
    requestHash,
  };
}

function toReceipt(operation) {
  return {
    operationId: operation._id,
    uid: operation.uid,
    status: operation.status,
    items: operation.items.map((item) => ({
      pid: item.pid,
      qty: item.qty,
      unit_price: item.unit_price,
    })),
  };
}

function readExisting(operation, request) {
  if (
    operation.uid !== request.uid ||
    operation.requestHash !== request.requestHash
  ) {
    throw new AppError(
      "CONFLICT",
      "Operation ID was already used for another request"
    );
  }

  if (operation.status === "RELEASED") {
    throw new AppError(
      "CONFLICT",
      "Inventory operation was already cancelled"
    );
  }

  return toReceipt(operation);
}

class InventoryRepository {
  async initialize() {
    await Promise.all([
      Product.init(),
      StockOperation.init(),
    ]);
  }

  async reserve(input) {
    const request = normalizeRequest(input);

    try {
      return await mongoose.connection.transaction(
        async (session) => {
          const existing = await StockOperation.findById(
            request.operationId
          ).session(session).lean();

          if (existing) {
            return readExisting(existing, request);
          }

          const snapshots = [];

          // Thực hiện tuần tự trong cùng transaction.
          for (const item of request.requestItems) {
            const product = await Product.findOneAndUpdate(
              {
                pid: item.pid,
                quantity: { $gte: item.qty },
              },
              {
                $inc: { quantity: -item.qty },
              },
              {
                session,
                returnDocument: "after",
              }
            ).lean();

            if (!product) {
              const exists = await Product.exists({
                pid: item.pid,
              }).session(session);

              if (!exists) {
                throw new AppError(
                  "NOT_FOUND",
                  `Product ${item.pid} not found`
                );
              }

              throw new AppError(
                "INSUFFICIENT_STOCK",
                `Insufficient stock for product ${item.pid}`
              );
            }

            snapshots.push({
              pid: product.pid,
              qty: item.qty,
              unit_price: product.price.toString(),
            });
          }

          const [operation] = await StockOperation.create(
            [{
              _id: request.operationId,
              uid: request.uid,
              requestHash: request.requestHash,
              requestItems: request.requestItems,
              items: snapshots,
              status: "RESERVED",
            }],
            { session }
          );

          return toReceipt(operation);
        },
        {
          readPreference: "primary",
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
        }
      );
    } catch (err) {
      // Hai request cùng mã có thể cạnh tranh tạo bản ghi.
      // Transaction thua đã rollback trước khi kiểm tra lại.
      if (err.code === 11000) {
        const existing = await StockOperation.findById(
          request.operationId
        ).lean();

        if (existing) {
          return readExisting(existing, request);
        }
      }

      throw err;
    }
  }

    async release(input) {
    const request = normalizeRequest(input);

    // Retry khi cạnh tranh tạo dấu hủy với một request reserve.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await mongoose.connection.transaction(
          async (session) => {
            const existing = await StockOperation.findById(
              request.operationId
            ).session(session).lean();

            // Chưa có thao tác: ghi dấu hủy, không cộng kho.
            if (!existing) {
              const [cancelled] = await StockOperation.create(
                [{
                  _id: request.operationId,
                  uid: request.uid,
                  requestHash: request.requestHash,
                  requestItems: request.requestItems,
                  items: [],
                  status: "RELEASED",
                }],
                { session }
              );

              return toReceipt(cancelled);
            }

            if (
              existing.uid !== request.uid ||
              existing.requestHash !== request.requestHash
            ) {
              throw new AppError(
                "CONFLICT",
                "Operation ID was already used for another request"
              );
            }

            if (existing.status === "COMMITTED") {
              throw new AppError(
                "CONFLICT",
                "Committed inventory cannot be released"
              );
            }

            if (existing.status === "RELEASED") {
              return toReceipt(existing);
            }

            for (const item of existing.items) {
              const restored = await Product.findOneAndUpdate(
                {
                  pid: item.pid,
                  quantity: { $lte: 2147483647 - item.qty },
                },
                {
                  $inc: { quantity: item.qty },
                },
                {
                  session,
                  returnDocument: "after",
                }
              ).lean();

              if (!restored) {
                throw new AppError(
                  "CONFLICT",
                  `Cannot restore stock for product ${item.pid}`
                );
              }
            }

            const released = await StockOperation.findByIdAndUpdate(
              request.operationId,
              { $set: { status: "RELEASED" } },
              {
                session,
                returnDocument: "after",
                runValidators: true,
              }
            ).lean();

            return toReceipt(released);
          },
          {
            readPreference: "primary",
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
          }
        );
      } catch (err) {
        if (err.code === 11000 && attempt < 2) {
          continue;
        }

        throw err;
      }
    }
  }

  async commit(input) {
    const request = normalizeRequest(input);

    return mongoose.connection.transaction(
      async (session) => {
        const existing = await StockOperation.findById(
          request.operationId
        ).session(session).lean();

        if (!existing) {
          throw new AppError(
            "NOT_FOUND",
            "Inventory operation not found"
          );
        }

        // Kiểm tra đúng UID, nội dung và chưa bị hủy.
        const receipt = readExisting(existing, request);

        if (existing.status === "COMMITTED") {
          return receipt;
        }

        const committed = await StockOperation.findByIdAndUpdate(
          request.operationId,
          { $set: { status: "COMMITTED" } },
          {
            session,
            returnDocument: "after",
            runValidators: true,
          }
        ).lean();

        return toReceipt(committed);
      },
      {
        readPreference: "primary",
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      }
    );
  }

}

module.exports = InventoryRepository;