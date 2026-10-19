const OrderRequestRepository = require("./order-request-repository");
const AppError = require("../domain/app-error");

class OrderRequestLifecycle extends OrderRequestRepository {
  async transition(requestId, allowedStatuses, targetStatus) {
    if (
      typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestId
      )
    ) {
      throw new AppError("INVALID_INPUT", "Invalid request ID");
    }

    // UPDATE có điều kiện giúp các thao tác đồng thời
    // không ghi đè một trạng thái không còn hợp lệ.
    const result = await this.pool.query(
      `
      UPDATE public."OrderRequest"
      SET
        status = $2,
        updated_at = NOW()
      WHERE request_id = $1
        AND status = ANY($3::varchar[])
      RETURNING *
      `,
      [requestId, targetStatus, allowedStatuses]
    );

    if (result.rows[0]) {
      return result.rows[0];
    }

    const existing = await this.findByRequestId(requestId);

    if (!existing) {
      throw new AppError("NOT_FOUND", "Order request not found");
    }

    // Gọi lặp lại thao tác đã thành công vẫn trả kết quả cũ.
    if (existing.status === targetStatus) {
      return existing;
    }

    throw new AppError(
      "CONFLICT",
      `Cannot change order request from ${existing.status} to ${targetStatus}`
    );
  }

  // Chỉ gọi sau khi Inventory xác nhận COMMITTED.
  async markCompleted(requestId) {
    return this.transition(
      requestId,
      ["ORDER_STORED"],
      "COMPLETED"
    );
  }

  // Ghi ý định hủy trước khi gọi Inventory Release.
  async beginCancellation(requestId) {
    const result = await this.pool.query(
      `
      UPDATE public."OrderRequest"
      SET
        status = 'CANCEL_PENDING',
        updated_at = NOW()
      WHERE request_id = $1
        AND status = 'PENDING'
      RETURNING *
      `,
      [requestId]
    );

    if (result.rows[0]) {
      return result.rows[0];
    }

    const existing = await this.findByRequestId(requestId);

    if (!existing) {
      throw new AppError("NOT_FOUND", "Order request not found");
    }

    if (
      existing.status === "CANCEL_PENDING" ||
      existing.status === "CANCELLED"
    ) {
      return existing;
    }

    throw new AppError(
      "CONFLICT",
      "An order already stored cannot release its inventory"
    );
  }

  // Chỉ gọi sau khi Inventory xác nhận RELEASED.
  async markCancelled(requestId) {
    return this.transition(
      requestId,
      ["CANCEL_PENDING"],
      "CANCELLED"
    );
  }
}

module.exports = OrderRequestLifecycle;