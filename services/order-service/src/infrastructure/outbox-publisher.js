class OutboxPublisher {
  constructor({ pool, producer, batchSize = 10 }) {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error("Invalid Outbox batch size");
    }

    this.pool = pool;
    this.producer = producer;
    this.batchSize = batchSize;
    this.running = false;
  }

  async publishOne(eventIds, attemptedIds) {
    const client = await this.pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const result = await client.query(
        `
        SELECT e.*
        FROM public."OutboxEvent" e
        JOIN public."OrderRequest" r
          ON r.oid = e.oid
        WHERE r.status = 'COMPLETED'
          AND e.published_at IS NULL
          AND (
            $1::uuid[] IS NULL
            OR e.event_id = ANY($1::uuid[])
          )
          AND NOT (e.event_id = ANY($2::uuid[]))
        ORDER BY e.id
        LIMIT 1
        FOR UPDATE OF e SKIP LOCKED
        `,
        [eventIds, attemptedIds]
      );

      const event = result.rows[0];

      if (!event) {
        await client.query("COMMIT");
        transactionStarted = false;
        return null;
      }

      // Giữ khóa một dòng Outbox trong lúc chờ Kafka.
      // Publisher khác sẽ bỏ qua dòng đang bị khóa.
      try {
        await this.producer.send({
          topic: event.topic,
          acks: -1,
          timeout: 10000,
          messages: [
            {
              key: String(event.oid),
              value: JSON.stringify(event.payload),
              headers: {
                "event-id": event.event_id,
                "event-type": event.event_type,
              },
            },
          ],
        });
      } catch (err) {
        await client.query(
          `
          UPDATE public."OutboxEvent"
          SET
            attempts = attempts + 1,
            last_error = $2
          WHERE id = $1
          `,
          [
            event.id,
            String(err.message || "Kafka publish failed").slice(0, 2000),
          ]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        console.error(
          "Outbox publish failed:",
          event.event_id,
          err.message
        );

        return {
          eventId: event.event_id,
          published: false,
        };
      }

      await client.query(
        `
        UPDATE public."OutboxEvent"
        SET
          published_at = NOW(),
          attempts = attempts + 1,
          last_error = NULL
        WHERE id = $1
        `,
        [event.id]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return {
        eventId: event.event_id,
        published: true,
      };
    } catch (err) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "Outbox rollback failed:",
            rollbackError.message
          );
        }
      }

      throw err;
    } finally {
      client.release();
    }
  }

  async runOnce(eventIds = null, shouldStop = () => false) {
    if (this.running) {
      return { skipped: true, published: 0, failed: 0 };
    }

    this.running = true;

    const summary = {
      skipped: false,
      published: 0,
      failed: 0,
    };

    const attemptedIds = [];

    try {
      for (let index = 0; index < this.batchSize; index += 1) {
        if (shouldStop()) break;

        const result = await this.publishOne(
          eventIds,
          attemptedIds
        );

        if (!result) break;

        attemptedIds.push(result.eventId);

        if (result.published) {
          summary.published += 1;
        } else {
          summary.failed += 1;
        }
      }

      return summary;
    } finally {
      this.running = false;
    }
  }
}

module.exports = OutboxPublisher;