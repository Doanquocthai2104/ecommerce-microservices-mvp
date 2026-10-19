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

function registerAccount() {
  return new Promise((resolve, reject) => {
    authClient.register(
      {
        username: `update_${randomUUID()}`,
        password: "P@ss123",
      },
      { deadline: new Date(Date.now() + 10000) },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

async function main() {
  const service = new CustomerService(new CustomerRepository());

  const account = await registerAccount();
  const original = await service.ensureProfile({
    uid: account.uid,
    fullname: "Nguyen Van An",
  });

  const customerActor = {
    uid: account.uid,
    role: "CUSTOMER",
  };

  const updated = await service.updateProfile(
    account.uid,
    { fullname: "Nguyen Van Binh" },
    customerActor
  );

  assert.equal(updated.fullname, "Nguyen Van Binh");
  assert.equal(updated.mid, original.mid);
  console.log("PASS: Customer updates own name without changing membership");

  const viewed = await service.getProfileForActor(
    account.uid,
    customerActor
  );

  assert.equal(viewed.fullname, "Nguyen Van Binh");
  console.log("PASS: Customer reads own profile");

  const anotherAccount = await registerAccount();
  const otherActor = {
    uid: anotherAccount.uid,
    role: "CUSTOMER",
  };

  await assert.rejects(
    () => service.updateProfile(
      account.uid,
      { fullname: "Unauthorized change" },
      otherActor
    ),
    { code: "FORBIDDEN" }
  );
  console.log("PASS: Customer cannot update another profile");

  await assert.rejects(
    () => service.getProfileForActor(account.uid, otherActor),
    { code: "FORBIDDEN" }
  );
  console.log("PASS: Customer cannot read another profile");

  await assert.rejects(
    () => service.updateProfile(
      account.uid,
      { mid: original.mid },
      customerActor
    ),
    { code: "FORBIDDEN" }
  );
  console.log("PASS: Customer cannot change membership");

  // Danh tính Admin giả lập để kiểm tra quy tắc nghiệp vụ.
  // Không cấp quyền Admin cho tài khoản trong Auth DB.
  const adminActor = {
    uid: anotherAccount.uid,
    role: "ADMIN",
  };

  const adminUpdated = await service.updateProfile(
    account.uid,
    {
      fullname: "Updated by Admin",
      mid: original.mid,
    },
    adminActor
  );

  assert.equal(adminUpdated.fullname, "Updated by Admin");
  assert.equal(adminUpdated.mid, original.mid);
  console.log("PASS: Admin can submit profile and membership updates");

  await assert.rejects(
    () => service.updateProfile(
      account.uid,
      { fullname: "   " },
      customerActor
    ),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Empty fullname rejected");

  await assert.rejects(
    () => service.updateProfile(
      account.uid,
      { mid: -1 },
      adminActor
    ),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Invalid membership ID rejected");

  await assert.rejects(
    () => service.updateProfile(
      account.uid,
      { score: 9999 },
      customerActor
    ),
    { code: "INVALID_INPUT" }
  );
  console.log("PASS: Direct score update rejected");

  console.log("Customer update checks completed successfully");
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