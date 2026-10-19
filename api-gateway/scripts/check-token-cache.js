const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const redis = require("../src/redis-client");
const { grpc, client, callAuth } = require("../src/auth-client");
const {
  cacheKey,
  createTokenVerifier,
} = require("../src/token-cache");

const ownedKeys = [];

async function main() {
  await redis.connect();

  const input = {
    username: `cache_${randomUUID()}`,
    password: "P@ss123",
  };

  const registered = await callAuth("register", input);
  const login = await callAuth("login", input);
  const token = login.accessToken;
  const key = cacheKey(token);
  ownedKeys.push(key);

  // Đếm số lần thực sự gọi VerifyToken qua gRPC.
  let rpcCalls = 0;

  const verify = createTokenVerifier(async (value) => {
    rpcCalls++;
    return callAuth("verifyToken", { token: value });
  });

  const first = await verify(token);
  assert.equal(first.uid, registered.uid);
  assert.equal(first.role, "CUSTOMER");
  assert.equal(rpcCalls, 1);
  assert.ok(await redis.get(key));
  console.log("PASS: First verification calls Auth and caches identity");

  const ttl = await redis.pTTL(key);
  assert.ok(ttl > 0 && ttl <= 30000);
  console.log("PASS: Cache TTL does not exceed 30 seconds");

  const second = await verify(token);
  assert.deepEqual(second, first);
  assert.equal(rpcCalls, 1);
  console.log("PASS: Cache hit avoids another Auth RPC");

  // Giả lập bản ghi cache đã hết thời gian sử dụng.
  const cached = JSON.parse(await redis.get(key));

  await redis.set(
    key,
    JSON.stringify({
      ...cached,
      cachedUntil: Date.now() - 1000,
    }),
    { PX: 30000 }
  );

  const refreshed = await verify(token);
  assert.equal(refreshed.uid, registered.uid);
  assert.equal(rpcCalls, 2);
  console.log("PASS: Expired cache triggers Auth verification");

  const invalidToken = `invalid-${randomUUID()}`;
  const invalidKey = cacheKey(invalidToken);
  ownedKeys.push(invalidKey);

  await assert.rejects(
    () => verify(invalidToken),
    { code: grpc.status.UNAUTHENTICATED }
  );

  assert.equal(await redis.exists(invalidKey), 0);
  console.log("PASS: Invalid token is not cached");

  console.log("Token cache checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (redis.isReady && ownedKeys.length) {
        await redis.del(ownedKeys);
      }
    } finally {
      if (redis.isOpen) redis.destroy();
      client.close();
    }
  });