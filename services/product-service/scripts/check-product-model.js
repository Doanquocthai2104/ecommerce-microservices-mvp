const assert = require("node:assert/strict");

const {
  connectDatabase,
  disconnectDatabase,
} = require("../src/infrastructure/database");

const Product = require("../src/infrastructure/product-model");

async function main() {
  await connectDatabase();

  // Tạo collection và chờ các index của model sẵn sàng.
  await Product.init();

  const indexes = await Product.collection.indexes();

  assert.ok(
    indexes.some(
      (index) =>
        index.key.pid === 1 &&
        Object.keys(index.key).length === 1 &&
        index.unique === true
    )
  );
  console.log("PASS: Product collection has a unique PID index");

  const valid = {
    pid: 1,
    pname: "Laptop",
    price: "1500.50",
    quantity: 10,
  };

  const product = new Product(valid);

  await product.validate();

  assert.equal(product.price.toString(), "1500.50");
  console.log("PASS: Valid product and decimal price accepted");

  async function expectInvalid(changes, field) {
    await assert.rejects(
      () => new Product({ ...valid, ...changes }).validate(),
      (err) =>
        err.name === "ValidationError" &&
        Boolean(err.errors[field])
    );
  }

  await expectInvalid({ price: "-1" }, "price");
  console.log("PASS: Negative price rejected");

  await expectInvalid({ price: "1500.501" }, "price");
  console.log("PASS: Price with more than 2 decimal places rejected");

  await expectInvalid({ quantity: -1 }, "quantity");
  console.log("PASS: Negative quantity rejected");

  await expectInvalid({ quantity: 1.5 }, "quantity");
  console.log("PASS: Fractional quantity rejected");

  await expectInvalid({ pname: "   " }, "pname");
  console.log("PASS: Empty product name rejected");

  await expectInvalid({ pid: 0 }, "pid");
  console.log("PASS: Invalid PID rejected");

  console.log("Product model checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
