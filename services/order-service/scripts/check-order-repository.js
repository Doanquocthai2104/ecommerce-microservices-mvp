const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");

const requestIds = [randomUUID(), randomUUID()];

// Dữ liệu giả lập cho kiểm tra tầng lưu trữ.
// Chưa kiểm tra sự tồn tại của Customer/Product qua gRPC.
const testUid = 1;

async function main() {
  const repository = new OrderRepository();

  const input = {
    uid: testUid,
    requestId: requestIds[0],
    subtotal: "3025.00",
    discount: "10.00",
    totalAmount: "3015.00",
    items: [
      { pid: 101, qty: 2, unit_price: "1500.00" },
      { pid: 102, qty: 1, unit_price: "25.00" },
    ],
  };

  // 1. Lưu Order.
  const order = await repository.createOrder(input);

  assert.ok(order.oid > 0);
  assert.equal(order.uid, testUid);
  assert.equal(order.subtotal, "3025.00");
  assert.equal(order.discount, "10.00");
  assert.equal(order.total_amount, "3015.00");
  console.log("PASS: Order stored with exact decimal amounts");

  // 2. Lưu đầy đủ chi tiết.
  assert.deepEqual(order.items, input.items);
  console.log("PASS: Order details stored with snapshot prices");

  // 3. Sự kiện Outbox được lưu cùng đơn.
  const outbox = await pool.query(
    `
    SELECT *
    FROM public."OutboxEvent"
    WHERE oid = $1
    `,
    [order.oid]
  );

  assert.equal(outbox.rowCount, 1);

  const event = outbox.rows[0];

  assert.equal(event.event_type, "OrderCreated");
  assert.equal(event.topic, "order-created");
  assert.equal(event.published_at, null);
  assert.equal(event.attempts, 0);
  assert.equal(event.payload.eventId, event.event_id);
  assert.equal(event.payload.data.oid, order.oid);
  assert.deepEqual(event.payload.data.items, input.items);
  console.log("PASS: Pending OrderCreated event stored in Outbox");

  // 4. Đọc theo OID.
  const loaded = await repository.findByOid(order.oid);
  assert.deepEqual(loaded, order);
  console.log("PASS: Order and details retrieved by OID");

  // 5. Đọc danh sách theo UID.
  const list = await repository.listByUid(testUid);
  assert.ok(list.some((item) => item.oid === order.oid));
  console.log("PASS: Order appears in customer order list");

  // 6. Tìm theo mã yêu cầu.
  const existing = await repository.findByRequest(
    testUid,
    input.requestId
  );

  assert.equal(existing.oid, order.oid);
  console.log("PASS: Existing order found by request ID");

  // 7. Không tạo hai đơn cho cùng request.
  await assert.rejects(
    () => repository.createOrder(input),
    (err) =>
      err.code === "23505" &&
      err.constraint === "order_request_unique"
  );

  const count = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM public."Order"
    WHERE uid = $1 AND request_id = $2
    `,
    [testUid, input.requestId]
  );

  assert.equal(count.rows[0].count, 1);
  console.log("PASS: Duplicate request cannot create another order");

  // 8. Chi tiết thứ hai lỗi do trùng PID.
  // Order và chi tiết thứ nhất đã được INSERT trước khi lỗi xảy ra.
  await assert.rejects(
    () => repository.createOrder({
      ...input,
      requestId: requestIds[1],
      items: [
        { pid: 101, qty: 2, unit_price: "1500.00" },
        { pid: 101, qty: 1, unit_price: "25.00" },
      ],
    }),
    (err) =>
      err.code === "23505" &&
      err.constraint === "OrderDetail_pkey"
  );

  const rolledBack = await repository.findByRequest(
    testUid,
    requestIds[1]
  );

  assert.equal(rolledBack, null);
  console.log("PASS: Detail failure rolls back the order transaction");

  console.log("Order repository checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Chỉ xóa dữ liệu thuộc các request kiểm tra lần này.
      await client.query(
        `
        DELETE FROM public."OutboxEvent"
        WHERE oid IN (
          SELECT oid
          FROM public."Order"
          WHERE uid = $1
            AND request_id = ANY($2::uuid[])
        )
        `,
        [testUid, requestIds]
      );

      // OrderDetail được xóa theo ON DELETE CASCADE.
      await client.query(
        `
        DELETE FROM public."Order"
        WHERE uid = $1
          AND request_id = ANY($2::uuid[])
        `,
        [testUid, requestIds]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Test cleanup failed:", err.message);
      process.exitCode = 1;
    } finally {
      client.release();
      await pool.end();
    }
  });