const { mongoose } = require("./database");

function positiveInteger() {
  return {
    type: Number,
    required: true,
    min: 1,
    max: 2147483647,
    validate: {
      validator: Number.isInteger,
      message: "Value must be an integer",
    },
  };
}

const requestItemSchema = new mongoose.Schema(
  {
    pid: positiveInteger(),
    qty: positiveInteger(),
  },
  { _id: false }
);

const snapshotItemSchema = new mongoose.Schema(
  {
    pid: positiveInteger(),
    qty: positiveInteger(),

    unit_price: {
      type: String,
      required: true,
      match: /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/,
    },
  },
  { _id: false }
);

const stockOperationSchema = new mongoose.Schema(
  {
    // Mã thao tác UUID, đồng thời là khóa duy nhất.
    _id: {
      type: String,
      required: true,
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    },

    uid: positiveInteger(),

    // Hash của UID và danh sách PID/qty đã chuẩn hóa.
    requestHash: {
      type: String,
      required: true,
      match: /^[0-9a-f]{64}$/,
    },

    requestItems: {
      type: [requestItemSchema],
      required: true,
      validate: {
        validator: (items) => items.length > 0,
        message: "Request items must not be empty",
      },
    },

    // Giá chốt khi thực hiện thao tác tồn kho.
    items: {
      type: [snapshotItemSchema],
      default: [],
      validate: {
        validator(items) {
          return this.status === "RELEASED" || items.length > 0;
        },
        message: "Reserved or committed operations require snapshots",
      },
    },

    status: {
      type: String,
      required: true,
      enum: ["RESERVED", "RELEASED", "COMMITTED"],
    },
  },
  {
    collection: "stock_operations",
    timestamps: true,
    versionKey: false,
  }
);

stockOperationSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model(
  "StockOperation",
  stockOperationSchema
);