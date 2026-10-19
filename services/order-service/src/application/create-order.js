const AppError = require("../domain/app-error");

// Các mã gRPC cho lỗi đầu vào, không tìm thấy sản phẩm,
// hoặc không đủ tồn kho.
const RESERVATION_REJECTED = new Set([3, 5, 9]);

class CreateOrder {
  constructor({
    requests,
    orders,
    pricing,
    getMembership,
    callInventory,
    coordinator,
  }) {
    this.requests = requests;
    this.orders = orders;
    this.pricing = pricing;
    this.getMembership = getMembership;
    this.callInventory = callInventory;
    this.coordinator = coordinator;
  }

  async settleExisting(request) {
    if (!request) {
      throw new Error("Saved order request is missing");
    }

    if (request.status === "PENDING") {
      return null;
    }

    if (
      request.status === "ORDER_STORED" ||
      request.status === "COMPLETED"
    ) {
      return this.coordinator.complete(request.request_id);
    }

    if (request.status === "CANCEL_PENDING") {
      await this.coordinator.cancel(request.request_id);
    }

    throw new AppError(
      "CONFLICT",
      "Order request has been cancelled; use a new request ID"
    );
  }

  validateReservation(receipt, request) {
    if (
      !receipt ||
      receipt.operationId !== request.request_id ||
      receipt.uid !== request.uid ||
      !["RESERVED", "COMMITTED"].includes(receipt.status) ||
      !Array.isArray(receipt.items)
    ) {
      throw new Error("Inventory returned an unexpected reservation");
    }

    const actualItems = receipt.items
      .map((item) => ({
        pid: item.pid,
        qty: item.qty,
      }))
      .sort((a, b) => a.pid - b.pid);

    if (JSON.stringify(actualItems) !== JSON.stringify(request.items)) {
      throw new Error("Inventory reservation items do not match the request");
    }
  }

  async execute({ actor, authorization, requestId, items }) {
    // actor phải do middleware/handler xác thực tạo ra.
    // Không lấy actor hoặc UID từ JSON do client gửi.
    if (
      !actor ||
      !Number.isInteger(actor.uid) ||
      actor.uid <= 0 ||
      actor.uid > 2147483647
    ) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Authentication is required"
      );
    }

    if (actor.role !== "CUSTOMER") {
      throw new AppError(
        "FORBIDDEN",
        "Only customers can place orders"
      );
    }

    let request = await this.requests.ensureRequest({
      requestId,
      uid: actor.uid,
      items,
    });

    let existingOrder = await this.settleExisting(request);

    if (existingOrder) return existingOrder;

    // Chốt score trước khi giữ hàng.
    if (request.score === null) {
      const membership = await this.getMembership(
        actor.uid,
        authorization
      );

      if (membership.uid !== actor.uid) {
        throw new Error("Membership UID does not match the customer");
      }

      request = await this.requests.saveScore(
        request.request_id,
        membership.score
      );
    }

    existingOrder = await this.settleExisting(request);

    if (existingOrder) return existingOrder;

    let receipt;

    try {
      receipt = await this.callInventory("reserve", {
        operationId: request.request_id,
        uid: request.uid,
        items: request.items,
      });
    } catch (err) {
      if (RESERVATION_REJECTED.has(err.code)) {
        // Ghi ý định hủy và xác nhận Release, kể cả khi
        // Inventory chưa tạo reservation.
        await this.coordinator.cancel(request.request_id);
      }

      // Lỗi kết nối hoặc timeout giữ nguyên tiến trình
      // để có thể thử lại bằng cùng request ID.
      throw err;
    }

    this.validateReservation(receipt, request);

    if (request.pricing === null) {
      let calculated;

      try {
        calculated = this.pricing.calculate(
          receipt.items,
          request.score
        );
      } catch (err) {
        if (err.code === "INVALID_INPUT") {
          await this.coordinator.cancel(request.request_id);
        }

        throw err;
      }

      request = await this.requests.savePricing(
        request.request_id,
        calculated
      );
    }

    existingOrder = await this.settleExisting(request);

    if (existingOrder) return existingOrder;

    const snapshot = request.pricing;

    // Order, OrderDetail, Outbox và ORDER_STORED
    // được lưu trong cùng transaction.
    //
    // Nếu lời gọi này lỗi, không tự Release:
    // kết quả COMMIT của PostgreSQL có thể chưa rõ.
    await this.orders.createOrderForRequest({
      uid: request.uid,
      requestId: request.request_id,
      subtotal: snapshot.subtotal,
      discount: snapshot.discount,
      totalAmount: snapshot.totalAmount,
      items: snapshot.items,
    });

    return this.coordinator.complete(request.request_id);
  }
}

module.exports = CreateOrder;