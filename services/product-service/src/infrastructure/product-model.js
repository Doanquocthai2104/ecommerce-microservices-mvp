const { mongoose } = require("./database");

const productSchema = new mongoose.Schema(
  {
    pid: {
      type: Number,
      required: true,
      min: 1,
      max: 2147483647,
      unique: true,
      validate: {
        validator: Number.isInteger,
        message: "PID must be an integer",
      },
    },

    pname: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    price: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator(value) {
          return (
            value != null &&
            /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(
              value.toString()
            )
          );
        },
        message:
          "Price must be between 0 and 99999999.99 " +
          "with at most 2 decimal places",
      },
    },

    quantity: {
      type: Number,
      required: true,
      min: 0,
      max: 2147483647,
      validate: {
        validator: Number.isInteger,
        message: "Quantity must be an integer",
      },
    },
  },
  {
    collection: "products",
    versionKey: false,
  }
);

const Product = mongoose.model("Product", productSchema);

module.exports = Product;