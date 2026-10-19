const AppError = require("../domain/app-error");

class OrderInventoryCoordinator {
  constructor({ requests, orders, callInventory }) {
    this.requests = requests;
    this.orders = orders;
    this.callInventory = callInventory;
  }

  toInventoryRequest(request) {
    return {
      operationId: request.request_id,
      uid: request.uid,
      items: request.items.map((item) => ({
        pid: item.pid,
        qty: item.qty,
      })),
    };
  }

  validateReceipt(receipt, request, expectedStatus) {
    if (
      !receipt ||
      receipt.operationId !== request.request_id ||
      receipt.uid !== request.uid ||
      receipt.status !== expectedStatus
    ) {
      throw new Error("Inventory returned an unexpected receipt");
    }
  }

  async readOrder(request) {
    const order = await this.orders.findByOid(request.oid);

    if (!order) {
      throw new Error("Order request references a missing order");
    }

    return order;
  }

  async complete(requestId) {
    const request = await this.requests.findByRequestId(requestId);

    if (!request) {
      throw new AppError("NOT_FOUND", "Order request not found");
    }

    if (request.status === "COMPLETED") {
      return this.readOrder(request);
    }

    if (request.status !== "ORDER_STORED") {
      throw new AppError(
        "CONFLICT",
        "Only a stored order can commit inventory"
      );
    }

    // Nếu RPC lỗi, ORDER_STORED được giữ nguyên để thử lại.
    // Commit của Inventory đã hỗ trợ gọi lặp.
    const receipt = await this.callInventory(
      "commit",
      this.toInventoryRequest(request)
    );

    this.validateReceipt(receipt, request, "COMMITTED");

    // Nếu cập nhật DB lỗi sau Commit, lần thử tiếp theo
    // sẽ gọi Commit lặp rồi tiếp tục cập nhật trạng thái.
    const completed = await this.requests.markCompleted(requestId);

    return this.readOrder(completed);
  }

  async cancel(requestId) {
    // Ghi ý định hủy trước khi gọi RPC.
    // Hàm này từ chối yêu cầu đã lưu đơn.
    const request = await this.requests.beginCancellation(requestId);

    if (request.status === "CANCELLED") {
      return request;
    }

    const receipt = await this.callInventory(
      "release",
      this.toInventoryRequest(request)
    );

    this.validateReceipt(receipt, request, "RELEASED");

    return this.requests.markCancelled(requestId);
  }
}

module.exports = OrderInventoryCoordinator;