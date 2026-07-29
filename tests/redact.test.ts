import assert from "node:assert/strict";
import { test } from "node:test";

import { redactSecrets } from "../src/security/redact.js";

test("redaction removes explicit secrets and bearer credentials", () => {
  const token = "github_pat_example_secret";
  const message =
    `token=${token} Authorization: Bearer ${token} ` +
    "Bearer another-credential";

  const redacted = redactSecrets(message, [token]);

  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes("another-credential"), false);
  assert.match(redacted, /\[REDACTED\]/);
});
