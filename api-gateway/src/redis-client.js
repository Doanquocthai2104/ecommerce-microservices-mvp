const { createClient } = require("redis");

const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6380",
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (retries) => Math.min(200 * retries + 200, 3000),
  },
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

module.exports = redis;