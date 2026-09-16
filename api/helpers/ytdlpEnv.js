import { isYtdlpConfigured } from "./ytdlp.js";

export function isYtdlpEnabled() {
  if (process.env.YT_DLP_DISABLED === "1") return false;
  if (process.env.YT_DLP_ENABLED === "1") return true;
  return isYtdlpConfigured();
}
