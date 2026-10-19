const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const { Kafka, logLevel } = require("kafkajs");

const brokers = (
  process.env.KAFKA_BROKERS || "127.0.0.1:9092"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (brokers.length === 0) {
  throw new Error("At least one Kafka broker is required");
}

const kafka = new Kafka({
  clientId:
    process.env.KAFKA_CLIENT_ID || "shipment-service",
  brokers,
  connectionTimeout: 5000,
  requestTimeout: 10000,
  retry: {
    initialRetryTime: 300,
    retries: 5,
  },
  logLevel: logLevel.WARN,
});

module.exports = { kafka };