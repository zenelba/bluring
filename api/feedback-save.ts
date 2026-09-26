/**
 * Save feedback via @zenel/user-feedback (Postgres + Blob + Resend).
 */

import { createFeedbackSaveHandler } from "@zenel/user-feedback/server";
import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

export default createFeedbackSaveHandler({
  appName: "Bluring",
  authorize: (req) => hasValidAccessCookie(req.headers?.cookie),
  ensureEnv: ensureProjectEnv,
});
