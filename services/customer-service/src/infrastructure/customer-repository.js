const pool = require("./database");

class CustomerRepository {
  async findByUid(uid) {
    const result = await pool.query(
      `
      SELECT
        c.uid,
        c.fullname,
        c.mid,
        m.mname,
        m.score
      FROM public."Customer" c
      JOIN public."MemberShip" m ON m.mid = c.mid
      WHERE c.uid = $1
      `,
      [uid]
    );

    return result.rows[0] || null;
  }

  async ensureProfile({ uid, fullname }) {
    await pool.query(
      `
      INSERT INTO public."Customer" (uid, fullname, mid)
      VALUES (
        $1,
        $2,
        (
          SELECT mid
          FROM public."MemberShip"
          WHERE mname = 'BASIC'
        )
      )
      ON CONFLICT (uid) DO NOTHING
      `,
      [uid, fullname]
    );

    return this.findByUid(uid);
  }

    async findMembershipById(mid) {
    const result = await pool.query(
      `
      SELECT mid, mname, score
      FROM public."MemberShip"
      WHERE mid = $1
      `,
      [mid]
    );

    return result.rows[0] || null;
  }

  async updateProfile(uid, { fullname, mid }) {
    try {
      const result = await pool.query(
        `
        WITH updated AS (
          UPDATE public."Customer"
          SET
            fullname = COALESCE($2::varchar, fullname),
            mid = COALESCE($3::int, mid)
          WHERE uid = $1
          RETURNING uid, fullname, mid
        )
        SELECT
          c.uid,
          c.fullname,
          c.mid,
          m.mname,
          m.score
        FROM updated c
        JOIN public."MemberShip" m ON m.mid = c.mid
        `,
        [uid, fullname ?? null, mid ?? null]
      );

      return result.rows[0] || null;
    } catch (err) {
      if (err.code === "23503") {
        const AppError = require("../domain/app-error");

        throw new AppError(
          "INVALID_INPUT",
          "Membership does not exist"
        );
      }

      throw err;
    }
  }
}

module.exports = CustomerRepository;