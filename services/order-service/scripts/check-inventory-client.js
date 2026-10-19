const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  grpc,
  callInventory,
  closeInventoryClient,
} = require("../src/infrastructure/inventory-client");

async function expectGrpcError(action, expectedCode) {
  await assert.rejects(action, (err) => {
    assert.equal(
      err.code,
      expectedCode,
      `Expected gRPC code ${expectedCode}, received ${err.code}: ${err.details}`
    );
    return true;
  });
}

async function main() {
  const request = {
    operationId: randomUUID(),
    uid: 2147483000,
    items: [{ pid: 2147483000, qty: 1 }],
  };

  // Dữ liệu không hợp lệ phải bị từ chối trước khi giữ hàng.
  await expectGrpcError(
    () =>
      callInventory("reserve", {
        ...request,
        operationId: randomUUID(),
        items: [{ pid: 2147483000, qty: 0 }],
      }),
    grpc.status.INVALID_ARGUMENT
  );

  console.log("PASS: Order client receives inventory validation errors");

  // Hủy trước khi giữ hàng chỉ tạo bản ghi RELEASED.
  // Không cần sản phẩm tồn tại và không tăng tồn kho.
  const released = await callInventory("release", request);

  assert.equal(released.operationId, request.operationId);
  assert.equal(released.uid, request.uid);
  assert.equal(released.status, "RELEASED");
  assert.deepEqual(released.items, []);

  console.log("PASS: Order client authenticates and cancels before reserve");

  const repeated = await callInventory("release", request);
  assert.deepEqual(repeated, released);

  console.log("PASS: Repeated cancellation returns the same receipt");

  await expectGrpcError(
    () => callInventory("reserve", request),
    grpc.status.ALREADY_EXISTS
  );

  console.log("PASS: Late reserve after cancellation is rejected");

  await expectGrpcError(
    () => callInventory("commit", request),
    grpc.status.ALREADY_EXISTS
  );

  console.log("PASS: Cancelled operation cannot be committed");

  console.log("Order inventory client checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    closeInventoryClient();
  });