const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");

const redis = require("../src/redis-client");
const createRateLimiter = require("../src/middleware/rate-limit");

let server;

async function main() {
  await redis.connect();
  assert.equal(await redis.ping(), "PONG");
  console.log("PASS: Node.js connects to Redis");

  // Kiểm tra khả năng lưu cache qua Node.js.
  const cacheKey = `prompt3:test:cache:${randomUUID()}`;

  await redis.set(cacheKey, "hello", { EX: 30 });
  assert.equal(await redis.get(cacheKey), "hello");
  assert.ok((await redis.ttl(cacheKey)) > 0);
  await redis.del(cacheKey);
  console.log("PASS: Redis stores data with expiration");

  // Server kiểm tra riêng, dùng cùng middleware và Redis thật.
  // Prefix riêng để không ảnh hưởng bộ đếm của Gateway.
  const app = express();

  app.use(createRateLimiter({
    limit: 3,
    windowMs: 3000,
    prefix: `prompt3:test:rate:${randomUUID()}:`,
  }));

  app.get("/probe", (req, res) => {
    res.json({ ok: true });
  });

  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const url = `http://127.0.0.1:${server.address().port}/probe`;

  async function request() {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    await response.json();
    return response;
  }

  for (let i = 0; i < 3; i++) {
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(
      Number(response.headers.get("X-RateLimit-Remaining")),
      2 - i
    );
  }
  console.log("PASS: Requests within limit are accepted");

  const blocked = await request();
  assert.equal(blocked.status, 429);

  const retryAfter = Number(blocked.headers.get("Retry-After"));
  assert.ok(retryAfter > 0);
  console.log("PASS: Excess request returns 429 and Retry-After");

  await new Promise((resolve) => {
    setTimeout(resolve, retryAfter * 1000 + 200);
  });

  const reset = await request();
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get("X-RateLimit-Remaining"), "2");
  console.log("PASS: Requests accepted after window expires");

  console.log("Rate limiting checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    if (redis.isOpen) {
      redis.destroy();
    }
  });