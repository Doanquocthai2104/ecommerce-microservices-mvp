const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const database = require("../src/infrastructure/database");
const pool = database.pool || database;

const OrderRequestRepository = require(
  "../src/infrastructure/order-request-repository"
);

const repository = new OrderRequestRepository(pool);
const createdIds = [];

function newRequestId() {
  const id = randomUUID();
  createdIds.push(id);
  return id;
}

async function expectAppError(action, expectedCode) {
  await assert.rejects(action, (err) => {
    assert.equal(
      err.code,
      expectedCode,
      `Expected ${expectedCode}, received ${err.code}: ${err.message}`
    );
    return true;
  });
}

async function main() {
  const request = {
    requestId: newRequestId(),
    uid: 2147483000,
    items: [
      { pid: 102, qty: 1 },
      { pid: 101, qty: 2 },
    ],
  };

  const created = await repository.ensureRequest(request);

  assert.equal(created.request_id, request.requestId);
  assert.equal(created.uid, request.uid);
  assert.equal(created.status, "PENDING");
  assert.equal(created.oid, null);
  assert.equal(created.score, null);
  assert.equal(created.pricing, null);

  assert.deepEqual(created.items, [
    { pid: 101, qty: 2 },
    { pid: 102, qty: 1 },
  ]);

  console.log("PASS: New request stored as PENDING with normalized items");

  const repeated = await repository.ensureRequest({
    ...request,
    items: [...request.items].reverse(),
  });

  assert.equal(repeated.request_id, created.request_id);
  assert.equal(repeated.request_hash, created.request_hash);

  console.log("PASS: Reordered items return the existing request");

  await expectAppError(
    () =>
      repository.ensureRequest({
        ...request,
        items: [
          { pid: 101, qty: 3 },
          { pid: 102, qty: 1 },
        ],
      }),
    "CONFLICT"
  );

  console.log("PASS: Same request ID with different quantities rejected");

  await expectAppError(
    () =>
      repository.ensureRequest({
        ...request,
        uid: request.uid - 1,
      }),
    "CONFLICT"
  );

  console.log("PASS: Different customer cannot reuse the request ID");

  const concurrentRequest = {
    ...request,
    requestId: newRequestId(),
  };

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      repository.ensureRequest(concurrentRequest)
    )
  );

  assert.ok(
    results.every(
      (result) => result.request_id === concurrentRequest.requestId
    )
  );

  const countResult = await pool.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public."OrderRequest"
      WHERE request_id = $1
    `,
    [concurrentRequest.requestId]
  );

  assert.equal(countResult.rows[0].count, 1);

  console.log("PASS: Concurrent identical requests create only one record");

  await expectAppError(
    () =>
      repository.ensureRequest({
        ...request,
        requestId: newRequestId(),
        items: [
          { pid: 101, qty: 1 },
          { pid: 101, qty: 2 },
        ],
      }),
    "INVALID_INPUT"
  );

  await expectAppError(
    () =>
      repository.ensureRequest({
        ...request,
        requestId: newRequestId(),
        items: [{ pid: 101, qty: 0 }],
      }),
    "INVALID_INPUT"
  );

  await expectAppError(
    () =>
      repository.ensureRequest({
        ...request,
        requestId: newRequestId(),
        items: [{ pid: 101, qty: 1, unit_price: "0.01" }],
      }),
    "INVALID_INPUT"
  );

  console.log("PASS: Duplicate products, invalid quantities and client prices rejected");

  await expectAppError(
    () =>
      repository.ensureRequest({
        ...request,
        requestId: "invalid-id",
      }),
    "INVALID_INPUT"
  );

  const missing = await repository.findByRequestId(randomUUID());
  assert.equal(missing, null);

  console.log("PASS: Invalid request ID rejected and missing request returns null");

  const unchanged = await repository.findByRequestId(request.requestId);
  assert.deepEqual(unchanged.items, created.items);
  assert.equal(unchanged.uid, created.uid);
  assert.equal(unchanged.status, "PENDING");

  console.log("PASS: Rejected requests preserve the original data");

  console.log("Order request repository checks completed successfully");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    try {
      // Chỉ dọn các yêu cầu thử nghiệm do lần chạy này tạo.
      await pool.query(
        `
          DELETE FROM public."OrderRequest"
          WHERE request_id = ANY($1::uuid[])
        `,
        [createdIds]
      );
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