import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  GHArchiveClient,
  GHArchiveError,
  ghArchiveHourUrl,
} from "../src/gh-archive/client.js";

test("GH Archive URL uses the official unpadded UTC hour format", () => {
  assert.equal(
    ghArchiveHourUrl(
      new Date("2026-07-30T00:00:00Z"),
      "https://example.test/",
    ),
    "https://example.test/2026-07-30-0.json.gz",
  );
});

test("GH Archive client streams gzip JSON events without network access", async () => {
  const events = [
    {
      type: "WatchEvent",
      repo: { name: "owner/repository" },
      payload: { action: "started" },
      created_at: "2026-07-30T03:10:00Z",
    },
    {
      type: "PushEvent",
      repo: { name: "owner/repository" },
      created_at: "2026-07-30T03:20:00Z",
    },
  ];
  let requestedUrl = "";
  let receivedSignal = false;
  const client = new GHArchiveClient({
    baseUrl: "https://example.test",
    requestTimeoutMs: 5_000,
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      receivedSignal = init?.signal instanceof AbortSignal;
      const ndjson = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      return new Response(gzipSync(ndjson));
    },
  });

  const collected = [];
  for await (const record of client.recordsForHour(
    new Date("2026-07-30T03:00:00Z"),
  )) {
    collected.push(record);
  }

  assert.equal(
    requestedUrl,
    "https://example.test/2026-07-30-3.json.gz",
  );
  assert.equal(receivedSignal, true);
  assert.deepEqual(
    collected,
    events.map((event, index) => ({
      kind: "event",
      line: index + 1,
      event,
    })),
  );
});

test("GH Archive client skips a malformed record and continues", async () => {
  const validEvent = {
    type: "WatchEvent",
    repo: { name: "owner/repository" },
    created_at: "2026-07-30T03:10:00Z",
  };
  const client = new GHArchiveClient({
    fetchImplementation: async () =>
      new Response(
        gzipSync(`{"broken":"record\n${JSON.stringify(validEvent)}\n`),
      ),
  });
  const records = [];

  for await (const record of client.recordsForHour(
    new Date("2026-07-30T03:00:00Z"),
  )) {
    records.push(record);
  }

  assert.equal(records[0]?.kind, "parse-error");
  assert.deepEqual(records[1], {
    kind: "event",
    line: 2,
    event: validEvent,
  });
});

test("GH Archive timeout aborts a stalled request", async () => {
  const client = new GHArchiveClient({
    requestTimeoutMs: 5,
    fetchImplementation: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      }),
  });

  await assert.rejects(
    async () => {
      for await (const _record of client.recordsForHour(
        new Date("2026-07-30T04:00:00Z"),
      )) {
        // A stalled request must not yield records.
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof GHArchiveError);
      assert.equal(error.status, null);
      assert.match(error.message, /request failed/i);
      return true;
    },
  );
});

test("GH Archive client reports an hourly HTTP failure", async () => {
  const client = new GHArchiveClient({
    fetchImplementation: async () =>
      new Response(null, { status: 503 }),
  });

  await assert.rejects(
    async () => {
      for await (const _record of client.recordsForHour(
        new Date("2026-07-30T04:00:00Z"),
      )) {
        // No events are expected from an error response.
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof GHArchiveError);
      assert.equal(error.status, 503);
      assert.equal(error.hour, "2026-07-30T04:00:00.000Z");
      return true;
    },
  );
});
