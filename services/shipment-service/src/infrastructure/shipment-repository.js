const Shipment = require("./shipment-model");
const Counter = require("./counter-model");
const AppError = require("../domain/app-error");

const MAX_INT = 2147483647;

function positiveInteger(value) {
  return (
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_INT
  );
}

function normalizeInput(input) {
  if (
    !input ||
    !positiveInteger(input.oid) ||
    !positiveInteger(input.uid) ||
    typeof input.sourceEventId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.sourceEventId
    ) ||
    typeof input.eventHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.eventHash)
  ) {
    throw new AppError(
      "INVALID_INPUT",
      "Invalid shipment creation data"
    );
  }

  return {
    oid: input.oid,
    uid: input.uid,
    sourceEventId: input.sourceEventId.toLowerCase(),
    eventHash: input.eventHash,
  };
}

function toShipment(document) {
  if (!document) return null;

  return {
    shipid: document.shipid,
    oid: document.oid,
    uid: document.uid,
    sourceEventId: document.sourceEventId,
    eventHash: document.eventHash,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function checkExisting(existing, input) {
  if (
    existing.oid !== input.oid ||
    existing.uid !== input.uid ||
    existing.sourceEventId !== input.sourceEventId ||
    existing.eventHash !== input.eventHash
  ) {
    throw new AppError(
      "CONFLICT",
      "Order or event ID has already been used with different data"
    );
  }

  return toShipment(existing);
}

class ShipmentRepository {
  async initialize() {
    await Promise.all([
      Shipment.init(),
      Counter.init(),
    ]);

    const highest = await Shipment.findOne()
      .sort({ shipid: -1 })
      .select({ shipid: 1 })
      .lean();

    const minimumSequence = highest?.shipid || 0;

    try {
      await Counter.findOneAndUpdate(
        { _id: "shipment" },
        { $max: { seq: minimumSequence } },
        {
          upsert: true,
          returnDocument: "after",
        }
      );
    } catch (err) {
      // Hai instance có thể khởi tạo counter cùng lúc.
      if (err.code !== 11000) throw err;

      await Counter.findOneAndUpdate(
        { _id: "shipment" },
        { $max: { seq: minimumSequence } },
        { returnDocument: "after" }
      );
    }
  }

  async nextShipid() {
    const counter = await Counter.findOneAndUpdate(
      {
        _id: "shipment",
        seq: { $lt: MAX_INT },
      },
      { $inc: { seq: 1 } },
      { returnDocument: "after" }
    );

    if (!counter) {
      throw new Error(
        "Shipment counter is missing or exhausted"
      );
    }

    return counter.seq;
  }

  async findExisting(input) {
    return Shipment.findOne({
      $or: [
        { oid: input.oid },
        { sourceEventId: input.sourceEventId },
      ],
    }).lean();
  }

  async ensureShipment(input) {
    const normalized = normalizeInput(input);

    const existing = await this.findExisting(normalized);

    if (existing) {
      return checkExisting(existing, normalized);
    }

    const shipid = await this.nextShipid();

    try {
      const created = await Shipment.create({
        ...normalized,
        shipid,
        status: "PENDING",
      });

      return toShipment(created);
    } catch (err) {
      if (err.code !== 11000) throw err;

      // Instance khác có thể vừa tạo cùng shipment.
      const concurrent = await this.findExisting(normalized);

      if (!concurrent) throw err;

      return checkExisting(concurrent, normalized);
    }
  }

  async updateStatus(shipid, expectedStatus, status) {
    const statuses = [
      "PENDING",
      "SHIPPING",
      "DELIVERED",
      "CANCELLED",
    ];

    if (
      !positiveInteger(shipid) ||
      !statuses.includes(expectedStatus) ||
      !statuses.includes(status)
    ) {
      throw new AppError(
        "INVALID_INPUT",
        "Invalid shipment status update"
      );
    }

    const updated = await Shipment.findOneAndUpdate(
      {
        shipid,
        status: expectedStatus,
      },
      {
        $set: { status },
      },
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    return toShipment(updated);
  }


  async findByShipid(shipid) {
    if (!positiveInteger(shipid)) {
      throw new AppError("INVALID_INPUT", "Invalid shipment ID");
    }

    return toShipment(
      await Shipment.findOne({ shipid }).lean()
    );
  }

  async findByOid(oid) {
    if (!positiveInteger(oid)) {
      throw new AppError("INVALID_INPUT", "Invalid order ID");
    }

    return toShipment(
      await Shipment.findOne({ oid }).lean()
    );
  }
}

module.exports = ShipmentRepository;