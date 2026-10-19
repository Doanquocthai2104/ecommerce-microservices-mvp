const { randomUUID } = require("node:crypto");
const pool = require("./database");
const AppError = require("../domain/app-error");

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("INVALID_INPUT", "Order items are required");
  }

  const seen = new Set();

  return items
    .map((item) => {
      if (
        !item ||
        !Number.isInteger(item.pid) ||
        item.pid <= 0 ||
        item.pid > 2147483647 ||
        !Number.isInteger(item.qty) ||
        item.qty <= 0 ||
        item.qty > 2147483647 ||
        seen.has(item.pid)
      ) {
        throw new AppError("INVALID_INPUT", "Invalid or duplicate order item");
      }

      seen.add(item.pid);

      return {
        pid: item.pid,
        qty: item.qty,
      };
    })
    .sort((a, b) => a.pid - b.pid);
}

class OrderRepository {
  constructor(databasePool = pool) {
    this.pool = databasePool;
  }

  // Dành cho kiểm tra lưu trữ độc lập đã có trước đây.
  async createOrder(input) {
    return this.storeOrder(input, false);
  }

  // Luồng đặt hàng thực tế sẽ sử dụng hàm này.
  async createOrderForRequest(input) {
    return this.storeOrder(input, true);
  }

  async storeOrder(input, trackRequest) {
    const {
      uid,
      requestId,
      subtotal,
      discount,
      totalAmount,
      items,
    } = input;

    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError("INVALID_INPUT", "Order items are required");
    }

    const client = await this.pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      if (trackRequest) {
        const requestResult = await client.query(
          `
          SELECT *
          FROM public."OrderRequest"
          WHERE request_id = $1
          FOR UPDATE
          `,
          [requestId]
        );

        const request = requestResult.rows[0];

        if (!request) {
          throw new AppError("NOT_FOUND", "Order request not found");
        }

        if (
          request.uid !== uid ||
          JSON.stringify(normalizeItems(request.items)) !==
            JSON.stringify(normalizeItems(items))
        ) {
          throw new AppError(
            "CONFLICT",
            "Order data does not match the saved request"
          );
        }

        // Sau khi chờ khóa, yêu cầu lặp có thể thấy đơn đã được lưu.
        if (
          request.status === "ORDER_STORED" ||
          request.status === "COMPLETED"
        ) {
          const existing = await this.readOrder(client, request.oid);

          if (!existing) {
            throw new Error("Saved order request references a missing order");
          }

          await client.query("COMMIT");
          transactionStarted = false;

          return existing;
        }

        if (request.status !== "PENDING") {
          throw new AppError(
            "CONFLICT",
            "Cancelled order request cannot create an order"
          );
        }
      }

      const orderResult = await client.query(
        `
        INSERT INTO public."Order" (
          uid,
          request_id,
          subtotal,
          discount,
          total_amount
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [uid, requestId, subtotal, discount, totalAmount]
      );

      const order = orderResult.rows[0];
      const details = [];

      for (const item of items) {
        const detailResult = await client.query(
          `
          INSERT INTO public."OrderDetail" (
            oid,
            pid,
            qty,
            unit_price
          )
          VALUES ($1, $2, $3, $4)
          RETURNING pid, qty, unit_price
          `,
          [order.oid, item.pid, item.qty, item.unit_price]
        );

        details.push(detailResult.rows[0]);
      }

      const eventId = randomUUID();

      const event = {
        eventId,
        eventType: "OrderCreated",
        occurredAt: order.created_at.toISOString(),
        data: {
          oid: order.oid,
          uid: order.uid,
          subtotal: order.subtotal,
          discount: order.discount,
          total_amount: order.total_amount,
          items: details,
        },
      };

      await client.query(
        `
        INSERT INTO public."OutboxEvent" (
          event_id,
          oid,
          event_type,
          topic,
          payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        `,
        [
          eventId,
          order.oid,
          "OrderCreated",
          "order-created",
          JSON.stringify(event),
        ]
      );

      if (trackRequest) {
        const updated = await client.query(
          `
          UPDATE public."OrderRequest"
          SET
            status = 'ORDER_STORED',
            oid = $2,
            updated_at = NOW()
          WHERE request_id = $1
            AND status = 'PENDING'
          RETURNING request_id
          `,
          [requestId, order.oid]
        );

        if (updated.rowCount !== 1) {
          throw new AppError(
            "CONFLICT",
            "Order request state could not be updated"
          );
        }
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return {
        ...order,
        items: details,
      };
    } catch (err) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Order rollback failed:", rollbackError.message);
        }
      }

      throw err;
    } finally {
      client.release();
    }
  }

  async readOrder(queryable, oid) {
    const result = await queryable.query(
      `SELECT * FROM public."Order" WHERE oid = $1`,
      [oid]
    );

    if (!result.rows[0]) return null;

    const details = await queryable.query(
      `
      SELECT pid, qty, unit_price
      FROM public."OrderDetail"
      WHERE oid = $1
      ORDER BY pid
      `,
      [oid]
    );

    return {
      ...result.rows[0],
      items: details.rows,
    };
  }

  async findByOid(oid) {
    return this.readOrder(this.pool, oid);
  }

  async findByRequest(uid, requestId) {
    const result = await this.pool.query(
      `
      SELECT oid
      FROM public."Order"
      WHERE uid = $1 AND request_id = $2
      `,
      [uid, requestId]
    );

    if (!result.rows[0]) return null;

    return this.findByOid(result.rows[0].oid);
  }

  async listByUid(uid) {
    const result = await this.pool.query(
      `
      SELECT *
      FROM public."Order"
      WHERE uid = $1
      ORDER BY oid DESC
      `,
      [uid]
    );

    return result.rows;
  }
}

module.exports = OrderRepository;