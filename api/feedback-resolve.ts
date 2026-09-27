/**
 * Mark feedback reports resolved via @zenel/user-feedback.
 */

import { createFeedbackResolveHandler } from "@zenel/user-feedback/server";
import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

export default createFeedbackResolveHandler({
  appName: "Bluring",
  projectId: "bluring",
  authorize: (req) => hasValidAccessCookie(req.headers?.cookie),
  ensureEnv: ensureProjectEnv,
});
