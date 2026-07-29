import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GitHubApiError,
  GitHubClient,
} from "../src/github/client.js";

test("anonymous requests omit the authorization header", async () => {
  let authorization: string | null = "not-called";
  const client = new GitHubClient({
    fetchImplementation: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    },
  });

  await client.get("/rate_limit");

  assert.equal(client.authenticated, false);
  assert.equal(authorization, null);
});

test("token requests send a bearer header without exposing it", async () => {
  const token = "github_pat_example_secret";
  let authorization: string | null = null;
  const client = new GitHubClient({
    token,
    fetchImplementation: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    },
  });

  await client.get("/rate_limit");

  assert.equal(client.authenticated, true);
  assert.equal(authorization, `Bearer ${token}`);
});

test("API error messages redact token and authorization values", async () => {
  const token = "github_pat_example_secret";
  const client = new GitHubClient({
    token,
    fetchImplementation: async () =>
      Response.json(
        {
          message: `Rejected ${token}; Authorization: Bearer ${token}`,
        },
        { status: 401 },
      ),
  });

  await assert.rejects(
    () => client.get("/rate_limit"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
