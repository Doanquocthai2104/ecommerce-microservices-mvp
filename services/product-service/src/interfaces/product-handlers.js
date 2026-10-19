const { grpc } = require("../infrastructure/product-proto");
const AppError = require("../domain/app-error");

function createProductHandlers(service, authClient) {
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

    return new Promise((resolve, reject) => {
      authClient.verifyToken(
        { token: match[1] },
        { deadline: new Date(Date.now() + 5000) },
        (err, response) => {
          if (err) return reject(err);

          resolve({
            uid: response.uid,
            role: response.role,
          });
        }
      );
    });
  }

  function wrap(handler) {
    return async (call, callback) => {
      try {
        const actor = await authenticate(call);
        const result = await handler(call.request, actor);

        callback(null, result);
      } catch (err) {
        const codes = {
          INVALID_INPUT: grpc.status.INVALID_ARGUMENT,
          INVALID_CREDENTIALS: grpc.status.UNAUTHENTICATED,
          FORBIDDEN: grpc.status.PERMISSION_DENIED,
          NOT_FOUND: grpc.status.NOT_FOUND,
          CONFLICT: grpc.status.ALREADY_EXISTS,
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

        console.error("Product gRPC error:", err.message);

        callback({
          code: grpc.status.INTERNAL,
          details: "Internal server error",
        });
      }
    };
  }

  return {
    createProduct: wrap((request, actor) => {
      return service.create(
        {
          pname: request.pname,
          price: request.price,
          quantity: request.quantity,
        },
        actor
      );
    }),

    listProducts: wrap(async (request, actor) => {
      const items = await service.list(actor);
      return { items };
    }),

    getProduct: wrap((request, actor) => {
      return service.get(request.pid, actor);
    }),

    updateProduct: wrap((request, actor) => {
      const changes = {};

      for (const field of ["pname", "price", "quantity"]) {
        if (Object.hasOwn(request, field)) {
          changes[field] = request[field];
        }
      }

      return service.update(request.pid, changes, actor);
    }),

    deleteProduct: wrap((request, actor) => {
      return service.delete(request.pid, actor);
    }),
  };
}

module.exports = createProductHandlers;