import { ensureProjectEnv } from "./loadEnv.js";

const PLACEHOLDER_RE =
  /^(sk-\.\.\.|sk-your|sk-xxx|hf_your|change-me)/i;

export function getOpenAiApiKey() {
  ensureProjectEnv();
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key || PLACEHOLDER_RE.test(key)) return "";
  return key;
}

export function getOpenAiBaseUrl() {
  ensureProjectEnv();
  return (
    process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  ).replace(/\/$/, "");
}

export function assertOpenAiConfigured(context = "OpenAI") {
  const key = getOpenAiApiKey();
  if (!key) {
    throw new Error(
      `${context} is not configured. Set a real OPENAI_API_KEY in .env.local (project root), then restart \`npx vercel dev\`.`,
    );
  }
  return key;
}
