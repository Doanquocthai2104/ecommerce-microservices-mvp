const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");

const {
  mongoose,
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Product = require("../src/infrastructure/product-model");
const ProductRepository = require("../src/infrastructure/product-repository");
const StockOperation = require("../src/infrastructure/stock-operation-model");

let testPid;
const operationIds = [];

function makeOperation(qty) {
  const operationId = randomUUID();
  operationIds.push(operationId);

  const uid = 1; // Dữ liệu giả lập cho kiểm tra lưu trữ.
  const requestItems = [{ pid: testPid, qty }];

  const requestHash = createHash("sha256")
    .update(JSON.stringify({ uid, items: requestItems }))
    .digest("hex");

  return {
    _id: operationId,
    uid,
    requestHash,
    requestItems,
    items: [
      {
        pid: testPid,
        qty,
        unit_price: "100.00",
      },
    ],
    status: "RESERVED",
  };
}

async function changeStockAndRecord(operation, failAfterWrite = false) {
  await mongoose.connection.transaction(async (session) => {
    const qty = operation.requestItems[0].qty;

    const changed = await Product.updateOne(
      {
        pid: testPid,
        quantity: { $gte: qty },
      },
      {
        $inc: { quantity: -qty },
      },
      { session }
    );

    assert.equal(changed.modifiedCount, 1);

    await StockOperation.create(
      [operation],
      { session }
    );

    if (failAfterWrite) {
      throw new Error("INTENTIONAL_ROLLBACK");
    }
  });
}

async function main() {
  await connectDatabase();

  const repository = new ProductRepository();
  await repository.initialize();
  await StockOperation.init();

  const product = await repository.create({
    pname: "Stock transaction test",
    price: "100.00",
    quantity: 5,
  });

  testPid = product.pid;

  // 1. Commit đồng thời thay đổi kho và bản ghi thao tác.
  const committed = makeOperation(2);
  await changeStockAndRecord(committed);

  const afterCommit = await repository.findByPid(testPid);
  const saved = await StockOperation.findById(committed._id).lean();

  assert.equal(afterCommit.quantity, 3);
  assert.equal(saved.status, "RESERVED");
  assert.equal(saved.items[0].unit_price, "100.00");
  console.log("PASS: Stock and operation record commit together");

  // Cố tình gây lỗi sau khi đã ghi cả hai collection.
  const rolledBack = makeOperation(1);

  await assert.rejects(
    () => changeStockAndRecord(rolledBack, true),
    { message: "INTENTIONAL_ROLLBACK" }
  );

  // 2. Tồn kho được rollback.
  const afterRollback = await repository.findByPid(testPid);
  assert.equal(afterRollback.quantity, 3);
  console.log("PASS: Failed transaction restores stock");

  // 3. Bản ghi thao tác cũng được rollback.
  assert.equal(
    await StockOperation.findById(rolledBack._id),
    null
  );
  console.log("PASS: Failed transaction removes operation record");

  // 4. MongoDB từ chối mã thao tác trùng.
  await assert.rejects(
    () => StockOperation.create(committed),
    (err) => err.code === 11000
  );
  console.log("PASS: Duplicate operation ID rejected");

  // 5. Trạng thái ngoài danh sách bị từ chối.
  const invalid = makeOperation(1);

  await assert.rejects(
    () => new StockOperation({
      ...invalid,
      status: "UNKNOWN",
    }).validate(),
    (err) =>
      err.name === "ValidationError" &&
      Boolean(err.errors.status)
  );
  console.log("PASS: Invalid operation status rejected");

  console.log("Stock transaction checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await StockOperation.deleteMany({
        _id: { $in: operationIds },
      });

      if (testPid !== undefined) {
        await Product.deleteOne({ pid: testPid });
      }
    } finally {
      await disconnectDatabase();
    }
  });