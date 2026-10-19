const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");

const pool = require("../src/infrastructure/database");
const UserRepository = require("../src/infrastructure/user-repository");
const RegisterUser = require("../src/application/register-user");

async function main() {
  const register = new RegisterUser(new UserRepository());

  const suffix = require("node:crypto").randomUUID();
  const input = {
    username: `test_${suffix}`,
    password: "P@ss123",
    email: `test_${suffix}@example.com`,
    phone: "0900000000",
  };

  // 1. Đăng ký hợp lệ
  const result = await register.execute(input);
  assert.ok(Number.isInteger(result.uid));
  assert.equal(result.message, "User registered successfully");
  assert.equal(result.password, undefined);
  console.log("PASS: Valid registration");

  // 2. Kiểm tra mật khẩu băm và vai trò mặc định
  const saved = await pool.query(
    `
    SELECT u.password, r.rolename
    FROM public."User" u
    JOIN public."Role" r ON r.roleid = u.roleid
    WHERE u.uid = $1
    `,
    [result.uid]
  );

  assert.equal(saved.rows[0].rolename, "CUSTOMER");
  assert.notEqual(saved.rows[0].password, input.password);
  assert.ok(await bcrypt.compare(input.password, saved.rows[0].password));
  console.log("PASS: Password hashed and role is CUSTOMER");

  // 3. Trùng username
  await assert.rejects(
    () => register.execute({
      ...input,
      email: `other_${suffix}@example.com`,
    }),
    { code: "ACCOUNT_EXISTS" }
  );
  console.log("PASS: Duplicate username rejected");

  // 4. Trùng email
  await assert.rejects(
    () => register.execute({
      ...input,
      username: `other_${suffix}`,
    }),
    { code: "ACCOUNT_EXISTS" }
  );
  console.log("PASS: Duplicate email rejected");

  // 5. Thiếu password
  await assert.rejects(
    () => register.execute({ username: `missing_${suffix}` }),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Missing password rejected");

  console.log("Registration checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());