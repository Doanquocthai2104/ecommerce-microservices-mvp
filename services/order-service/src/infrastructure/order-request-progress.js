const OrderRequestLifecycle = require("./order-request-lifecycle");
const AppError = require("../domain/app-error");

class OrderRequestProgress extends OrderRequestLifecycle {
  async saveScore(requestId, score) {
    if (
      !Number.isInteger(score) ||
      score < 0 ||
      score > 2147483647
    ) {
      throw new AppError("INVALID_INPUT", "Invalid membership score");
    }

    const result = await this.pool.query(
      `
      UPDATE public."OrderRequest"
      SET
        score = COALESCE(score, $2),
        updated_at = NOW()
      WHERE request_id = $1
        AND status = 'PENDING'
      RETURNING *
      `,
      [requestId, score]
    );

    return result.rows[0] || this.findByRequestId(requestId);
  }

  async savePricing(requestId, pricing) {
    const result = await this.pool.query(
      `
      UPDATE public."OrderRequest"
      SET
        pricing = COALESCE(pricing, $2::jsonb),
        updated_at = NOW()
      WHERE request_id = $1
        AND status = 'PENDING'
      RETURNING *
      `,
      [requestId, JSON.stringify(pricing)]
    );

    return result.rows[0] || this.findByRequestId(requestId);
  }
}

module.exports = OrderRequestProgress;