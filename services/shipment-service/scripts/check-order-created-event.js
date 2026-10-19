const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const normalizeOrderCreated = require(
  "../src/domain/order-created-event"
);

const HandleOrderCreated = require(
  "../src/application/handle-order-created"
);

function validEvent() {
  return {
    eventId: randomUUID(),
    eventType: "OrderCreated",
    occurredAt: "2026-10-19T08:00:00.000Z",
    data: {
      oid: 1001,
      uid: 1,
      subtotal: "27.10",
      discount: "1.36",
      total_amount: "25.74",
      items: [
        { pid: 102, qty: 1, unit_price: "2.10" },
        { pid: 101, qty: 2, unit_price: "12.50" },
      ],
    },
  };
}

function expectInvalid(event) {
  assert.throws(
    () => normalizeOrderCreated(event),
    (err) => err.code === "INVALID_INPUT"
  );
}

async function main() {
  const event = validEvent();
  const normalized = normalizeOrderCreated(event);

  assert.equal(normalized.oid, event.data.oid);
  assert.equal(normalized.uid, event.data.uid);
  assert.equal(normalized.sourceEventId, event.eventId);
  assert.match(normalized.eventHash, /^[0-9a-f]{64}$/);

  console.log("PASS: Valid OrderCreated event produces shipment input and hash");

  const reordered = {
    data: {
      items: [...event.data.items].reverse(),
      total_amount: event.data.total_amount,
      discount: event.data.discount,
      subtotal: event.data.subtotal,
      uid: event.data.uid,
      oid: event.data.oid,
    },
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    eventId: event.eventId,
  };

  assert.equal(
    normalizeOrderCreated(reordered).eventHash,
    normalized.eventHash
  );

  console.log("PASS: Field and product ordering do not change the hash");

  const equivalentMoney = structuredClone(event);
  equivalentMoney.data.items[0].unit_price = "2.1";

  assert.equal(
    normalizeOrderCreated(equivalentMoney).eventHash,
    normalized.eventHash
  );

  console.log("PASS: Equivalent decimal representations produce the same hash");

  const changed = structuredClone(event);
  changed.data.discount = "2.00";
  changed.data.total_amount = "25.10";

  assert.notEqual(
    normalizeOrderCreated(changed).eventHash,
    normalized.eventHash
  );

  console.log("PASS: Changed order content produces a different hash");

  const missingOid = validEvent();
  delete missingOid.data.oid;
  expectInvalid(missingOid);

  const wrongUid = validEvent();
  wrongUid.data.uid = "1";
  expectInvalid(wrongUid);

  console.log("PASS: Missing order ID and invalid customer UID rejected");

  const invalidId = validEvent();
  invalidId.eventId = "invalid-id";
  expectInvalid(invalidId);

  const invalidType = validEvent();
  invalidType.eventType = "OrderUpdated";
  expectInvalid(invalidType);

  const invalidTimestamp = validEvent();
  invalidTimestamp.occurredAt = "invalid-date";
  expectInvalid(invalidTimestamp);

  console.log("PASS: Invalid event identity, type and timestamp rejected");

  const duplicate = validEvent();
  duplicate.data.items.push({ ...duplicate.data.items[0] });
  expectInvalid(duplicate);

  const invalidQuantity = validEvent();
  invalidQuantity.data.items[0].qty = 1.5;
  expectInvalid(invalidQuantity);

  const invalidPrice = validEvent();
  invalidPrice.data.items[0].unit_price = "2.101";
  expectInvalid(invalidPrice);

  console.log("PASS: Duplicate products and invalid quantities or prices rejected");

  const wrongSubtotal = validEvent();
  wrongSubtotal.data.subtotal = "28.00";
  expectInvalid(wrongSubtotal);

  const wrongTotal = validEvent();
  wrongTotal.data.total_amount = "1.00";
  expectInvalid(wrongTotal);

  const excessDiscount = validEvent();
  excessDiscount.data.discount = "30.00";
  expectInvalid(excessDiscount);

  console.log("PASS: Inconsistent order amounts rejected");

  const calls = [];

  const handler = new HandleOrderCreated({
    async ensureShipment(input) {
      calls.push(input);

      return {
        shipid: 1,
        ...input,
        status: "PENDING",
      };
    },
  });

  const result = await handler.execute(event);

  assert.equal(result.status, "PENDING");
  assert.deepEqual(calls[0], normalized);

  await assert.rejects(
    () => handler.execute(missingOid),
    (err) => err.code === "INVALID_INPUT"
  );

  assert.equal(calls.length, 1);

  console.log("PASS: Handler calls repository only for valid events");

  console.log("OrderCreated event checks completed successfully");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});