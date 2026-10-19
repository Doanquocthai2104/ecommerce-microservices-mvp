const database = require("../src/infrastructure/database");

// Hỗ trợ cả module.exports = pool
// và module.exports = { pool }.
const pool = database.pool || database;

async function main() {
  if (
    typeof pool.connect !== "function" ||
    typeof pool.end !== "function"
  ) {
    throw new Error(
      "database.js must export a PostgreSQL Pool or an object containing pool"
    );
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS public."OrderRequest" (
        request_id UUID PRIMARY KEY,

        uid INTEGER NOT NULL
          CHECK (uid > 0),

        request_hash VARCHAR(64) NOT NULL
          CHECK (request_hash ~ '^[0-9a-f]{64}$'),

        items JSONB NOT NULL
          CHECK (
            CASE
              WHEN jsonb_typeof(items) = 'array'
              THEN jsonb_array_length(items) > 0
              ELSE FALSE
            END
          ),

        score INTEGER
          CHECK (score >= 0),

        pricing JSONB
          CHECK (jsonb_typeof(pricing) = 'object'),

        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
          CHECK (
            status IN (
              'PENDING',
              'ORDER_STORED',
              'COMPLETED',
              'CANCEL_PENDING',
              'CANCELLED'
            )
          ),

        oid INTEGER UNIQUE
          REFERENCES public."Order"(oid),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT order_request_status_oid_check CHECK (
          (
            status IN ('ORDER_STORED', 'COMPLETED')
            AND oid IS NOT NULL
          )
          OR
          (
            status IN ('PENDING', 'CANCEL_PENDING', 'CANCELLED')
            AND oid IS NULL
          )
        )
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS order_request_recovery_idx
      ON public."OrderRequest" (updated_at, request_id)
      WHERE status IN (
        'PENDING',
        'ORDER_STORED',
        'CANCEL_PENDING'
      );
    `);

    await client.query("COMMIT");
    transactionStarted = false;

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'Order',
          'OrderDetail',
          'OutboxEvent',
          'OrderRequest'
        )
      ORDER BY table_name;
    `);

    console.table(result.rows);
    console.log("Order request table initialized successfully");
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

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
    if (typeof pool.end === "function") {
      try {
        await pool.end();
      } catch (err) {
        console.error("Database shutdown failed:", err.message);
        process.exitCode = 1;
      }
    }
  }
}

run();