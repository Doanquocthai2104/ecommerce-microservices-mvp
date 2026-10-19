const bcrypt = require("bcrypt");
const AppError = require("../domain/app-error");

class LoginUser {
  constructor(userRepository, tokenService) {
    this.userRepository = userRepository;
    this.tokenService = tokenService;
  }

  async execute(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AppError("INVALID_INPUT", "Invalid login data");
    }

    const { username, password } = input;

    if (
      typeof username !== "string" ||
      !username.trim() ||
      [...username.trim()].length > 50 ||
      typeof password !== "string" ||
      !password.trim() ||
      password.includes("\0") ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      throw new AppError(
        "INVALID_INPUT",
        "Valid username and password are required"
      );
    }

    const user = await this.userRepository.findByUsername(
      username.trim()
    );

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Invalid username or password"
      );
    }

    return {
      accessToken: this.tokenService.create(user),
      tokenType: "Bearer",
      expiresIn: this.tokenService.expiresIn,
    };
  }
}

module.exports = LoginUser;