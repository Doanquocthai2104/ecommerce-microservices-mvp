const bcrypt = require("bcrypt");
const AppError = require("../domain/app-error");

function invalid(message) {
  throw new AppError("INVALID_INPUT", message);
}

class RegisterUser {
  constructor(userRepository) {
    this.userRepository = userRepository;
  }

  async execute(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      invalid("Invalid registration data");
    }

    const { username, password, email, phone } = input;

    if (
      typeof username !== "string" ||
      !username.trim() ||
      [...username.trim()].length > 50
    ) {
      invalid("Username is required and must not exceed 50 characters");
    }

    if (
      typeof password !== "string" ||
      !password.trim() ||
      password.includes("\0") ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      invalid("Password is required and must not exceed 72 bytes");
    }

    let normalizedEmail = null;

    if (email !== undefined && email !== null) {
      if (
        typeof email !== "string" ||
        email.trim().length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ) {
        invalid("Invalid email");
      }

      normalizedEmail = email.trim().toLowerCase();
    }

    let normalizedPhone = null;

    if (phone !== undefined && phone !== null) {
      if (
        typeof phone !== "string" ||
        !phone.trim() ||
        [...phone.trim()].length > 20
      ) {
        invalid("Invalid phone");
      }

      normalizedPhone = phone.trim();
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await this.userRepository.createCustomer({
      username: username.trim(),
      passwordHash,
      email: normalizedEmail,
      phone: normalizedPhone,
    });

    return {
      message: "User registered successfully",
      uid: user.uid,
    };
  }
}

module.exports = RegisterUser;