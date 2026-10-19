const express = require("express");
const authenticate = require("./middleware/authenticate");
const requireRoles = require("./middleware/require-roles");
const { callShipment } = require("./shipment-client");

const router = express.Router();

const STATUSES = [
  "PENDING",
  "SHIPPING",
  "DELIVERED",
  "CANCELLED",
];

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function readShipid(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    invalid("Invalid shipment ID");
  }

  const shipid = Number(value);

  if (
    !Number.isSafeInteger(shipid) ||
    shipid > 2147483647
  ) {
    invalid("Invalid shipment ID");
  }

  return shipid;
}

function readStatus(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    invalid("A JSON object is required");
  }

  if (
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "status")
  ) {
    invalid("Only status is accepted");
  }

  if (
    typeof body.status !== "string" ||
    !STATUSES.includes(body.status)
  ) {
    invalid("Invalid shipment status");
  }

  return body.status;
}

function toRestShipment(shipment) {
  return {
    shipid: shipment.shipid,
    oid: shipment.oid,
    status: shipment.status,
  };
}

router.use(authenticate);

router.get(
  "/:shipid",
  requireRoles("CUSTOMER", "ADMIN", "SHIPMENT_STAFF"),
  async (req, res, next) => {
    try {
      const shipment = await callShipment(
        "getShipment",
        { shipid: readShipid(req.params.shipid) },
        req.headers.authorization
      );

      res.json(toRestShipment(shipment));
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/:shipid/status",
  requireRoles("ADMIN", "SHIPMENT_STAFF"),
  async (req, res, next) => {
    try {
      const shipid = readShipid(req.params.shipid);
      const status = readStatus(req.body);

      const shipment = await callShipment(
        "updateShipmentStatus",
        { shipid, status },
        req.headers.authorization
      );

      res.json(toRestShipment(shipment));
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;