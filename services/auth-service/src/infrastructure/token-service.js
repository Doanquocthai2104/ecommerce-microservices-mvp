const jwt = require("jsonwebtoken");

class TokenService {
  constructor(secret) {
    if (
      typeof secret !== "string" ||
      Buffer.byteLength(secret, "utf8") < 32
    ) {
      throw new Error("JWT_SECRET must contain at least 32 bytes");
    }

    this.secret = secret;
    this.expiresIn = 3600;
  }

  create(user) {
    return jwt.sign(
      { role: user.role },
      this.secret,
      {
        algorithm: "HS256",
        subject: String(user.uid),
        issuer: "prompt3-auth",
        audience: "prompt3-api",
        expiresIn: this.expiresIn,
      }
    );
  }

  verify(token) {
    return jwt.verify(token, this.secret, {
      algorithms: ["HS256"],
      issuer: "prompt3-auth",
      audience: "prompt3-api",
    });
  }
}

module.exports = TokenService;