import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { checkAccessSession, unlockWithAccessCode } from "./lib/access";
import "./App.css";

type AccessGateProps = {
  children: ReactNode;
};

export default function AccessGate({ children }: AccessGateProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await checkAccessSession();
      if (!cancelled) {
        setUnlocked(ok);
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <div className="access-gate">
        <div className="access-gate__panel">
          <div className="access-gate__logo">I</div>
          <p className="access-gate__copy">Checking access…</p>
        </div>
      </div>
    );
  }

  if (unlocked) {
    return <>{children}</>;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await unlockWithAccessCode(code);
    setSubmitting(false);
    if (result.ok) {
      setUnlocked(true);
      return;
    }
    setError(result.error);
  };

  return (
    <div className="access-gate">
      <div className="access-gate__panel">
        <div className="access-gate__logo">I</div>
        <h1 className="access-gate__title">Image Processor</h1>
        <p className="access-gate__copy">Enter an access code to continue.</p>
        <form className="access-gate__form" onSubmit={handleSubmit}>
          <label className="access-gate__label" htmlFor="access-code">
            Access code
          </label>
          <input
            id="access-code"
            className="access-gate__input"
            type="text"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            value={code}
            disabled={submitting}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Enter code"
          />
          {error && <p className="access-gate__error">{error}</p>}
          <button
            className="btn btn--primary access-gate__submit"
            type="submit"
            disabled={submitting || !code.trim()}
          >
            {submitting ? "Checking…" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
