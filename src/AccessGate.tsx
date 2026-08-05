import { type FormEvent, type ReactNode, useState } from "react";
import {
  hasUnlockedAccess,
  isValidAccessCode,
  unlockAccess,
} from "./lib/access";
import "./App.css";

type AccessGateProps = {
  children: ReactNode;
};

export default function AccessGate({ children }: AccessGateProps) {
  const [unlocked, setUnlocked] = useState(() => hasUnlockedAccess());
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (unlocked) {
    return <>{children}</>;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (isValidAccessCode(code)) {
      unlockAccess();
      setUnlocked(true);
      setError(null);
      return;
    }
    setError("That code isn’t accepted. Try another.");
  };

  return (
    <div className="access-gate">
      <div className="access-gate__panel">
        <div className="access-gate__logo">V</div>
        <h1 className="access-gate__title">Visuals insight</h1>
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
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Enter code"
          />
          {error && <p className="access-gate__error">{error}</p>}
          <button className="btn btn--primary access-gate__submit" type="submit">
            Unlock
          </button>
        </form>
      </div>
    </div>
  );
}
