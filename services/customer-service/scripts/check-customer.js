const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const { grpc, AuthService } = require("../src/infrastructure/auth-proto");
const CustomerRepository = require("../src/infrastructure/customer-repository");
const CustomerService = require("../src/application/customer-service");

const authClient = new AuthService(
  "127.0.0.1:50051",
  grpc.credentials.createInsecure()
);

function registerAccount(input) {
  return new Promise((resolve, reject) => {
    authClient.register(
      input,
      { deadline: new Date(Date.now() + 10000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

async function main() {
  const service = new CustomerService(new CustomerRepository());

  // Đăng ký tài khoản thật, lấy UID từ Auth.
  const account = await registerAccount({
    username: `cus_${randomUUID()}`,
    password: "P@ss123",
  });

  const profile = await service.ensureProfile({
    uid: account.uid,
    fullname: "Nguyen Van An",
  });

  assert.equal(profile.uid, account.uid);
  assert.equal(profile.fullname, "Nguyen Van An");
  console.log("PASS: Customer uses the UID issued by Auth");

  assert.equal(profile.mname, "BASIC");
  assert.equal(profile.score, 0);
  console.log("PASS: New customer receives BASIC membership");

  const repeated = await service.ensureProfile({
    uid: account.uid,
    fullname: "Must not overwrite existing name",
  });

  assert.deepEqual(repeated, profile);
  console.log("PASS: Repeated creation preserves existing profile");

  const loaded = await service.getProfile(account.uid);
  assert.deepEqual(loaded, profile);
  console.log("PASS: Existing customer can be retrieved");

  await assert.rejects(
    () => service.getProfile(-1),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Invalid UID rejected");

  // Tìm một UID chắc chắn chưa có trong Customer DB.
  const missing = await pool.query(`
    SELECT candidate.uid
    FROM generate_series(
      2147483647, 2147483547, -1
    ) AS candidate(uid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public."Customer" c
      WHERE c.uid = candidate.uid
    )
    LIMIT 1
  `);

  assert.ok(missing.rows.length);

  await assert.rejects(
    () => service.getProfile(missing.rows[0].uid),
    { code: "NOT_FOUND" }
  );
  console.log("PASS: Missing customer returns NOT_FOUND");

  console.log("Customer checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    authClient.close();
    return pool.end();
  });