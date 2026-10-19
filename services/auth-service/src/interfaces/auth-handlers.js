const { grpc } = require("../infrastructure/auth-proto");
const AppError = require("../domain/app-error");

function wrap(handler) {
  return async (call, callback) => {
    try {
      const result = await handler(call.request);
      callback(null, result);
    } catch (err) {
      const codes = {
        INVALID_INPUT: grpc.status.INVALID_ARGUMENT,
        ACCOUNT_EXISTS: grpc.status.ALREADY_EXISTS,
        INVALID_CREDENTIALS: grpc.status.UNAUTHENTICATED,
      };

      if (err instanceof AppError && codes[err.code] !== undefined) {
        return callback({
          code: codes[err.code],
          details: err.message,
        });
      }

      if (
        ["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"]
          .includes(err.name)
      ) {
        return callback({
          code: grpc.status.UNAUTHENTICATED,
          details: "Invalid or expired token",
        });
      }

      console.error("Auth gRPC error:", err.message);

      callback({
        code: grpc.status.INTERNAL,
        details: "Internal server error",
      });
    }
  };
}

function createAuthHandlers({ register, login, tokenService }) {
  return {
    register: wrap((request) => register.execute(request)),

    login: wrap((request) => login.execute(request)),

    verifyToken: wrap((request) => {
      if (typeof request.token !== "string" || !request.token.trim()) {
        throw new AppError("INVALID_CREDENTIALS", "Token is required");
      }

      const payload = tokenService.verify(request.token);

      return {
        uid: Number(payload.sub),
        role: payload.role,
        expiresAt: payload.exp,
      };
    }),
  };
}

module.exports = createAuthHandlers;