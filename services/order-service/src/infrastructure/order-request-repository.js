const { createHash } = require("node:crypto");

const database = require("./database");
const AppError = require("../domain/app-error");

const defaultPool = database.pool || database;

function positiveInteger(value) {
  return (
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647
  );
}

function normalizeRequestId(requestId) {
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestId
    )
  ) {
    throw new AppError("INVALID_INPUT", "Invalid request ID");
  }

  return requestId.toLowerCase();
}

function normalizeRequest({ requestId, uid, items }) {
  const normalizedId = normalizeRequestId(requestId);

  if (!positiveInteger(uid)) {
    throw new AppError("INVALID_INPUT", "Invalid customer UID");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("INVALID_INPUT", "Order items are required");
  }

  const seen = new Set();

  const normalizedItems = items.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (field) => !["pid", "qty"].includes(field)
      ) ||
      !positiveInteger(item.pid) ||
      !positiveInteger(item.qty)
    ) {
      throw new AppError("INVALID_INPUT", "Invalid order item");
    }

    if (seen.has(item.pid)) {
      throw new AppError("INVALID_INPUT", "Duplicate product");
    }

    seen.add(item.pid);

    return {
      pid: item.pid,
      qty: item.qty,
    };
  });

  normalizedItems.sort((a, b) => a.pid - b.pid);

  // Thứ tự sản phẩm khác nhau vẫn được coi là cùng nội dung.
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ uid, items: normalizedItems }))
    .digest("hex");

  return {
    requestId: normalizedId,
    uid,
    items: normalizedItems,
    requestHash,
  };
}

class OrderRequestRepository {
  constructor(pool = defaultPool) {
    this.pool = pool;
  }

  async findByRequestId(requestId) {
    const normalizedId = normalizeRequestId(requestId);

    const result = await this.pool.query(
      `
        SELECT *
        FROM public."OrderRequest"
        WHERE request_id = $1
      `,
      [normalizedId]
    );

    return result.rows[0] || null;
  }

  async ensureRequest(input) {
    const request = normalizeRequest(input);

    // PostgreSQL bảo đảm chỉ một bản ghi cho mỗi request_id,
    // kể cả khi nhiều yêu cầu đến đồng thời.
    await this.pool.query(
      `
        INSERT INTO public."OrderRequest" (
          request_id,
          uid,
          request_hash,
          items
        )
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (request_id) DO NOTHING
      `,
      [
        request.requestId,
        request.uid,
        request.requestHash,
        JSON.stringify(request.items),
      ]
    );

    const existing = await this.findByRequestId(request.requestId);

    if (!existing) {
      throw new Error("Order request could not be retrieved");
    }

    if (
      existing.uid !== request.uid ||
      existing.request_hash !== request.requestHash
    ) {
      throw new AppError(
        "CONFLICT",
        "Request ID has already been used with different order data"
      );
    }

    return existing;
  }
}

module.exports = OrderRequestRepository;