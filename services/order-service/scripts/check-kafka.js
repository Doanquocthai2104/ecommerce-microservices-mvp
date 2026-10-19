const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  kafka,
  producer,
} = require("../src/infrastructure/kafka-client");

const topic = "prompt3-order-transport-test";
const probeId = randomUUID();

const admin = kafka.admin();

const consumer = kafka.consumer({
  groupId: `prompt3-kafka-check-${probeId}`,
  allowAutoTopicCreation: false,
});

let receiveTimer = null;

async function main() {
  await admin.connect();

  const existingTopics = await admin.listTopics();

if (!existingTopics.includes(topic)) {
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic,
        numPartitions: 1,
        replicationFactor: 1,
      },
    ],
  });
}

  const metadata = await admin.fetchTopicMetadata({
    topics: [topic],
  });

  const testTopic = metadata.topics.find(
    (item) => item.name === topic
  );

  assert.ok(testTopic);
  assert.equal(testTopic.partitions.length, 1);

  console.log("PASS: Kafka connection and test topic are available");

  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({
    topic,
    fromBeginning: true,
  });

  let resolveReceived;

  const received = new Promise((resolve) => {
    resolveReceived = resolve;
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (message.key?.toString() !== probeId) {
        return;
      }

      resolveReceived({
        key: message.key.toString(),
        value: message.value?.toString(),
      });
    },
  });

  console.log("PASS: Producer and consumer connect successfully");

  const event = {
    eventId: probeId,
    eventType: "TransportProbe",
    occurredAt: new Date().toISOString(),
    data: {
      message: "Order Service Kafka connection test",
    },
  };

  const timeout = new Promise((resolve, reject) => {
    receiveTimer = setTimeout(() => {
      reject(new Error("Timed out waiting for Kafka message"));
    }, 30000);
  });

  const results = await Promise.all([
    producer.send({
      topic,
      acks: -1,
      timeout: 10000,
      messages: [
        {
          key: probeId,
          value: JSON.stringify(event),
        },
      ],
    }),
    Promise.race([received, timeout]),
  ]);

  clearTimeout(receiveTimer);
  receiveTimer = null;

  const acknowledgements = results[0];
  const message = results[1];

  assert.ok(acknowledgements.length > 0);
  assert.equal(acknowledgements[0].topicName, topic);

  console.log("PASS: Kafka acknowledges the published message");

  assert.equal(message.key, probeId);
  assert.deepEqual(JSON.parse(message.value), event);

  console.log("PASS: Consumer receives the correct message key and payload");

  console.log("Kafka checks completed successfully");
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    if (receiveTimer) {
      clearTimeout(receiveTimer);
    }

    // Đóng từng kết nối kể cả khi một thao tác đóng bị lỗi.
    for (const [name, disconnect] of [
      ["consumer", () => consumer.disconnect()],
      ["producer", () => producer.disconnect()],
      ["admin", () => admin.disconnect()],
    ]) {
      try {
        await disconnect();
      } catch (err) {
        console.error(`${name} disconnect failed:`, err.message);
        process.exitCode = 1;
      }
    }
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});