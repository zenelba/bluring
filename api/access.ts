import {
  accessCookieHeader,
  createAccessToken,
  hasValidAccessCookie,
  isAcceptedAccessCode,
} from "../server/accessAuth";

interface AccessRequestBody {
  code?: string;
}

type Req = {
  method?: string;
  body?: AccessRequestBody;
  headers?: { cookie?: string | string[] };
};

type Res = {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader: (name: string, value: string) => void;
};

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({
      ok: hasValidAccessCookie(req.headers?.cookie),
    });
    return;
  }

  if (req.method === "POST") {
    const code = req.body?.code;
    if (typeof code !== "string" || !code.trim()) {
      res.status(400).json({ ok: false, error: "Missing access code" });
      return;
    }

    if (!isAcceptedAccessCode(code)) {
      res.status(401).json({ ok: false, error: "That code isn’t accepted." });
      return;
    }

    const token = createAccessToken();
    res.setHeader("Set-Cookie", accessCookieHeader(token));
    res.status(200).json({ ok: true });
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
