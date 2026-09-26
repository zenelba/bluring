/**
 * List / fetch feedback reports via @zenel/user-feedback.
 */

import { createFeedbackListHandler } from "@zenel/user-feedback/server";
import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

export default createFeedbackListHandler({
  appName: "Bluring",
  authorize: (req) => hasValidAccessCookie(req.headers?.cookie),
  ensureEnv: ensureProjectEnv,
});
