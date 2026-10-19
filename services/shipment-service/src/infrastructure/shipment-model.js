const { mongoose } = require("./database");

const MAX_INT = 2147483647;

function positiveIntegerField(unique = false) {
  return {
    type: Number,
    required: true,
    min: 1,
    max: MAX_INT,
    unique,
    validate: {
      validator: Number.isInteger,
      message: "{PATH} must be an integer",
    },
  };
}

const shipmentSchema = new mongoose.Schema(
  {
    shipid: positiveIntegerField(true),

    // Một đơn hàng chỉ có một shipment trong phiên bản MVP.
    oid: positiveIntegerField(true),

    uid: positiveIntegerField(),

    sourceEventId: {
      type: String,
      required: true,
      lowercase: true,
      unique: true,
      match:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    },

    eventHash: {
      type: String,
      required: true,
      match: /^[0-9a-f]{64}$/,
    },

    status: {
      type: String,
      required: true,
      enum: [
        "PENDING",
        "SHIPPING",
        "DELIVERED",
        "CANCELLED",
      ],
      default: "PENDING",
    },
  },
  {
    collection: "shipments",
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.model("Shipment", shipmentSchema);