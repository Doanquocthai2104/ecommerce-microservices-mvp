const { grpc } = require("../infrastructure/customer-proto");
const AppError = require("../domain/app-error");

function createCustomerHandlers(service, authClient) {
  async function authenticate(call) {
    const headers = call.metadata.get("authorization");

    if (headers.length !== 1 || typeof headers[0] !== "string") {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Bearer token is required"
      );
    }

    const match = /^Bearer\s+(\S+)$/i.exec(headers[0]);

    if (!match) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid Authorization header"
      );
    }

    const actor = await new Promise((resolve, reject) => {
      authClient.verifyToken(
        { token: match[1] },
        { deadline: new Date(Date.now() + 5000) },
        (err, response) => {
          if (err) return reject(err);
          resolve(response);
        }
      );
    });

    if (
      !Number.isInteger(actor.uid) ||
      actor.uid <= 0 ||
      !["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"].includes(actor.role)
    ) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid token identity"
      );
    }

    return {
      uid: actor.uid,
      role: actor.role,
    };
  }

  function wrap(handler) {
    return async (call, callback) => {
      try {
        const actor = await authenticate(call);
        const response = await handler(call.request, actor);

        callback(null, response);
      } catch (err) {
        const codes = {
          INVALID_INPUT: grpc.status.INVALID_ARGUMENT,
          INVALID_CREDENTIALS: grpc.status.UNAUTHENTICATED,
          FORBIDDEN: grpc.status.PERMISSION_DENIED,
          NOT_FOUND: grpc.status.NOT_FOUND,
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

        // Các lỗi nhận từ RPC xác minh token của Auth.
        if (err.code === grpc.status.UNAUTHENTICATED) {
          return callback({
            code: grpc.status.UNAUTHENTICATED,
            details: "Invalid or expired token",
          });
        }

        if (
          err.code === grpc.status.UNAVAILABLE ||
          err.code === grpc.status.DEADLINE_EXCEEDED
        ) {
          return callback({
            code: err.code,
            details: "Auth Service unavailable or timed out",
          });
        }

        console.error("Customer gRPC error:", err.message);

        callback({
          code: grpc.status.INTERNAL,
          details: "Internal server error",
        });
      }
    };
  }

  return {
    ensureProfile: wrap((request, actor) => {
      if (actor.role !== "CUSTOMER") {
        throw new AppError(
          "FORBIDDEN",
          "Only Customer can initialize their own profile"
        );
      }

      return service.ensureProfile({
        uid: actor.uid,
        fullname: request.fullname,
      });
    }),

    getProfile: wrap((request, actor) => {
      return service.getProfileForActor(request.uid, actor);
    }),

    updateProfile: wrap((request, actor) => {
      const changes = {};

      if (Object.hasOwn(request, "fullname")) {
        changes.fullname = request.fullname;
      }

      if (Object.hasOwn(request, "mid")) {
        changes.mid = request.mid;
      }

      return service.updateProfile(
        request.uid,
        changes,
        actor
      );
    }),

    getMembership: wrap(async (request, actor) => {
      const profile = await service.getProfileForActor(
        request.uid,
        actor
      );

      return {
        uid: profile.uid,
        mid: profile.mid,
        mname: profile.mname,
        score: profile.score,
      };
    }),
  };
}

module.exports = createCustomerHandlers;