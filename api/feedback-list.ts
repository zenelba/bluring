/**
 * List / fetch feedback reports from Postgres (for Plan mode / owner review).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  getFeedbackReport,
  isFeedbackDbConfigured,
  listFeedbackReports,
} from "./helpers/feedbackDb.js";

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    query?: { id?: string; limit?: string };
  },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    setHeader: (name: string, value: string) => void;
  },
) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(204).json({});
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!hasValidAccessCookie(req.headers?.cookie)) {
    res.status(401).json({ error: "Access code required" });
    return;
  }

  if (!isFeedbackDbConfigured()) {
    res.status(503).json({
      error:
        "Postgres is not configured. Add a Neon/Postgres store and POSTGRES_URL (and Blob BLOB_READ_WRITE_TOKEN for screenshots).",
      configured: false,
    });
    return;
  }

  try {
    const id = req.query?.id?.trim();
    if (id) {
      const row = await getFeedbackReport(id);
      if (!row) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(200).json({ configured: true, report: row });
      return;
    }

    const limit = Number(req.query?.limit ?? 50);
    const reports = await listFeedbackReports(limit);
    res.status(200).json({ configured: true, reports });
  } catch (err) {
    console.error("feedback-list failed", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list feedback",
    });
  }
}
