const fs = require("node:fs/promises");
const path = require("node:path");

const pool = require("../src/infrastructure/database");

const expectedMemberships = [
  { mname: "BASIC", score: 0 },
  { mname: "SILVER", score: 100 },
  { mname: "GOLD", score: 500 },
  { mname: "PLATINUM", score: 1000 },
];

async function main() {
  const sql = await fs.readFile(
    path.resolve(
      __dirname,
      "../migrations/002_seed_memberships.sql"
    ),
    "utf8"
  );

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(sql);

    const result = await client.query(
      `
      SELECT mid, mname, score
      FROM public."MemberShip"
      WHERE mname = ANY($1::varchar[])
      ORDER BY score, mid
      `,
      [expectedMemberships.map((item) => item.mname)]
    );

    for (const expected of expectedMemberships) {
      const actual = result.rows.find(
        (item) => item.mname === expected.mname
      );

      if (!actual || actual.score !== expected.score) {
        throw new Error(
          `Membership ${expected.mname} is missing or has a different score; ` +
          `expected ${expected.score}. Existing data was not overwritten.`
        );
      }
    }

    await client.query("COMMIT");
    transactionStarted = false;

    console.table(result.rows);
    console.log("Membership seed completed successfully");
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
});