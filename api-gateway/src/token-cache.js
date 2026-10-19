const { createHash } = require("node:crypto");
const redis = require("./redis-client");
const { grpc, callAuth } = require("./auth-client");

const roles = ["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"];

function cacheKey(token) {
  const hash = createHash("sha256").update(token).digest("hex");
  return `prompt3:token:v1:${hash}`;
}

function validIdentity(user) {
  return (
    user &&
    Number.isInteger(user.uid) &&
    user.uid > 0 &&
    roles.includes(user.role) &&
    Number.isSafeInteger(user.expiresAt) &&
    user.expiresAt * 1000 > Date.now()
  );
}

function createTokenVerifier(
  verifyRpc = (token) => callAuth("verifyToken", { token })
) {
  return async function verifyToken(token) {
    const key = cacheKey(token);

    // 1. Thử đọc kết quả đã xác minh từ Redis.
    if (redis.isReady) {
      try {
        const raw = await redis.get(key);

        if (raw) {
          const cached = JSON.parse(raw);

          if (
            validIdentity(cached) &&
            Number.isSafeInteger(cached.cachedUntil) &&
            cached.cachedUntil > Date.now() &&
            cached.cachedUntil <= cached.expiresAt * 1000
          ) {
            return {
              uid: cached.uid,
              role: cached.role,
              expiresAt: cached.expiresAt,
            };
          }
        }
      } catch (err) {
        console.error("Token cache read failed:", err.message);
      }
    }

    // 2. Cache thiếu/hết hạn: xác minh qua Auth.
    const response = await verifyRpc(token);

    const user = {
      uid: response.uid,
      role: response.role,
      expiresAt: Number(response.expiresAt),
    };

    if (!validIdentity(user)) {
      const err = new Error("Invalid or expired token identity");
      err.code = grpc.status.UNAUTHENTICATED;
      err.details = err.message;
      throw err;
    }

    // 3. Chỉ cache sau khi xác minh thành công.
    const ttlMs = Math.min(
      30000,
      user.expiresAt * 1000 - Date.now()
    );

    if (redis.isReady && ttlMs > 0) {
      try {
        await redis.set(
          key,
          JSON.stringify({
            ...user,
            cachedUntil: Date.now() + ttlMs,
          }),
          { PX: ttlMs }
        );
      } catch (err) {
        console.error("Token cache write failed:", err.message);
      }
    }

    return user;
  };
}

const verifyTokenCached = createTokenVerifier();

module.exports = {
  cacheKey,
  createTokenVerifier,
  verifyTokenCached,
};