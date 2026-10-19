const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");

const pool = require("../src/infrastructure/database");
const UserRepository = require("../src/infrastructure/user-repository");
const TokenService = require("../src/infrastructure/token-service");
const RegisterUser = require("../src/application/register-user");
const LoginUser = require("../src/application/login-user");

async function main() {
  const repository = new UserRepository();

  // database.js đã đọc .env trước khi lấy JWT_SECRET.
  const tokenService = new TokenService(process.env.JWT_SECRET);

  const register = new RegisterUser(repository);
  const login = new LoginUser(repository, tokenService);

  const username = `login_${randomUUID()}`;
  const password = "P@ss123";
  const user = await register.execute({ username, password });

  // 1. Đăng nhập đúng
  const result = await login.execute({ username, password });

  assert.equal(typeof result.accessToken, "string");
  assert.equal(result.tokenType, "Bearer");
  assert.equal(result.expiresIn, 3600);
  console.log("PASS: Valid login");

  // 2. Kiểm tra chữ ký, claims và thời hạn
  const payload = tokenService.verify(result.accessToken);

  assert.equal(payload.sub, String(user.uid));
  assert.equal(payload.role, "CUSTOMER");
  assert.equal(payload.exp - payload.iat, 3600);
  assert.equal(payload.password, undefined);
  console.log("PASS: JWT signature, claims and lifetime");

  // 3. Sai mật khẩu
  await assert.rejects(
    () => login.execute({ username, password: "Wrong123" }),
    { code: "INVALID_CREDENTIALS" }
  );
  console.log("PASS: Wrong password rejected");

  // 4. Username không tồn tại
  await assert.rejects(
    () => login.execute({
      username: `absent_${randomUUID()}`,
      password,
    }),
    { code: "INVALID_CREDENTIALS" }
  );
  console.log("PASS: Unknown username rejected");

  // 5. Thiếu password
  await assert.rejects(
    () => login.execute({ username }),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Missing password rejected");

  // 6. Chữ ký được tạo bằng khóa khác
  const forged = jwt.sign(
    { role: "ADMIN" },
    "a-different-test-key-with-at-least-32-bytes",
    {
      algorithm: "HS256",
      subject: String(user.uid),
      issuer: "prompt3-auth",
      audience: "prompt3-api",
      expiresIn: 3600,
    }
  );

  assert.throws(
    () => tokenService.verify(forged),
    { name: "JsonWebTokenError" }
  );
  console.log("PASS: Invalid signature rejected");

  // 7. Token đã hết hạn
  const expired = jwt.sign(
    { role: "CUSTOMER" },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      subject: String(user.uid),
      issuer: "prompt3-auth",
      audience: "prompt3-api",
      expiresIn: -1,
    }
  );

  assert.throws(
    () => tokenService.verify(expired),
    { name: "TokenExpiredError" }
  );
  console.log("PASS: Expired token rejected");

  console.log("Login checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());