const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const mongoose = require("mongoose");

mongoose.connection.on("error", (err) => {
  console.error("Shipment MongoDB error:", err.message);
});

async function connectDatabase() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

module.exports = {
  mongoose,
  connectDatabase,
  disconnectDatabase,
};