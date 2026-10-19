const express = require("express");
const authenticate = require("./middleware/authenticate");
const requireRoles = require("./middleware/require-roles");
const { callOrder } = require("./order-client");
const lookupOrderShipment = require("./order-shipment");

const router = express.Router();

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function positiveInteger(value) {
  return (
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647
  );
}

function readOid(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    invalid("Invalid order ID");
  }

  const oid = Number(value);

  if (!positiveInteger(oid)) {
    invalid("Invalid order ID");
  }

  return oid;
}

function readRequestId(req) {
  const value = req.headers["idempotency-key"];

  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    invalid("Idempotency-Key header must contain a UUID");
  }

  return value.toLowerCase();
}

function readItems(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalid("A JSON object is required");
  }

  if (
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "items")
  ) {
    invalid("Only items is accepted");
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    invalid("Order must contain at least one item");
  }

  const seen = new Set();

  return body.items.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 2 ||
      !Object.hasOwn(item, "pid") ||
      !Object.hasOwn(item, "qty") ||
      !positiveInteger(item.pid) ||
      !positiveInteger(item.qty)
    ) {
      invalid("Each item must contain positive integer pid and qty");
    }

    if (seen.has(item.pid)) {
      invalid("Each product must appear only once");
    }

    seen.add(item.pid);

    return {
      pid: item.pid,
      qty: item.qty,
    };
  });
}

function toRestOrder(order, includeItems = true) {
  const result = {
    oid: order.oid,
    uid: order.uid,
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    total_amount: Number(order.totalAmount),
    created_at: order.createdAt,
  };

  if (includeItems) {
    result.items = (order.items || []).map((item) => ({
      pid: item.pid,
      qty: item.qty,
      unit_price: Number(item.unitPrice),
    }));
  }

  return result;
}

router.use(authenticate);

router.post(
  "/",
  requireRoles("CUSTOMER"),
  async (req, res, next) => {
    try {
      const requestId = readRequestId(req);
      const items = readItems(req.body);

      const order = await callOrder(
        "createOrder",
        { requestId, items },
        req.headers.authorization
      );

      const shipment = await lookupOrderShipment(
        order.oid,
        req.headers.authorization,
        3000
      );

      res.setHeader("Idempotency-Key", requestId);
      res.setHeader("Location", `/api/orders/${order.oid}`);

      res.status(201).json({
        ...toRestOrder(order),
        shipment,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/",
  requireRoles("CUSTOMER", "ADMIN"),
  async (req, res, next) => {
    try {
      if (Object.keys(req.query).length > 0) {
        invalid("Query parameters are not supported");
      }

      const result = await callOrder(
        "listOrders",
        {},
        req.headers.authorization
      );

      res.json({
        items: (result.items || []).map((order) =>
          toRestOrder(order, false)
        ),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:oid",
  requireRoles("CUSTOMER", "ADMIN"),
  async (req, res, next) => {
    try {
      const order = await callOrder(
        "getOrder",
        { oid: readOid(req.params.oid) },
        req.headers.authorization
      );

      const shipment = await lookupOrderShipment(
        order.oid,
        req.headers.authorization
      );

      res.json({
        ...toRestOrder(order),
        shipment,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;