const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  grpc,
  CustomerService: CustomerGrpcService,
} = require("../src/infrastructure/customer-proto");

const { AuthService } = require("../src/infrastructure/auth-proto");

const authClient = new AuthService(
  process.env.AUTH_GRPC_URL || "127.0.0.1:50051",
  grpc.credentials.createInsecure()
);

const customerClient = new CustomerGrpcService(
  "127.0.0.1:50052",
  grpc.credentials.createInsecure()
);

function call(client, method, request, token) {
  const metadata = new grpc.Metadata();

  if (token) {
    metadata.set("authorization", `Bearer ${token}`);
  }

  return new Promise((resolve, reject) => {
    client[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 10000) },
      (err, response) => {
        if (err) return reject(err);
        resolve(response);
      }
    );
  });
}

async function createAccount() {
  const input = {
    username: `cusgrpc_${randomUUID()}`,
    password: "P@ss123",
  };

  const registered = await call(authClient, "register", input);
  const login = await call(authClient, "login", input);

  return {
    uid: registered.uid,
    token: login.accessToken,
  };
}

async function main() {
  const customer = await createAccount();
  const other = await createAccount();

  // 1. Thiếu JWT
  await assert.rejects(
    () => call(customerClient, "getProfile", {
      uid: customer.uid,
    }),
    { code: grpc.status.UNAUTHENTICATED }
  );
  console.log("PASS: Missing token rejected");

  // 2. JWT không hợp lệ
  await assert.rejects(
    () => call(
      customerClient,
      "getProfile",
      { uid: customer.uid },
      "invalid-token"
    ),
    { code: grpc.status.UNAUTHENTICATED }
  );
  console.log("PASS: Invalid token rejected");

  // 3. Tài khoản có thật nhưng chưa có hồ sơ Customer
  await assert.rejects(
    () => call(
      customerClient,
      "getProfile",
      { uid: customer.uid },
      customer.token
    ),
    { code: grpc.status.NOT_FOUND }
  );
  console.log("PASS: Missing profile returns NOT_FOUND");

  // 4. Tạo hồ sơ cho chính người đăng nhập
  const profile = await call(
    customerClient,
    "ensureProfile",
    { fullname: "Nguyen Van An" },
    customer.token
  );

  assert.equal(profile.uid, customer.uid);
  assert.equal(profile.fullname, "Nguyen Van An");
  assert.equal(profile.mname, "BASIC");
  assert.equal(profile.score, 0);
  console.log("PASS: Profile created with authenticated UID and BASIC");

  // 5. Thử lại không ghi đè hồ sơ
  const repeated = await call(
    customerClient,
    "ensureProfile",
    { fullname: "Must not overwrite" },
    customer.token
  );

  assert.deepEqual(repeated, profile);
  console.log("PASS: Repeated creation preserves profile");

  // 6. Đọc hồ sơ của mình
  const loaded = await call(
    customerClient,
    "getProfile",
    { uid: customer.uid },
    customer.token
  );

  assert.deepEqual(loaded, profile);
  console.log("PASS: Customer reads own profile");

  // 7. Cập nhật họ tên, không gửi mid
  const updated = await call(
    customerClient,
    "updateProfile",
    {
      uid: customer.uid,
      fullname: "Nguyen Van Binh",
    },
    customer.token
  );

  assert.equal(updated.fullname, "Nguyen Van Binh");
  assert.equal(updated.mid, profile.mid);
  console.log("PASS: Name updated without changing membership");

  // 8. Đọc hạng thành viên và score
  const membership = await call(
    customerClient,
    "getMembership",
    { uid: customer.uid },
    customer.token
  );

  assert.equal(membership.uid, customer.uid);
  assert.equal(membership.mid, profile.mid);
  assert.equal(membership.mname, "BASIC");
  assert.equal(membership.score, 0);
  console.log("PASS: Membership and score retrieved");

  // 9. Tài khoản khác không được đọc hồ sơ
  await assert.rejects(
    () => call(
      customerClient,
      "getProfile",
      { uid: customer.uid },
      other.token
    ),
    { code: grpc.status.PERMISSION_DENIED }
  );
  console.log("PASS: Reading another customer profile rejected");

  // 10. Tài khoản khác không được sửa hồ sơ
  await assert.rejects(
    () => call(
      customerClient,
      "updateProfile",
      {
        uid: customer.uid,
        fullname: "Unauthorized change",
      },
      other.token
    ),
    { code: grpc.status.PERMISSION_DENIED }
  );
  console.log("PASS: Updating another customer profile rejected");

  // 11. Customer không được tự đổi hạng
  await assert.rejects(
    () => call(
      customerClient,
      "updateProfile",
      {
        uid: customer.uid,
        mid: profile.mid,
      },
      customer.token
    ),
    { code: grpc.status.PERMISSION_DENIED }
  );
  console.log("PASS: Customer membership update rejected");

  // 12. Họ tên rỗng
  await assert.rejects(
    () => call(
      customerClient,
      "updateProfile",
      {
        uid: customer.uid,
        fullname: "",
      },
      customer.token
    ),
    { code: grpc.status.INVALID_ARGUMENT }
  );
  console.log("PASS: Empty fullname rejected");

  console.log("Customer gRPC checks completed successfully");
}

main()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    authClient.close();
    customerClient.close();
  });