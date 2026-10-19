class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

module.exports = AppError;