const grpc = require("@grpc/grpc-js");
const { callShipment } = require("./shipment-client");

async function lookupOrderShipment(
  oid,
  authorization,
  waitMs = 0
) {
  const deadline = Date.now() + waitMs;
  let firstAttempt = true;

  while (firstAttempt || Date.now() < deadline) {
    firstAttempt = false;

    const timeoutMs =
      waitMs > 0
        ? Math.max(
            1,
            Math.min(1000, deadline - Date.now())
          )
        : 1000;

    try {
      const shipment = await callShipment(
        "getShipmentByOrder",
        { oid },
        authorization,
        timeoutMs
      );

      return {
        shipid: shipment.shipid,
        oid: shipment.oid,
        status: shipment.status,
      };
    } catch (err) {
      if (err.code !== grpc.status.NOT_FOUND) {
        // Đây là dữ liệu bổ sung cho đơn đã được xác thực.
        // Không biến lỗi tra cứu shipment thành lỗi tạo đơn.
        console.warn(
          "Order shipment lookup unavailable:",
          { oid, code: err.code }
        );

        return null;
      }
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) break;

    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(200, remaining));
    });
  }

  return null;
}

module.exports = lookupOrderShipment;