const Decimal = require("decimal.js");
const AppError = require("./app-error");

const Money = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

function invalid(message) {
  throw new AppError("INVALID_INPUT", message);
}

class OrderPricing {
  constructor(tiers) {
    if (
      !Array.isArray(tiers) ||
      tiers.length === 0 ||
      !tiers.every(
        (tier) =>
          tier &&
          Number.isInteger(tier.minScore) &&
          tier.minScore >= 0 &&
          tier.minScore <= 2147483647 &&
          Number.isInteger(tier.percent) &&
          tier.percent >= 0 &&
          tier.percent <= 100
      )
    ) {
      throw new Error("Invalid discount configuration");
    }

    this.tiers = tiers
      .map((tier) => ({
        minScore: tier.minScore,
        percent: tier.percent,
      }))
      .sort((a, b) => a.minScore - b.minScore);

    if (
      this.tiers[0].minScore !== 0 ||
      new Set(this.tiers.map((tier) => tier.minScore)).size
        !== this.tiers.length
    ) {
      throw new Error(
        "Discount tiers must start at score 0 and have unique thresholds"
      );
    }
  }

  calculate(items, score) {
    if (
      !Number.isInteger(score) ||
      score < 0 ||
      score > 2147483647
    ) {
      invalid("Invalid membership score");
    }

    if (!Array.isArray(items) || items.length === 0) {
      invalid("Order must contain at least one item");
    }

    const seenPids = new Set();
    const normalizedItems = [];
    let subtotal = new Money(0);

    for (const item of items) {
      if (
        !item ||
        !Number.isInteger(item.pid) ||
        item.pid <= 0 ||
        item.pid > 2147483647
      ) {
        invalid("Invalid product ID");
      }

      if (seenPids.has(item.pid)) {
        invalid("Each product must appear only once");
      }

      seenPids.add(item.pid);

      if (
        !Number.isInteger(item.qty) ||
        item.qty <= 0 ||
        item.qty > 2147483647
      ) {
        invalid("Quantity must be a positive integer");
      }

      if (
        typeof item.unit_price !== "string" ||
        !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(item.unit_price)
      ) {
        invalid("Invalid product price");
      }

      const price = new Money(item.unit_price);
      subtotal = subtotal.plus(price.times(item.qty));

      // Phù hợp các cột DECIMAL(10,2) của Order.
      if (subtotal.gt("99999999.99")) {
        invalid("Order subtotal exceeds the supported limit");
      }

      normalizedItems.push({
        pid: item.pid,
        qty: item.qty,
        unit_price: price.toFixed(2),
      });
    }

    let discountPercent = 0;

    for (const tier of this.tiers) {
      if (score >= tier.minScore) {
        discountPercent = tier.percent;
      }
    }

    const discount = subtotal
      .times(discountPercent)
      .dividedBy(100)
      .toDecimalPlaces(2);

    const totalAmount = subtotal.minus(discount);

    return {
      subtotal: subtotal.toFixed(2),
      discount: discount.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      discountPercent,
      items: normalizedItems.sort((a, b) => a.pid - b.pid),
    };
  }
}

module.exports = OrderPricing;