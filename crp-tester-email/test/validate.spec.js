import { describe, it, expect } from "vitest";
import { validateSignup, isAllowedOrigin } from "../src/validate.js";

const valid = { name: "Alex Morgan", email: "alex@example.com", requestId: "req_1" };

describe("validateSignup", () => {
  it("accepts a well-formed payload", () => {
    const result = validateSignup(valid);
    expect(result.ok).toBe(true);
  });

  it("normalises the email and trims whitespace", () => {
    const result = validateSignup({
      ...valid,
      name: "  Alex Morgan  ",
      email: "  Alex.Morgan@Example.COM  ",
    });
    expect(result.value.name).toBe("Alex Morgan");
    expect(result.value.email).toBe("alex.morgan@example.com");
  });

  it("rejects a non-object body", () => {
    expect(validateSignup(null).ok).toBe(false);
    expect(validateSignup("nope").ok).toBe(false);
    expect(validateSignup([]).ok).toBe(false);
  });

  it("rejects bad emails", () => {
    for (const email of ["", "nope", "a@b", "a b@c.com", "@c.com", "a@"]) {
      expect(validateSignup({ ...valid, email }).ok, email).toBe(false);
    }
  });

  it("rejects out-of-range names", () => {
    expect(validateSignup({ ...valid, name: "A" }).ok).toBe(false);
    expect(validateSignup({ ...valid, name: "x".repeat(81) }).ok).toBe(false);
  });

  it("rejects a requestId that could break the Idempotency-Key header", () => {
    // The id goes straight into an HTTP header, so restrict its characters.
    for (const requestId of ["has space", "new\nline", "sla/sh", "semi;colon"]) {
      expect(validateSignup({ ...valid, requestId }).ok, requestId).toBe(false);
    }
    expect(validateSignup({ ...valid, requestId: "req_abc-123.4" }).ok).toBe(true);
  });

  it("rejects an over-long requestId", () => {
    expect(validateSignup({ ...valid, requestId: "x".repeat(129) }).ok).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  const allowed = ["https://crp-company.github.io"];

  it("allows the configured origin", () => {
    expect(isAllowedOrigin("https://crp-company.github.io", allowed)).toBe(true);
  });

  it("rejects other, lookalike, and missing origins", () => {
    expect(isAllowedOrigin("https://evil.example", allowed)).toBe(false);
    // A prefix match would be a serious hole: evil-crp-company.github.io.attacker.tld
    expect(isAllowedOrigin("https://crp-company.github.io.evil.tld", allowed)).toBe(false);
    expect(isAllowedOrigin("http://crp-company.github.io", allowed)).toBe(false);
    expect(isAllowedOrigin(null, allowed)).toBe(false);
    expect(isAllowedOrigin("", allowed)).toBe(false);
  });
});
