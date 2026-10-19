const { mongoose } = require("./database");

const counterSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },

    seq: {
      type: Number,
      required: true,
      min: 0,
      max: 2147483647,
      validate: {
        validator: Number.isInteger,
        message: "Counter must be an integer",
      },
    },
  },
  {
    collection: "counters",
    versionKey: false,
  }
);

module.exports = mongoose.model("Counter", counterSchema);