const { createHash } = require("node:crypto");
const Decimal = require("decimal.js");
const AppError = require("./app-error");

const Money = Decimal.clone({
  precision: 40,
});

const MONEY_PATTERN =
  /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/;

function invalid(message) {
  throw new AppError("INVALID_INPUT", message);
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function positiveInteger(value) {
  return (
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647
  );
}

function readMoney(value, field) {
  if (
    typeof value !== "string" ||
    !MONEY_PATTERN.test(value)
  ) {
    invalid(`Invalid ${field}`);
  }

  return new Money(value);
}

function normalizeOrderCreated(event) {
  if (!isObject(event) || event.eventType !== "OrderCreated") {
    invalid("Expected an OrderCreated event");
  }

  if (
    typeof event.eventId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      event.eventId
    )
  ) {
    invalid("Invalid event ID");
  }

  if (
    typeof event.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      event.occurredAt
    )
  ) {
    invalid("Invalid event timestamp");
  }

  const timestamp = new Date(event.occurredAt);

  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString() !== event.occurredAt
  ) {
    invalid("Invalid event timestamp");
  }

  const data = event.data;

  if (
    !isObject(data) ||
    !positiveInteger(data.oid) ||
    !positiveInteger(data.uid)
  ) {
    invalid("Order ID and customer UID are required");
  }

  if (!Array.isArray(data.items) || data.items.length === 0) {
    invalid("Order items are required");
  }

  const seen = new Set();
  let calculatedSubtotal = new Money(0);

  const items = data.items.map((item) => {
    if (
      !isObject(item) ||
      !positiveInteger(item.pid) ||
      !positiveInteger(item.qty)
    ) {
      invalid("Invalid order item");
    }

    if (seen.has(item.pid)) {
      invalid("Duplicate product in event");
    }

    seen.add(item.pid);

    const unitPrice = readMoney(
      item.unit_price,
      "unit_price"
    );

    calculatedSubtotal = calculatedSubtotal.plus(
      unitPrice.times(item.qty)
    );

    if (calculatedSubtotal.gt("99999999.99")) {
      invalid("Order subtotal exceeds supported limit");
    }

    return {
      pid: item.pid,
      qty: item.qty,
      unit_price: unitPrice.toFixed(2),
    };
  });

  items.sort((a, b) => a.pid - b.pid);

  const subtotal = readMoney(data.subtotal, "subtotal");
  const discount = readMoney(data.discount, "discount");
  const totalAmount = readMoney(
    data.total_amount,
    "total_amount"
  );

  if (!subtotal.eq(calculatedSubtotal)) {
    invalid("Subtotal does not match order items");
  }

  if (
    discount.gt(subtotal) ||
    !totalAmount.eq(subtotal.minus(discount))
  ) {
    invalid("Inconsistent order amounts");
  }

  // Cố định thứ tự trường, thứ tự sản phẩm và dạng số tiền
  // trước khi tạo hash.
  const canonical = {
    eventId: event.eventId.toLowerCase(),
    eventType: "OrderCreated",
    occurredAt: timestamp.toISOString(),
    data: {
      oid: data.oid,
      uid: data.uid,
      subtotal: subtotal.toFixed(2),
      discount: discount.toFixed(2),
      total_amount: totalAmount.toFixed(2),
      items,
    },
  };

  const eventHash = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");

  return {
    oid: canonical.data.oid,
    uid: canonical.data.uid,
    sourceEventId: canonical.eventId,
    eventHash,
  };
}

module.exports = normalizeOrderCreated;