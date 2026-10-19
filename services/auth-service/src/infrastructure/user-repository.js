const pool = require("./database");
const AppError = require("../domain/app-error");

class UserRepository {
  async createCustomer({ username, passwordHash, email, phone }) {
    try {
      const result = await pool.query(
        `
        INSERT INTO public."User"
          (username, password, roleid, email, phone)
        VALUES (
          $1,
          $2,
          (SELECT roleid FROM public."Role"
           WHERE rolename = 'CUSTOMER'),
          $3,
          $4
        )
        RETURNING uid
        `,
        [username, passwordHash, email, phone]
      );

      return result.rows[0];
    } catch (err) {
      if (
        err.code === "23505" &&
        ["User_username_key", "User_email_key"].includes(err.constraint)
      ) {
        throw new AppError(
          "ACCOUNT_EXISTS",
          "Username or email already exists"
        );
      }

      throw err;
    }

    
  }
    async findByUsername(username) {
    const result = await pool.query(
      `
      SELECT
        u.uid,
        u.username,
        u.password,
        r.rolename AS role
      FROM public."User" u
      JOIN public."Role" r ON r.roleid = u.roleid
      WHERE u.username = $1
      `,
      [username]
    );

    return result.rows[0] || null;
  }
}

module.exports = UserRepository;