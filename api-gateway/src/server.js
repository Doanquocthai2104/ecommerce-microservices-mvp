const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const express = require("express");

const { grpc, callAuth } = require("./auth-client");
const { callCustomer } = require("./customer-client");

const healthRoutes = require("./health-routes");
const customerRoutes = require("./customer-routes");
const productRoutes = require("./product-routes");
const orderRoutes = require("./order-routes");
const shipmentRoutes = require("./shipment-routes");

const redis = require("./redis-client");
const createRateLimiter = require("./middleware/rate-limit");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", false);

// Log request metadata only.
app.use((req, res, next) => {
  const started = Date.now();

  res.on("finish", () => {
    console.log(
      `${req.method} ${req.path} ${res.statusCode} ` +
      `${Date.now() - started}ms`
    );
  });

  next();
});

// Health endpoints must be registered before the Redis rate limiter.
app.use("/api", healthRoutes);

// Rate limiting for business APIs.
app.use("/api", createRateLimiter());

app.use(express.json({ limit: "16kb" }));

function readInput(body, fields) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    const err = new Error("A JSON object is required");
    err.status = 400;
    throw err;
  }

  const input = {};

  for (const field of fields) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string") {
        const err = new Error(`${field} must be a string`);
        err.status = 400;
        throw err;
      }

      input[field] = body[field];
    }
  }

  return input;
}

// Register account.
app.post("/api/auth/register", async (req, res, next) => {
  try {
    const input = readInput(req.body, [
      "username",
      "password",
      "email",
      "phone",
    ]);

    const result = await callAuth("register", input);

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// Login and ensure the Customer profile exists.
app.post("/api/auth/login", async (req, res, next) => {
  try {
    const input = readInput(req.body, [
      "username",
      "password",
    ]);

    const result = await callAuth("login", input);

    const identity = await callAuth("verifyToken", {
      token: result.accessToken,
    });

    if (identity.role === "CUSTOMER") {
      await callCustomer(
        "ensureProfile",
        { fullname: input.username.trim() },
        `Bearer ${result.accessToken}`
      );
    }

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Business routes.
app.use("/api/customers", customerRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/shipments", shipmentRoutes);

// Unknown endpoint.
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

// Global error handler.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "Invalid JSON",
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Request body too large",
    });
  }

  if (err.status === 400) {
    return res.status(400).json({
      error: err.message,
    });
  }

  const statusMap = {
    [grpc.status.INVALID_ARGUMENT]: 400,
    [grpc.status.ALREADY_EXISTS]: 409,
    [grpc.status.FAILED_PRECONDITION]: 409,
    [grpc.status.UNAUTHENTICATED]: 401,
    [grpc.status.PERMISSION_DENIED]: 403,
    [grpc.status.NOT_FOUND]: 404,
    [grpc.status.UNAVAILABLE]: 503,
    [grpc.status.DEADLINE_EXCEEDED]: 504,
  };

  const status = statusMap[err.code] || 500;

  if (status >= 500) {
    console.error("Gateway upstream error:", err.message);
  }

  const message =
    status === 503
      ? "Required service unavailable"
      : status === 504
        ? "Upstream request timed out"
        : status === 500
          ? "Internal server error"
          : err.details || "Request failed";

  res.status(status).json({
    error: message,
  });
});

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);

async function start() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT");
  }

  await redis.connect();
  console.log("Gateway connected to Redis");

  const server = app.listen(port, host, () => {
    console.log(
      `API Gateway listening on http://${host}:${port}`
    );
    console.log(
      "Gateway liveness and aggregate health endpoints registered"
    );
  });

  server.on("error", (err) => {
    console.error("Gateway startup failed:", err.message);

    if (redis.isOpen) {
      redis.destroy();
    }

    process.exit(1);
  });
}

start().catch((err) => {
  console.error("Gateway startup failed:", err.message);

  if (redis.isOpen) {
    redis.destroy();
  }

  process.exitCode = 1;
});