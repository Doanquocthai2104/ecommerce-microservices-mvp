const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");

const pool = require("../src/infrastructure/database");
const UserRepository = require("../src/infrastructure/user-repository");
const TokenService = require("../src/infrastructure/token-service");
const RegisterUser = require("../src/application/register-user");
const LoginUser = require("../src/application/login-user");

async function main() {
  const repository = new UserRepository();
  const tokenService = new TokenService(process.env.JWT_SECRET);

  const register = new RegisterUser(repository);
  const login = new LoginUser(repository, tokenService);

  const username = `admin_${randomUUID()}`;
  const password = randomBytes(16).toString("hex");

  // Tạo tài khoản với mật khẩu băm bằng nghiệp vụ hiện có.
  const account = await register.execute({
    username,
    password,
  });

  // Script quản trị cấp quyền ADMIN cho tài khoản vừa tạo.
  const updated = await pool.query(
    `
    UPDATE public."User"
    SET roleid = (
      SELECT roleid
      FROM public."Role"
      WHERE rolename = 'ADMIN'
    )
    WHERE uid = $1
    RETURNING uid
    `,
    [account.uid]
  );

  assert.equal(updated.rowCount, 1);

  // Đăng nhập sau khi cấp quyền để nhận JWT mới.
  const result = await login.execute({
    username,
    password,
  });

  const payload = tokenService.verify(result.accessToken);

  assert.equal(payload.sub, String(account.uid));
  assert.equal(payload.role, "ADMIN");

  console.log("PASS: Admin account created");
  console.log("PASS: Login produces JWT with ADMIN role");

  console.log("\nSave these credentials for the next test:");
  console.log(`TEST_ADMIN_USERNAME=${username}`);
  console.log(`TEST_ADMIN_PASSWORD=${password}`);
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());