const redis = require("../redis-client");

const script = `
  local count = redis.call('INCR', KEYS[1])

  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end

  local ttl = redis.call('PTTL', KEYS[1])
  return {count, ttl}
`;

function createRateLimiter({
  limit = 100,
  windowMs = 60000,
  prefix = "prompt3:rate:",
} = {}) {
  return async (req, res, next) => {
    try {
      const key = `${prefix}${req.ip}`;

      const [count, ttl] = await redis.eval(script, {
        keys: [key],
        arguments: [String(windowMs)],
      });

      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, limit - count))
      );

      if (count > limit) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil(ttl / 1000)))
        );

        return res.status(429).json({
          error: "Too many requests. Please try again later.",
        });
      }

      next();
    } catch (err) {
      console.error("Rate limiter error:", err.message);

      res.status(503).json({
        error: "Rate limiting service unavailable",
      });
    }
  };
}

module.exports = createRateLimiter;