const AppError = require("../domain/app-error");

function invalid(message) {
  throw new AppError("INVALID_INPUT", message);
}

function requireActor(actor, adminOnly = false) {
  if (
    !actor ||
    !Number.isInteger(actor.uid) ||
    actor.uid <= 0 ||
    actor.uid > 2147483647 ||
    !["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"].includes(actor.role)
  ) {
    throw new AppError(
      "INVALID_CREDENTIALS",
      "Authentication is required"
    );
  }

  if (adminOnly && actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "Admin permission is required");
  }
}

function validatePid(pid) {
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    pid > 2147483647
  ) {
    invalid("Invalid product ID");
  }
}

function normalizePrice(value) {
  let text;

  if (typeof value === "number" && Number.isFinite(value)) {
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    invalid("Invalid price");
  }

  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(text)) {
    invalid(
      "Price must be between 0 and 99999999.99 " +
      "with at most 2 decimal places"
    );
  }

  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function validateData(input, partial = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("Invalid product data");
  }

  const keys = Object.keys(input);

  if (
    keys.length === 0 ||
    keys.some((key) => !["pname", "price", "quantity"].includes(key))
  ) {
    invalid("Only pname, price and quantity are accepted");
  }

  const result = {};

  if (!partial || Object.hasOwn(input, "pname")) {
    if (
      typeof input.pname !== "string" ||
      !input.pname.trim() ||
      input.pname.trim().length > 100
    ) {
      invalid("Product name is required and must not exceed 100 characters");
    }

    result.pname = input.pname.trim();
  }

  if (!partial || Object.hasOwn(input, "price")) {
    result.price = normalizePrice(input.price);
  }

  if (!partial || Object.hasOwn(input, "quantity")) {
    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < 0 ||
      input.quantity > 2147483647
    ) {
      invalid("Quantity must be a non-negative integer");
    }

    result.quantity = input.quantity;
  }

  return result;
}

async function write(operation) {
  try {
    return await operation();
  } catch (err) {
    if (
      err.name === "ValidationError" ||
      err.name === "CastError"
    ) {
      throw new AppError("INVALID_INPUT", "Invalid product data");
    }

    if (err.code === 11000) {
      throw new AppError("CONFLICT", "Product ID already exists");
    }

    throw err;
  }
}

class ProductService {
  constructor(repository) {
    this.repository = repository;
  }

  async create(input, actor) {
    requireActor(actor, true);

    const data = validateData(input);
    return write(() => this.repository.create(data));
  }

  async list(actor) {
    requireActor(actor);
    return this.repository.findAll();
  }

  async get(pid, actor) {
    requireActor(actor);
    validatePid(pid);

    const product = await this.repository.findByPid(pid);

    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found");
    }

    return product;
  }

  async update(pid, changes, actor) {
    requireActor(actor, true);
    validatePid(pid);

    const data = validateData(changes, true);

    const product = await write(
      () => this.repository.update(pid, data)
    );

    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found");
    }

    return product;
  }

  async delete(pid, actor) {
    requireActor(actor, true);
    validatePid(pid);

    const product = await this.repository.delete(pid);

    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found");
    }

    return product;
  }
}

module.exports = ProductService;