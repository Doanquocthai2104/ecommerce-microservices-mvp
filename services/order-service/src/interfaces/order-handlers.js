const { grpc } = require("../infrastructure/order-proto");
const AppError = require("../domain/app-error");

function createOrderHandlers({ createOrder, orders, verifyToken }) {
  async function authenticate(call) {
    const values = call.metadata.get("authorization");

    if (values.length !== 1 || typeof values[0] !== "string") {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Bearer token is required"
      );
    }

    const match = /^Bearer ([^\s]+)$/i.exec(values[0]);

    if (!match) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid Authorization header"
      );
    }

    const identity = await verifyToken(match[1]);

    if (
      !identity ||
      !Number.isInteger(identity.uid) ||
      identity.uid <= 0 ||
      identity.uid > 2147483647 ||
      !["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"].includes(identity.role)
    ) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid token identity"
      );
    }

    return {
      actor: {
        uid: identity.uid,
        role: identity.role,
      },
      authorization: values[0],
    };
  }

  function requireReader(actor) {
    if (!["CUSTOMER", "ADMIN"].includes(actor.role)) {
      throw new AppError(
        "FORBIDDEN",
        "This role cannot read orders"
      );
    }
  }

  function toResponse(order) {
    return {
      oid: order.oid,
      uid: order.uid,
      subtotal: order.subtotal,
      discount: order.discount,
      totalAmount: order.total_amount,
      items: (order.items || []).map((item) => ({
        pid: item.pid,
        qty: item.qty,
        unitPrice: item.unit_price,
      })),
      createdAt: new Date(order.created_at).toISOString(),
    };
  }

  function toGrpcError(err) {
    const appCodes = {
      INVALID_INPUT: grpc.status.INVALID_ARGUMENT,
      INVALID_CREDENTIALS: grpc.status.UNAUTHENTICATED,
      FORBIDDEN: grpc.status.PERMISSION_DENIED,
      NOT_FOUND: grpc.status.NOT_FOUND,
      CONFLICT: grpc.status.ALREADY_EXISTS,
    };

    const appCode = appCodes[err.code];

    if (appCode !== undefined) {
      return {
        code: appCode,
        details: err.message,
      };
    }

    // Giữ các mã lỗi nghiệp vụ/kết nối từ upstream gRPC.
    const upstreamCodes = new Set([
      grpc.status.INVALID_ARGUMENT,
      grpc.status.UNAUTHENTICATED,
      grpc.status.PERMISSION_DENIED,
      grpc.status.NOT_FOUND,
      grpc.status.ALREADY_EXISTS,
      grpc.status.FAILED_PRECONDITION,
      grpc.status.UNAVAILABLE,
      grpc.status.DEADLINE_EXCEEDED,
    ]);

    if (Number.isInteger(err.code) && upstreamCodes.has(err.code)) {
      const details =
        err.code === grpc.status.UNAVAILABLE
          ? "Required service unavailable"
          : err.code === grpc.status.DEADLINE_EXCEEDED
            ? "Upstream request timed out"
            : err.details || "Request failed";

      return {
        code: err.code,
        details,
      };
    }

    console.error("Order handler error:", err.message);

    return {
      code: grpc.status.INTERNAL,
      details: "Internal server error",
    };
  }

  function wrap(handler) {
    return async (call, callback) => {
      try {
        const context = await authenticate(call);
        const response = await handler(call, context);

        callback(null, response);
      } catch (err) {
        callback(toGrpcError(err));
      }
    };
  }

  return {
    createOrder: wrap(async (call, context) => {
      const result = await createOrder.execute({
        actor: context.actor,
        authorization: context.authorization,
        requestId: call.request.requestId,
        items: (call.request.items || []).map((item) => ({
          pid: item.pid,
          qty: item.qty,
        })),
      });

      return toResponse(result);
    }),

    listOrders: wrap(async (call, { actor }) => {
      requireReader(actor);

      // Danh sách luôn lấy theo UID đã xác thực.
      const result = await orders.listByUid(actor.uid);

      return {
        items: result.map(toResponse),
      };
    }),

    getOrder: wrap(async (call, { actor }) => {
      requireReader(actor);

      const oid = call.request.oid;

      if (
        !Number.isInteger(oid) ||
        oid <= 0 ||
        oid > 2147483647
      ) {
        throw new AppError("INVALID_INPUT", "Invalid order ID");
      }

      const order = await orders.findByOid(oid);

      if (!order) {
        throw new AppError("NOT_FOUND", "Order not found");
      }

      if (actor.role !== "ADMIN" && order.uid !== actor.uid) {
        throw new AppError(
          "FORBIDDEN",
          "Cannot access another customer's order"
        );
      }

      return toResponse(order);
    }),
  };
}

module.exports = createOrderHandlers;