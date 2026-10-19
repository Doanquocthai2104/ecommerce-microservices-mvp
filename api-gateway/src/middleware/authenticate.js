const { grpc } = require("../auth-client");
const { verifyTokenCached } = require("../token-cache");


function unauthorized(message) {
  const err = new Error(message);
  err.code = grpc.status.UNAUTHENTICATED;
  err.details = message;
  return err;
}

async function authenticate(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (typeof authorization !== "string") {
      throw unauthorized("Bearer token is required");
    }

    const match = /^Bearer\s+(\S+)$/i.exec(authorization);

    if (!match) {
      throw unauthorized("Invalid Authorization header");
    }

    const user = await verifyTokenCached(match[1]);

    const validRoles = [
      "CUSTOMER",
      "ADMIN",
      "SHIPMENT_STAFF",
    ];

    if (
      !Number.isInteger(user.uid) ||
      user.uid <= 0 ||
      !validRoles.includes(user.role)
    ) {
      throw unauthorized("Invalid token identity");
    }

    req.user = {
      uid: user.uid,
      role: user.role,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authenticate;