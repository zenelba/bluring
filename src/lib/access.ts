/** Client helpers for the server-backed access gate. */

export async function checkAccessSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/access", {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

export async function unlockWithAccessCode(
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/access", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (res.ok && data.ok) return { ok: true };
    return {
      ok: false,
      error: data.error ?? "That code isn’t accepted. Try another.",
    };
  } catch {
    return {
      ok: false,
      error: "Could not reach the server. Try again in a moment.",
    };
  }
}
