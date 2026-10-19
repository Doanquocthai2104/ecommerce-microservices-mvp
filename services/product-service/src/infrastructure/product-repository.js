const Product = require("./product-model");
const Counter = require("./counter-model");
const AppError = require("../domain/app-error");
const { mongoose } = require("./database");
const StockOperation = require("./stock-operation-model");

function toProduct(document) {
  if (!document) return null;

  return {
    pid: document.pid,
    pname: document.pname,
    price: document.price.toString(),
    quantity: document.quantity,
  };
}

class ProductRepository {
  async initialize() {
    await Promise.all([
      Product.init(),
      Counter.init(),
      StockOperation.init(),
    ]);

    const highest = await Product.findOne()
      .sort({ pid: -1 })
      .select({ pid: 1 })
      .lean();

    const initialValue = highest ? highest.pid : 0;

    try {
      await Counter.updateOne(
        { _id: "product" },
        { $max: { seq: initialValue } },
        { upsert: true }
      );
    } catch (err) {
      if (err.code !== 11000) throw err;

      // Một tiến trình khác có thể vừa tạo bộ đếm.
      await Counter.updateOne(
        { _id: "product" },
        { $max: { seq: initialValue } }
      );
    }
  }

  async nextPid() {
    const counter = await Counter.findOneAndUpdate(
      {
        _id: "product",
        seq: { $lt: 2147483647 },
      },
      { $inc: { seq: 1 } },
      { returnDocument: "after" }
    ).lean();

    if (!counter) {
      throw new Error(
        "Product sequence is missing or has reached its limit"
      );
    }

    return counter.seq;
  }

  async create({ pname, price, quantity }) {
    const pid = await this.nextPid();

    const document = await Product.create({
      pid,
      pname,
      price,
      quantity,
    });

    return toProduct(document);
  }

  async findByPid(pid) {
    const document = await Product.findOne({ pid }).lean();
    return toProduct(document);
  }

  async findAll() {
    const documents = await Product.find()
      .sort({ pid: 1 })
      .lean();

    return documents.map(toProduct);
  }

    async update(pid, changes) {
    const update = {};

    for (const field of ["pname", "price", "quantity"]) {
      if (changes[field] !== undefined) {
        update[field] = changes[field];
      }
    }

    if (Object.keys(update).length === 0) {
      throw new Error("No product fields to update");
    }

    const performUpdate = async (session) => {
      const document = await Product.findOneAndUpdate(
        { pid },
        { $set: update },
        {
          session,
          returnDocument: "after",
          runValidators: true,
        }
      ).lean();

      return toProduct(document);
    };

    if (Object.hasOwn(update, "quantity")) {
      return mongoose.connection.transaction(
        async (session) => {
          await this.assertNoActiveReservation(pid, session);
          return performUpdate(session);
        },
        {
          readPreference: "primary",
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
        }
      );
    }

    return performUpdate();
  }

  async delete(pid) {
    return mongoose.connection.transaction(
      async (session) => {
        await this.assertNoActiveReservation(pid, session);

        const document = await Product.findOneAndDelete(
          { pid },
          { session }
        ).lean();

        return toProduct(document);
      },
      {
        readPreference: "primary",
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      }
    );
  }

  async decreaseStock(pid, qty) {
    this.validateStockInput(pid, qty);

    const document = await Product.findOneAndUpdate(
      {
        pid,
        quantity: { $gte: qty },
      },
      {
        $inc: { quantity: -qty },
      },
      {
        returnDocument: "after",
      }
    ).lean();

    return toProduct(document);
  }

  async restoreStock(pid, qty) {
    this.validateStockInput(pid, qty);

    const document = await Product.findOneAndUpdate(
      {
        pid,
        quantity: { $lte: 2147483647 - qty },
      },
      {
        $inc: { quantity: qty },
      },
      {
        returnDocument: "after",
      }
    ).lean();

    return toProduct(document);
  }

  async assertNoActiveReservation(pid, session) {
    const reserved = await StockOperation.exists({
      status: "RESERVED",
      "items.pid": pid,
    }).session(session);

    if (reserved) {
      throw new AppError(
        "CONFLICT",
        "Product has pending inventory reservations"
      );
    }
  }

}

module.exports = ProductRepository;