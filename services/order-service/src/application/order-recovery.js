class OrderRecovery {
  constructor({
    pool,
    coordinator,
    pendingTimeoutMs = 300000,
    retryDelayMs = 10000,
    batchSize = 25,
  }) {
    if (
      !Number.isInteger(pendingTimeoutMs) ||
      pendingTimeoutMs <= 0 ||
      !Number.isInteger(retryDelayMs) ||
      retryDelayMs < 0 ||
      !Number.isInteger(batchSize) ||
      batchSize <= 0
    ) {
      throw new Error("Invalid recovery configuration");
    }

    this.pool = pool;
    this.coordinator = coordinator;
    this.pendingTimeoutMs = pendingTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.batchSize = batchSize;
    this.running = false;
  }

  // requestIds dùng khi muốn phục hồi một nhóm yêu cầu cụ thể.
  // Mặc định null: xét toàn bộ yêu cầu đủ điều kiện.
  async runOnce(requestIds = null, shouldStop = () => false) {
    if (this.running) {
      return { skipped: true, recovered: 0, failed: 0 };
    }

    this.running = true;

    const summary = {
      skipped: false,
      recovered: 0,
      failed: 0,
    };

    try {
      const now = Date.now();

      const pendingCutoff = new Date(
        now - this.pendingTimeoutMs
      );

      const retryCutoff = new Date(
        now - this.retryDelayMs
      );

      const result = await this.pool.query(
        `
        SELECT request_id, status
        FROM public."OrderRequest"
        WHERE (
          (
            status = 'PENDING'
            AND updated_at <= $1
          )
          OR
          (
            status IN ('ORDER_STORED', 'CANCEL_PENDING')
            AND updated_at <= $2
          )
        )
        AND (
          $4::uuid[] IS NULL
          OR request_id = ANY($4::uuid[])
        )
        ORDER BY updated_at, request_id
        LIMIT $3
        `,
        [
          pendingCutoff,
          retryCutoff,
          this.batchSize,
          requestIds,
        ]
      );

      for (const request of result.rows) {
        if (shouldStop()) {
        break;
        }
        try {
          if (request.status === "PENDING") {
            // Kiểm tra lại độ cũ ngay trong UPDATE.
            // Nếu luồng đặt hàng vừa tiến triển hoặc lưu đơn,
            // worker không được hủy dựa trên dữ liệu đọc cũ.
            const claimed = await this.pool.query(
              `
              UPDATE public."OrderRequest"
              SET
                status = 'CANCEL_PENDING',
                updated_at = NOW()
              WHERE request_id = $1
                AND status = 'PENDING'
                AND updated_at <= $2
              RETURNING request_id
              `,
              [request.request_id, pendingCutoff]
            );

            if (claimed.rowCount === 0) {
              continue;
            }

            await this.coordinator.cancel(request.request_id);
          } else if (request.status === "ORDER_STORED") {
            await this.coordinator.complete(request.request_id);
          } else {
            await this.coordinator.cancel(request.request_id);
          }

          summary.recovered += 1;
        } catch (err) {
          summary.failed += 1;

          console.error(
            "Order recovery failed:",
            request.request_id,
            err.message
          );

          // Đẩy thời điểm thử tiếp theo, tránh một yêu cầu lỗi
          // luôn đứng đầu batch và chặn các yêu cầu khác.
          await this.pool.query(
            `
            UPDATE public."OrderRequest"
            SET updated_at = NOW()
            WHERE request_id = $1
              AND status IN (
                'PENDING',
                'ORDER_STORED',
                'CANCEL_PENDING'
              )
            `,
            [request.request_id]
          );
        }
      }

      return summary;
    } finally {
      this.running = false;
    }
  }
}

module.exports = OrderRecovery;