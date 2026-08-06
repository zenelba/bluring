import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  accessCookieHeader,
  createAccessToken,
  hasValidAccessCookie,
  isAcceptedAccessCode,
} from "./api/helpers/accessAuth.js";

function readBody(req: import("http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Local stand-in for Vercel `/api/access` during `vite` / `npm run dev`. */
function accessApiDevPlugin(): Plugin {
  return {
    name: "visuals-insight-access-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url !== "/api/access") {
          next();
          return;
        }

        const sendJson = (status: number, body: unknown, cookie?: string) => {
          const payload = JSON.stringify(body);
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          if (cookie) res.setHeader("Set-Cookie", cookie);
          res.end(payload);
        };

        try {
          if (req.method === "GET") {
            sendJson(200, {
              ok: hasValidAccessCookie(req.headers.cookie),
            });
            return;
          }

          if (req.method === "POST") {
            const raw = await readBody(req);
            let code = "";
            try {
              const parsed = JSON.parse(raw) as { code?: string };
              code = typeof parsed.code === "string" ? parsed.code : "";
            } catch {
              sendJson(400, { ok: false, error: "Missing access code" });
              return;
            }

            if (!code.trim()) {
              sendJson(400, { ok: false, error: "Missing access code" });
              return;
            }

            if (!isAcceptedAccessCode(code)) {
              sendJson(401, {
                ok: false,
                error: "That code isn’t accepted.",
              });
              return;
            }

            const token = createAccessToken();
            sendJson(200, { ok: true }, accessCookieHeader(token));
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, POST");
          res.end(JSON.stringify({ error: "Method not allowed" }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Access API error";
          sendJson(500, { ok: false, error: message });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), accessApiDevPlugin()],
});
