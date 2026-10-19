const AppError = require("../domain/app-error");

const TRANSITIONS = {
  PENDING: ["SHIPPING", "CANCELLED"],
  SHIPPING: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

function authenticate(actor) {
  if (
    !actor ||
    !Number.isInteger(actor.uid) ||
    actor.uid <= 0 ||
    actor.uid > 2147483647 ||
    !["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"].includes(actor.role)
  ) {
    throw new AppError(
      "INVALID_CREDENTIALS",
      "Authentication is required"
    );
  }
}

function validateShipid(shipid) {
  if (
    !Number.isInteger(shipid) ||
    shipid <= 0 ||
    shipid > 2147483647
  ) {
    throw new AppError(
      "INVALID_INPUT",
      "Invalid shipment ID"
    );
  }
}

class ShipmentService {
  constructor(repository) {
    this.repository = repository;
  }

  async getShipment(actor, shipid) {
    authenticate(actor);
    validateShipid(shipid);

    const shipment = await this.repository.findByShipid(shipid);

    if (!shipment) {
      throw new AppError("NOT_FOUND", "Shipment not found");
    }

    if (
      actor.role === "CUSTOMER" &&
      shipment.uid !== actor.uid
    ) {
      throw new AppError(
        "FORBIDDEN",
        "Cannot access another customer's shipment"
      );
    }

    return shipment;
  }

  async getShipmentByOrder(actor, oid) {
    authenticate(actor);

    if (
      !Number.isInteger(oid) ||
      oid <= 0 ||
      oid > 2147483647
    ) {
      throw new AppError(
        "INVALID_INPUT",
        "Invalid order ID"
      );
    }

    const shipment = await this.repository.findByOid(oid);

    if (!shipment) {
      throw new AppError(
        "NOT_FOUND",
        "Shipment for this order is not available"
      );
    }

    // Dùng lại kiểm tra quyền sở hữu đã có.
    return this.getShipment(actor, shipment.shipid);
  }

  async updateStatus(actor, shipid, status) {
    authenticate(actor);

    if (!["ADMIN", "SHIPMENT_STAFF"].includes(actor.role)) {
      throw new AppError(
        "FORBIDDEN",
        "Only shipment staff or admin can update status"
      );
    }

    validateShipid(shipid);

    if (!Object.hasOwn(TRANSITIONS, status)) {
      throw new AppError(
        "INVALID_INPUT",
        "Invalid shipment status"
      );
    }

    const current = await this.repository.findByShipid(shipid);

    if (!current) {
      throw new AppError("NOT_FOUND", "Shipment not found");
    }

    if (current.status === status) {
      return current;
    }

    if (!TRANSITIONS[current.status].includes(status)) {
      throw new AppError(
        "INVALID_INPUT",
        `Cannot change shipment from ${current.status} to ${status}`
      );
    }

    const updated = await this.repository.updateStatus(
      shipid,
      current.status,
      status
    );

    if (updated) return updated;

    // Người khác có thể vừa cập nhật cùng shipment.
    const latest = await this.repository.findByShipid(shipid);

    if (!latest) {
      throw new AppError("NOT_FOUND", "Shipment not found");
    }

    if (latest.status === status) {
      return latest;
    }

    throw new AppError(
      "CONFLICT",
      "Shipment changed concurrently; retrieve it and retry"
    );
  }
}

module.exports = ShipmentService;