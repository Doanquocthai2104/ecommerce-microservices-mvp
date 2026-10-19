const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const OrderRepository = require("../src/infrastructure/order-repository");
const OrderRequestRepository = require(
  "../src/infrastructure/order-request-repository"
);

const orders = new OrderRepository();
const requests = new OrderRequestRepository();
const createdIds = [];

async function createRequest() {
  const requestId = randomUUID();
  createdIds.push(requestId);

  const input = {
    requestId,
    uid: 2147483000,
    items: [{ pid: 101, qty: 2 }],
  };

  await requests.ensureRequest(input);

  return {
    ...input,
    subtotal: "25.00",
    discount: "0.00",
    totalAmount: "25.00",
    items: [{ pid: 101, qty: 2, unit_price: "12.50" }],
  };
}

async function main() {
  const input = await createRequest();

  const order = await orders.createOrderForRequest(input);
  const request = await requests.findByRequestId(input.requestId);

  assert.equal(request.status, "ORDER_STORED");
  assert.equal(request.oid, order.oid);
  assert.equal(order.items.length, 1);
  assert.equal(order.total_amount, "25.00");

  const eventResult = await pool.query(
    `
    SELECT *
    FROM public."OutboxEvent"
    WHERE oid = $1
    `,
    [order.oid]
  );

  assert.equal(eventResult.rowCount, 1);
  assert.equal(eventResult.rows[0].payload.data.oid, order.oid);

  console.log("PASS: Order, details, Outbox and request state stored together");

  const repeated = await orders.createOrderForRequest(input);
  assert.equal(repeated.oid, order.oid);

  console.log("PASS: Repeated storage returns the existing order");

  const concurrentInput = await createRequest();

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      orders.createOrderForRequest(concurrentInput)
    )
  );

  assert.equal(new Set(results.map((result) => result.oid)).size, 1);

  const counts = await pool.query(
    `
    SELECT
      (
        SELECT COUNT(*)::int
        FROM public."Order"
        WHERE request_id = $1
      ) AS orders,
      (
        SELECT COUNT(*)::int
        FROM public."OutboxEvent"
        WHERE oid IN (
          SELECT oid
          FROM public."Order"
          WHERE request_id = $1
        )
      ) AS events
    `,
    [concurrentInput.requestId]
  );

  assert.equal(counts.rows[0].orders, 1);
  assert.equal(counts.rows[0].events, 1);

  console.log("PASS: Concurrent storage creates one order and one event");

  const mismatchInput = await createRequest();

  await assert.rejects(
    () =>
      orders.createOrderForRequest({
        ...mismatchInput,
        items: [{ pid: 101, qty: 3, unit_price: "12.50" }],
      }),
    (err) => err.code === "CONFLICT"
  );

  assert.equal(
    await orders.findByRequest(mismatchInput.uid, mismatchInput.requestId),
    null
  );

  console.log("PASS: Mismatched items cannot create an order");

  const failedInput = await createRequest();

  // Dùng kết nối PostgreSQL thật, nhưng cố ý phát sinh lỗi
  // ngay trước UPDATE OrderRequest, sau khi đã INSERT Outbox.
  let failureInjected = false;

  const failingPool = {
    async connect() {
      const client = await pool.connect();

      return {
        async query(sql, parameters) {
          if (
            typeof sql === "string" &&
            /UPDATE\s+public\."OrderRequest"/i.test(sql)
          ) {
            failureInjected = true;
            throw new Error("Simulated request state update failure");
          }

          return client.query(sql, parameters);
        },

        release() {
          client.release();
        },
      };
    },
  };

  const failingOrders = new OrderRepository(failingPool);

  await assert.rejects(
    () => failingOrders.createOrderForRequest(failedInput),
    /Simulated request state update failure/
  );

  assert.equal(failureInjected, true);

  const failedRequest = await requests.findByRequestId(
    failedInput.requestId
  );

  assert.equal(failedRequest.status, "PENDING");
  assert.equal(failedRequest.oid, null);

  assert.equal(
    await orders.findByRequest(failedInput.uid, failedInput.requestId),
    null
  );

  // Payload chứa request riêng không có, nên kiểm tra bằng UID/PID
  // chưa đủ. Kiểm tra các bản ghi con bị mồ côi trên toàn DB.
  const orphanCounts = await pool.query(`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM public."OrderDetail" d
        LEFT JOIN public."Order" o ON o.oid = d.oid
        WHERE o.oid IS NULL
      ) AS details,
      (
        SELECT COUNT(*)::int
        FROM public."OutboxEvent" e
        LEFT JOIN public."Order" o ON o.oid = e.oid
        WHERE o.oid IS NULL
      ) AS events
  `);

  assert.equal(orphanCounts.rows[0].details, 0);
  assert.equal(orphanCounts.rows[0].events, 0);

  console.log("PASS: Late failure rolls back order and preserves PENDING");

  const recovered = await orders.createOrderForRequest(failedInput);

  const recoveredRequest = await requests.findByRequestId(
    failedInput.requestId
  );

  assert.equal(recoveredRequest.status, "ORDER_STORED");
  assert.equal(recoveredRequest.oid, recovered.oid);

  console.log("PASS: Request can be retried after transaction rollback");

  const cancelledInput = await createRequest();

  await pool.query(
    `
    UPDATE public."OrderRequest"
    SET status = 'CANCELLED', updated_at = NOW()
    WHERE request_id = $1
    `,
    [cancelledInput.requestId]
  );

  await assert.rejects(
    () => orders.createOrderForRequest(cancelledInput),
    (err) => err.code === "CONFLICT"
  );

  console.log("PASS: Cancelled request cannot create an order");

  console.log("Order request transaction checks completed successfully");
}

async function cleanup() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM public."OrderRequest"
      WHERE request_id = ANY($1::uuid[])
      `,
      [createdIds]
    );

    await client.query(
      `
      DELETE FROM public."OutboxEvent"
      WHERE oid IN (
        SELECT oid
        FROM public."Order"
        WHERE request_id = ANY($1::uuid[])
      )
      `,
      [createdIds]
    );

    await client.query(
      `
      DELETE FROM public."Order"
      WHERE request_id = ANY($1::uuid[])
      `,
      [createdIds]
    );

    // OrderDetail được xóa theo ON DELETE CASCADE.
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    try {
      await cleanup();
    } catch (err) {
      console.error("Cleanup failed:", err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});