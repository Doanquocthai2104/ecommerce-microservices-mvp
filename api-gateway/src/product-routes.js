const express = require("express");
const authenticate = require("./middleware/authenticate");
const requireRoles = require("./middleware/require-roles");
const { callProduct } = require("./product-client");

const router = express.Router();

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function readPid(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    invalid("Invalid product ID");
  }

  const pid = Number(value);

  if (!Number.isSafeInteger(pid) || pid > 2147483647) {
    invalid("Invalid product ID");
  }

  return pid;
}

function readProductInput(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalid("A JSON object is required");
  }

  const keys = Object.keys(body);

  if (
    keys.length === 0 ||
    keys.some((key) => !["pname", "price", "quantity"].includes(key))
  ) {
    invalid("Only pname, price and quantity are accepted");
  }

  const input = {};

  if (!partial || Object.hasOwn(body, "pname")) {
    if (
      typeof body.pname !== "string" ||
      !body.pname.trim() ||
      body.pname.trim().length > 100
    ) {
      invalid("Invalid product name");
    }

    input.pname = body.pname.trim();
  }

  if (!partial || Object.hasOwn(body, "price")) {
    if (
      typeof body.price !== "number" ||
      !Number.isFinite(body.price) ||
      !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(String(body.price))
    ) {
      invalid(
        "Price must be a number between 0 and 99999999.99 " +
        "with at most 2 decimal places"
      );
    }

    // REST nhận số; gRPC nội bộ nhận chuỗi thập phân.
    input.price = String(body.price);
  }

  if (!partial || Object.hasOwn(body, "quantity")) {
    if (
      !Number.isInteger(body.quantity) ||
      body.quantity < 0 ||
      body.quantity > 2147483647
    ) {
      invalid("Quantity must be a non-negative integer");
    }

    input.quantity = body.quantity;
  }

  return input;
}

function toRestProduct(product) {
  return {
    pid: product.pid,
    pname: product.pname,
    price: Number(product.price),
    quantity: product.quantity,
  };
}

router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const result = await callProduct(
      "listProducts",
      {},
      req.headers.authorization
    );

    res.json({
      items: (result.items || []).map(toRestProduct),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:pid", async (req, res, next) => {
  try {
    const product = await callProduct(
      "getProduct",
      { pid: readPid(req.params.pid) },
      req.headers.authorization
    );

    res.json(toRestProduct(product));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const input = readProductInput(req.body);

    const product = await callProduct(
      "createProduct",
      input,
      req.headers.authorization
    );

    res.status(201).json(toRestProduct(product));
  } catch (err) {
    next(err);
  }
});

router.put("/:pid", requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const pid = readPid(req.params.pid);
    const input = readProductInput(req.body, true);

    const product = await callProduct(
      "updateProduct",
      { pid, ...input },
      req.headers.authorization
    );

    res.json({
      message: "Product updated successfully",
      pid: product.pid,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:pid", requireRoles("ADMIN"), async (req, res, next) => {
  try {
    const product = await callProduct(
      "deleteProduct",
      { pid: readPid(req.params.pid) },
      req.headers.authorization
    );

    res.json({
      message: "Product deleted successfully",
      pid: product.pid,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;