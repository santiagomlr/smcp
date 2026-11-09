import assert from "node:assert/strict";
import test from "node:test";
import { nextVersion } from "../scripts/next-version.mjs";

test("raises the patch number when package.json was not changed", () => {
  assert.equal(nextVersion("0.1.3", "0.1.3"), "0.1.4");
});

test("keeps raising after releases that package.json never recorded", () => {
  assert.equal(nextVersion("0.1.3", "0.1.9"), "0.1.10");
});

test("respects a version raised by hand", () => {
  assert.equal(nextVersion("0.2.0", "0.1.9"), "0.2.0");
});

test("uses package.json for the first release", () => {
  assert.equal(nextVersion("0.1.0", ""), "0.1.0");
});
