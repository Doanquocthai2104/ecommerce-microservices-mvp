const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const assert = require("node:assert/strict");
const OrderPricing = require("../src/domain/order-pricing");

function main() {
  assert.ok(
    process.env.DISCOUNT_TIERS,
    "Missing DISCOUNT_TIERS in Order .env"
  );

  const pricing = new OrderPricing(
    JSON.parse(process.env.DISCOUNT_TIERS)
  );

  const items = [
    { pid: 101, qty: 2, unit_price: "1500.00" },
    { pid: 102, qty: 1, unit_price: "25.00" },
  ];

  // Các kỳ vọng dưới đây dùng chính sách mẫu ở bước 8.4.
  const basic = pricing.calculate(items, 0);
  assert.equal(basic.subtotal, "3025.00");
  assert.equal(basic.discount, "0.00");
  assert.equal(basic.totalAmount, "3025.00");
  console.log("PASS: Score 0 receives no discount");

  const belowThreshold = pricing.calculate(items, 99);
  assert.equal(belowThreshold.discountPercent, 0);
  console.log("PASS: Score below 100 receives no discount");

  const fivePercent = pricing.calculate(items, 100);
  assert.equal(fivePercent.discountPercent, 5);
  assert.equal(fivePercent.discount, "151.25");
  assert.equal(fivePercent.totalAmount, "2873.75");
  console.log("PASS: Score 100 receives 5 percent discount");

  const tenPercent = pricing.calculate(items, 500);
  assert.equal(tenPercent.discountPercent, 10);
  assert.equal(tenPercent.discount, "302.50");
  assert.equal(tenPercent.totalAmount, "2722.50");
  console.log("PASS: Score 500 receives 10 percent discount");

  const fifteenPercent = pricing.calculate(items, 1000);
  assert.equal(fifteenPercent.discountPercent, 15);
  assert.equal(fifteenPercent.discount, "453.75");
  assert.equal(fifteenPercent.totalAmount, "2571.25");
  console.log("PASS: Score 1000 receives 15 percent discount");

  // 0.10 × 5% = 0.005, làm tròn thành 0.01.
  const rounded = pricing.calculate(
    [{ pid: 1, qty: 1, unit_price: "0.10" }],
    100
  );

  assert.equal(rounded.discount, "0.01");
  assert.equal(rounded.totalAmount, "0.09");
  console.log("PASS: Discount uses two-decimal HALF_UP rounding");

  const decimalSum = pricing.calculate(
    [
      { pid: 1, qty: 1, unit_price: "0.10" },
      { pid: 2, qty: 1, unit_price: "0.20" },
    ],
    0
  );

  assert.equal(decimalSum.subtotal, "0.30");
  console.log("PASS: Decimal addition remains exact");

  const invalidInputs = [
    () => pricing.calculate([], 0),
    () => pricing.calculate(items, -1),
    () => pricing.calculate(
      [{ pid: 1, qty: 0, unit_price: "10.00" }],
      0
    ),
    () => pricing.calculate(
      [{ pid: 1, qty: 1, unit_price: "-10.00" }],
      0
    ),
    () => pricing.calculate(
      [
        { pid: 1, qty: 1, unit_price: "10.00" },
        { pid: 1, qty: 2, unit_price: "10.00" },
      ],
      0
    ),
  ];

  for (const operation of invalidInputs) {
    assert.throws(operation, { code: "INVALID_INPUT" });
  }
  console.log("PASS: Invalid items, score and duplicate products rejected");

  assert.throws(
    () => pricing.calculate(
      [{ pid: 1, qty: 2, unit_price: "99999999.99" }],
      0
    ),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Subtotal exceeding database limit rejected");

  console.log("Order pricing checks completed successfully");
}

try {
  main();
} catch (err) {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
}