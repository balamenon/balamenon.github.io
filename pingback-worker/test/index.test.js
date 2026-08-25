import assert from "node:assert/strict";
import test from "node:test";

import { parsePingbackPayload } from "../src/index.js";

test("accepts and normalizes a valid pingback", () => {
  const result = parsePingbackPayload({
    name: "  Bala\nMenon  ",
    replyTo: "  bala@example.com ",
    message: " Hello\r\nworld ",
    website: "",
    turnstileToken: "token",
  });

  assert.deepEqual(result, {
    name: "Bala Menon",
    replyTo: "bala@example.com",
    message: "Hello\nworld",
    turnstileToken: "token",
  });
});

test("rejects an empty message", () => {
  assert.throws(
    () => parsePingbackPayload({ message: "   ", turnstileToken: "token" }),
    /Message is required/,
  );
});

test("rejects an overlong message", () => {
  assert.throws(
    () => parsePingbackPayload({ message: "a".repeat(4001), turnstileToken: "token" }),
    /4000 characters or fewer/,
  );
});

test("rejects a filled honeypot", () => {
  assert.throws(
    () => parsePingbackPayload({ message: "hello", website: "https://spam.example", turnstileToken: "token" }),
    /Invalid form submission/,
  );
});

test("strips terminal and bidi control characters", () => {
  const result = parsePingbackPayload({
    message: "hello\u001b[31m\u202eworld",
    turnstileToken: "token",
  });

  assert.equal(result.message, "hello[31mworld");
});
