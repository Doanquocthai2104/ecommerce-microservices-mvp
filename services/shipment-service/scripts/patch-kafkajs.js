const fs = require("node:fs");
const path = require("node:path");

function main() {
  const packagePath = require.resolve("kafkajs/package.json");

  const packageInfo = JSON.parse(
    fs.readFileSync(packagePath, "utf8")
  );

  if (packageInfo.version !== "2.2.4") {
    throw new Error(
      "This compatibility patch requires KafkaJS 2.2.4"
    );
  }

  const filePath = path.join(
    path.dirname(packagePath),
    "src",
    "network",
    "requestQueue",
    "index.js"
  );

  const marker = "// prompt3: skip idle request queue timer";
  const source = fs.readFileSync(filePath, "utf8");

  if (source.includes(marker)) {
    console.log("KafkaJS compatibility patch already applied");
    return;
  }

  const pattern =
    /if \(this\.pending\.length > 0\) \{\r?\n[ \t]*scheduleAt = scheduleAt > 0 \? scheduleAt : CHECK_PENDING_REQUESTS_INTERVAL\r?\n[ \t]*\}/g;

  const matches = [...source.matchAll(pattern)];

  if (matches.length !== 1) {
    throw new Error(
      "Unexpected KafkaJS source; patch was not applied"
    );
  }

  const patched = source.replace(pattern, (matched) => {
    return (
      matched +
      ` else if (scheduleAt <= 0) {
        ${marker}
        return
      }`
    );
  });

  fs.writeFileSync(filePath, patched, "utf8");

  console.log("KafkaJS compatibility patch applied");
}

try {
  main();
} catch (err) {
  console.error("KafkaJS patch failed:", err.message);
  process.exitCode = 1;
}