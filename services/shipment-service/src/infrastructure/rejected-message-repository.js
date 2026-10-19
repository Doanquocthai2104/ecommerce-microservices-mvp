const { createHash } = require("node:crypto");
const { mongoose } = require("./database");

const rejectedMessageSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    topic: {
      type: String,
      required: true,
    },
    partition: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isInteger,
    },
    offset: {
      type: String,
      required: true,
      match: /^\d+$/,
    },
    messageKey: {
      type: String,
      default: null,
    },
    rawValue: {
      type: Buffer,
      default: null,
    },
    errorCode: {
      type: String,
      required: true,
    },
    errorMessage: {
      type: String,
      required: true,
      maxlength: 2000,
    },
  },
  {
    collection: "rejected_messages",
    timestamps: true,
    versionKey: false,
  }
);

const RejectedMessage = mongoose.model(
  "RejectedMessage",
  rejectedMessageSchema
);

class RejectedMessageRepository {
  async initialize() {
    await RejectedMessage.init();
  }

  async save({ topic, partition, message, error }) {
    if (
      typeof topic !== "string" ||
      !topic ||
      !Number.isInteger(partition) ||
      partition < 0 ||
      typeof message.offset !== "string" ||
      !/^\d+$/.test(message.offset)
    ) {
      throw new Error("Invalid Kafka message location");
    }

    // Offset giữ dạng string, không chuyển sang Number.
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          topic,
          partition,
          message.offset,
        ])
      )
      .digest("hex");

    const input = {
      topic,
      partition,
      offset: message.offset,
      messageKey: message.key?.toString() ?? null,
      rawValue: message.value ?? null,
      errorCode: String(error.code || "INVALID_INPUT"),
      errorMessage: String(
        error.message || "Invalid message"
      ).slice(0, 2000),
    };

    try {
      await RejectedMessage.updateOne(
        { _id: id },
        { $setOnInsert: input },
        {
          upsert: true,
          runValidators: true,
        }
      );
    } catch (err) {
      // Hai lần xử lý đồng thời có thể cùng upsert một vị trí.
      if (err.code !== 11000) throw err;

      const existing = await RejectedMessage.exists({
        _id: id,
      });

      if (!existing) throw err;
    }
  }
}

module.exports = {
  RejectedMessage,
  RejectedMessageRepository,
};