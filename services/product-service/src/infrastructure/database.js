const path = require("node:path");
const mongoose = require("mongoose");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

mongoose.connection.on("error", (err) => {
  console.error("Product MongoDB connection error:", err.message);
});

async function connectDatabase() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

module.exports = {
  mongoose,
  connectDatabase,
  disconnectDatabase,
};