import type { ReactNode } from "react";

export type HomeModeItem = {
  id: string;
  label: string;
  blurb: string;
};

type HomeLandingProps = {
  modes: ReadonlyArray<HomeModeItem>;
  onSelect: (id: string) => void;
};

function ModeIcon({ id }: { id: string }): ReactNode {
  const common = {
    width: 32,
    height: 32,
    viewBox: "0 0 32 32",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (id) {
    case "blur":
      return (
        <svg {...common}>
          <rect x="5" y="7" width="22" height="18" rx="3" />
          <circle cx="12" cy="14" r="2.5" />
          <path d="M5 22l6-5 4 3 5-6 7 8" />
        </svg>
      );
    case "foveal":
      return (
        <svg {...common}>
          <ellipse cx="16" cy="16" rx="11" ry="7" />
          <circle cx="16" cy="16" r="3.5" />
          <circle cx="16" cy="16" r="1.25" fill="currentColor" stroke="none" />
        </svg>
      );
    case "saliency":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="10" opacity="0.35" />
          <circle cx="16" cy="16" r="6.5" opacity="0.55" />
          <circle cx="16" cy="16" r="3" fill="currentColor" stroke="none" />
        </svg>
      );
    case "report":
      return (
        <svg {...common}>
          <rect x="6" y="5" width="20" height="22" rx="2" />
          <path d="M10 12h12M10 16h12M10 20h8" />
        </svg>
      );
    case "portraits":
      return (
        <svg {...common}>
          <circle cx="16" cy="12" r="4.5" />
          <path d="M7 26c1.5-5 5-7.5 9-7.5S23.5 21 25 26" />
        </svg>
      );
    case "collages":
      return (
        <svg {...common}>
          <rect x="5" y="5" width="10" height="10" rx="1.5" />
          <rect x="17" y="5" width="10" height="10" rx="1.5" />
          <rect x="5" y="17" width="10" height="10" rx="1.5" />
          <rect x="17" y="17" width="10" height="10" rx="1.5" />
        </svg>
      );
    case "av":
      return (
        <svg {...common}>
          <rect x="4" y="8" width="16" height="16" rx="2" />
          <path d="M20 13l7-3v12l-7-3" />
        </svg>
      );
    case "brandRemoval":
      return (
        <svg {...common}>
          <path d="M8 22l12-12" />
          <path d="M10 8h12v12" />
          <path d="M7 25h18" opacity="0.4" />
        </svg>
      );
    case "textReplace":
      return (
        <svg {...common}>
          <path d="M8 8h16M16 8v16" />
          <path d="M11 24h10" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="6" y="6" width="20" height="20" rx="3" />
        </svg>
      );
  }
}

export default function HomeLanding({ modes, onSelect }: HomeLandingProps) {
  return (
    <div className="home">
      <p className="home__intro">Choose a tool</p>
      <div className="home__grid">
        {modes.map((item) => (
          <button
            key={item.id}
            type="button"
            className="home__card"
            onClick={() => onSelect(item.id)}
            aria-label={item.label}
          >
            <span className="home__icon">
              <ModeIcon id={item.id} />
            </span>
            <span className="home__title">{item.label}</span>
            <span className="home__blurb">{item.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
