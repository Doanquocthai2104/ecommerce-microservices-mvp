const { grpc } = require("../infrastructure/shipment-proto");
const AppError = require("../domain/app-error");

function createShipmentHandlers({ service, verifyToken }) {
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

    // authenticate chỉ trả về danh tính đã xác thực.
    return {
      uid: identity.uid,
      role: identity.role,
    };
  }

  function toResponse(shipment) {
    return {
      shipid: shipment.shipid,
      oid: shipment.oid,
      uid: shipment.uid,
      status: shipment.status,
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

    if (appCodes[err.code] !== undefined) {
      return {
        code: appCodes[err.code],
        details: err.message,
      };
    }

    if (err.code === grpc.status.UNAVAILABLE) {
      return {
        code: grpc.status.UNAVAILABLE,
        details: "Auth Service unavailable",
      };
    }

    if (err.code === grpc.status.DEADLINE_EXCEEDED) {
      return {
        code: grpc.status.DEADLINE_EXCEEDED,
        details: "Auth Service request timed out",
      };
    }

    if (err.code === grpc.status.UNAUTHENTICATED) {
      return {
        code: grpc.status.UNAUTHENTICATED,
        details: "Invalid or expired token",
      };
    }

    console.error("Shipment handler error:", err.message);

    return {
      code: grpc.status.INTERNAL,
      details: "Internal server error",
    };
  }

  function wrap(handler) {
    return async (call, callback) => {
      try {
        const actor = await authenticate(call);
        const result = await handler(call, actor);

        callback(null, toResponse(result));
      } catch (err) {
        callback(toGrpcError(err));
      }
    };
  }

  // Đây mới là phần trả về danh sách handlers.
  return {
    getShipment: wrap((call, actor) =>
      service.getShipment(
        actor,
        call.request.shipid
      )
    ),

    getShipmentByOrder: wrap((call, actor) =>
      service.getShipmentByOrder(
        actor,
        call.request.oid
      )
    ),

    updateShipmentStatus: wrap((call, actor) =>
      service.updateStatus(
        actor,
        call.request.shipid,
        call.request.status
      )
    ),
  };
}

module.exports = createShipmentHandlers;