const AppError = require("../domain/app-error");

class ProcessOrderMessage {
  constructor({ handler, rejectedMessages }) {
    this.handler = handler;
    this.rejectedMessages = rejectedMessages;
  }

  async execute({ topic, partition, message }) {
    try {
      if (!Buffer.isBuffer(message.value)) {
        throw new AppError(
          "INVALID_INPUT",
          "OrderCreated message must contain a value"
        );
      }

      let event;

      try {
        event = JSON.parse(message.value.toString("utf8"));
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;

        throw new AppError(
          "INVALID_INPUT",
          "Message contains invalid JSON"
        );
      }

      const shipment = await this.handler.execute(event);

      return {
        status: "PROCESSED",
        shipid: shipment.shipid,
      };
    } catch (err) {
      if (!["INVALID_INPUT", "CONFLICT"].includes(err.code)) {
        throw err;
      }

      // Nếu lưu lỗi thất bại, exception tiếp tục truyền lên.
      await this.rejectedMessages.save({
        topic,
        partition,
        message,
        error: err,
      });

      console.error(
        "Shipment message rejected:",
        topic,
        partition,
        message.offset,
        err.code
      );

      return {
        status: "REJECTED",
      };
    }
  }
}

module.exports = ProcessOrderMessage;