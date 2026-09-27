#!/usr/bin/env node
/**
 * Thin wrapper → global review-user-errors skill.
 * Prefer: node ~/.cursor/skills/review-user-errors/scripts/fetch-feedback-errors.cjs
 */
const path = require("path");
const os = require("os");
const globalScript = path.join(
  os.homedir(),
  ".cursor",
  "skills",
  "review-user-errors",
  "scripts",
  "fetch-feedback-errors.cjs",
);
require(globalScript);
