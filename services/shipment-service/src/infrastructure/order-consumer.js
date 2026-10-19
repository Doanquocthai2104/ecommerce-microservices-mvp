const { kafka } = require("./kafka-client");

function createOrderConsumer({
  processor,
  topic = "order-created",
  groupId =
    process.env.KAFKA_GROUP_ID || "shipment-service-v1",
}) {
  const consumer = kafka.consumer({
    groupId,
    allowAutoTopicCreation: false,
  });

  async function start() {
    await consumer.connect();

    await consumer.subscribe({
      topic,
      fromBeginning: true,
    });

    await consumer.run({
      autoCommit: false,

      eachMessage: async ({
        topic,
        partition,
        message,
        heartbeat,
      }) => {
        const result = await processor.execute({
          topic,
          partition,
          message,
        });

        if (
          !result ||
          !["PROCESSED", "REJECTED"].includes(result.status)
        ) {
          throw new Error("Unexpected message processing result");
        }

        await heartbeat();

        // Kafka lưu vị trí tiếp theo cần đọc.
        // BigInt tránh làm tròn offset lớn.
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (
              BigInt(message.offset) + 1n
            ).toString(),
          },
        ]);
      },
    });
  }

  async function stop() {
    await consumer.disconnect();
  }

  return {
    consumer,
    start,
    stop,
  };
}

module.exports = createOrderConsumer;