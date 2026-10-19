const AppError = require("../domain/app-error");

function validateUid(uid) {
  if (
    !Number.isInteger(uid) ||
    uid <= 0 ||
    uid > 2147483647
  ) {
    throw new AppError(
      "INVALID_INPUT",
      "UID must be a positive PostgreSQL INT"
    );
  }
}

class CustomerService {
  constructor(repository) {
    this.repository = repository;
  }

  async ensureProfile(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AppError("INVALID_INPUT", "Invalid customer data");
    }

    const { uid, fullname } = input;

    validateUid(uid);

    if (
      typeof fullname !== "string" ||
      !fullname.trim() ||
      [...fullname.trim()].length > 100
    ) {
      throw new AppError(
        "INVALID_INPUT",
        "Fullname is required and must not exceed 100 characters"
      );
    }

    return this.repository.ensureProfile({
      uid,
      fullname: fullname.trim(),
    });
  }

  async getProfile(uid) {
    validateUid(uid);

    const customer = await this.repository.findByUid(uid);

    if (!customer) {
      throw new AppError("NOT_FOUND", "Customer not found");
    }

    return customer;
  }
  authorizeProfileAccess(uid, actor) {
    validateUid(uid);

    if (
      !actor ||
      !Number.isInteger(actor.uid) ||
      actor.uid <= 0 ||
      !["CUSTOMER", "ADMIN", "SHIPMENT_STAFF"].includes(actor.role)
    ) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Authentication is required"
      );
    }

    const allowed =
      actor.role === "ADMIN" ||
      (actor.role === "CUSTOMER" && actor.uid === uid);

    if (!allowed) {
      throw new AppError(
        "FORBIDDEN",
        "You cannot access this customer profile"
      );
    }
  }

  async getProfileForActor(uid, actor) {
    this.authorizeProfileAccess(uid, actor);
    return this.getProfile(uid);
  }

  async updateProfile(uid, changes, actor) {
    this.authorizeProfileAccess(uid, actor);

    if (
      !changes ||
      typeof changes !== "object" ||
      Array.isArray(changes)
    ) {
      throw new AppError("INVALID_INPUT", "Invalid update data");
    }

    const keys = Object.keys(changes);

    if (
      keys.length === 0 ||
      keys.some((key) => !["fullname", "mid"].includes(key))
    ) {
      throw new AppError(
        "INVALID_INPUT",
        "Only fullname and mid can be updated"
      );
    }

    const update = {};

    if (Object.hasOwn(changes, "fullname")) {
      if (
        typeof changes.fullname !== "string" ||
        !changes.fullname.trim() ||
        [...changes.fullname.trim()].length > 100
      ) {
        throw new AppError("INVALID_INPUT", "Invalid fullname");
      }

      update.fullname = changes.fullname.trim();
    }

    if (Object.hasOwn(changes, "mid")) {
      if (actor.role !== "ADMIN") {
        throw new AppError(
          "FORBIDDEN",
          "Only Admin can change membership"
        );
      }

      if (
        !Number.isInteger(changes.mid) ||
        changes.mid <= 0 ||
        changes.mid > 2147483647
      ) {
        throw new AppError("INVALID_INPUT", "Invalid membership ID");
      }

      const membership = await this.repository.findMembershipById(
        changes.mid
      );

      if (!membership) {
        throw new AppError(
          "INVALID_INPUT",
          "Membership does not exist"
        );
      }

      update.mid = changes.mid;
    }

    const customer = await this.repository.updateProfile(uid, update);

    if (!customer) {
      throw new AppError("NOT_FOUND", "Customer not found");
    }

    return customer;
  }

}

module.exports = CustomerService;