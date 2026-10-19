const express = require("express");
const authenticate = require("./middleware/authenticate");
const requireRoles = require("./middleware/require-roles");
const { callCustomer } = require("./customer-client");

const router = express.Router();

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function readUid(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    invalid("Invalid customer UID");
  }

  const uid = Number(value);

  if (!Number.isSafeInteger(uid) || uid > 2147483647) {
    invalid("Invalid customer UID");
  }

  return uid;
}

router.use(authenticate);
router.use(requireRoles("CUSTOMER", "ADMIN"));

router.get("/:uid", async (req, res, next) => {
  try {
    const uid = readUid(req.params.uid);

    const profile = await callCustomer(
      "getProfile",
      { uid },
      req.headers.authorization
    );

    res.json({
      uid: profile.uid,
      fullname: profile.fullname,
      mid: profile.mid,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/:uid", async (req, res, next) => {
  try {
    const uid = readUid(req.params.uid);
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      invalid("A JSON object is required");
    }

    const keys = Object.keys(body);

    if (
      keys.length === 0 ||
      keys.some((key) => !["fullname", "mid"].includes(key))
    ) {
      invalid("Only fullname and mid can be updated");
    }

    const request = { uid };

    if (Object.hasOwn(body, "fullname")) {
      if (typeof body.fullname !== "string") {
        invalid("Fullname must be a string");
      }

      request.fullname = body.fullname;
    }

    if (Object.hasOwn(body, "mid")) {
      if (
        !Number.isInteger(body.mid) ||
        body.mid <= 0 ||
        body.mid > 2147483647
      ) {
        invalid("Invalid membership ID");
      }

      request.mid = body.mid;
    }

    const profile = await callCustomer(
      "updateProfile",
      request,
      req.headers.authorization
    );

    res.json({
      message: "Customer updated successfully",
      uid: profile.uid,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;