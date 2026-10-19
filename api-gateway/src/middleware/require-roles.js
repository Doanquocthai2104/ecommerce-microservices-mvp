const { grpc } = require("../auth-client");

function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      const err = new Error("Authentication is required");
      err.code = grpc.status.UNAUTHENTICATED;
      err.details = err.message;
      return next(err);
    }

    if (!allowedRoles.includes(req.user.role)) {
      const err = new Error("Insufficient permission");
      err.code = grpc.status.PERMISSION_DENIED;
      err.details = err.message;
      return next(err);
    }

    next();
  };
}

module.exports = requireRoles;