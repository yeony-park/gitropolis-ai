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

test("429 Retry-After is retried and succeeds", async () => {
  let requestCount = 0;
  const waits: number[] = [];
  const client = new GitHubClient({
    maxRateLimitRetries: 1,
    maxRateLimitWaitMs: 5_000,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetchImplementation: async () => {
      requestCount += 1;
      return requestCount === 1
        ? Response.json(
            { message: "secondary rate limit" },
            { status: 429, headers: { "Retry-After": "2" } },
          )
        : Response.json({ ok: true });
    },
  });

  const response = await client.get<{ ok: boolean }>("/rate_limit");

  assert.equal(response.data.ok, true);
  assert.equal(requestCount, 2);
  assert.deepEqual(waits, [2_000]);
});

test("403 X-RateLimit-Reset is retried and succeeds", async () => {
  const now = 1_700_000_000_000;
  let requestCount = 0;
  const waits: number[] = [];
  const client = new GitHubClient({
    maxRateLimitRetries: 1,
    maxRateLimitWaitMs: 5_000,
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetchImplementation: async () => {
      requestCount += 1;
      return requestCount === 1
        ? Response.json(
            { message: "primary rate limit" },
            {
              status: 403,
              headers: {
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(now / 1_000 + 3),
              },
            },
          )
        : Response.json({ ok: true });
    },
  });

  await client.get("/rate_limit");

  assert.equal(requestCount, 2);
  assert.deepEqual(waits, [3_000]);
});

test("429 stops after the configured retry count", async () => {
  let requestCount = 0;
  const waits: number[] = [];
  const client = new GitHubClient({
    maxRateLimitRetries: 2,
    maxRateLimitWaitMs: 5_000,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetchImplementation: async () => {
      requestCount += 1;
      return Response.json(
        { message: "secondary rate limit" },
        { status: 429, headers: { "Retry-After": "1" } },
      );
    },
  });

  await assert.rejects(
    () => client.get("/rate_limit"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 429);
      assert.equal(error.rateLimited, true);
      assert.equal(error.retryAfterMs, 1_000);
      return true;
    },
  );
  assert.equal(requestCount, 3);
  assert.deepEqual(waits, [1_000, 1_000]);
});

test("403 with a long reset delay stops without waiting", async () => {
  const now = 1_700_000_000_000;
  let requestCount = 0;
  const waits: number[] = [];
  const client = new GitHubClient({
    maxRateLimitRetries: 2,
    maxRateLimitWaitMs: 60_000,
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetchImplementation: async () => {
      requestCount += 1;
      return Response.json(
        { message: "primary rate limit" },
        {
          status: 403,
          headers: {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(now / 1_000 + 3_600),
          },
        },
      );
    },
  });

  await assert.rejects(
    () => client.get("/rate_limit"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 403);
      assert.equal(error.rateLimited, true);
      assert.equal(error.retryAfterMs, 3_600_000);
      return true;
    },
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(waits, []);
});

test("403 without rate-limit headers is not retried", async () => {
  let requestCount = 0;
  const waits: number[] = [];
  const client = new GitHubClient({
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetchImplementation: async () => {
      requestCount += 1;
      return Response.json({ message: "Forbidden" }, { status: 403 });
    },
  });

  await assert.rejects(
    () => client.get("/rate_limit"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 403);
      assert.equal(error.rateLimited, false);
      return true;
    },
  );
  assert.equal(requestCount, 1);
  assert.deepEqual(waits, []);
});

test("repository access blocked is not mistaken for a rate limit", async () => {
  const now = 1_700_000_000_000;
  const client = new GitHubClient({
    now: () => now,
    fetchImplementation: async () =>
      Response.json(
        { message: "Repository access blocked" },
        {
          status: 403,
          headers: {
            "X-RateLimit-Remaining": "3456",
            "X-RateLimit-Reset": String(now / 1_000 + 3_600),
          },
        },
      ),
  });

  await assert.rejects(
    () => client.get("/repos/blocked/repository"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 403);
      assert.equal(error.rateLimited, false);
      assert.equal(error.retryAfterMs, null);
      return true;
    },
  );
});
