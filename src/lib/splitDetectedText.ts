import { fontCss, type FontWeightNum } from "./fontMatch";

export type SplitTextBBox = { x: number; y: number; w: number; h: number };

export type SplitTextNumberMeta = {
  value: number;
  decimalSep: "," | "." | null;
  thousandSep: "." | "," | " " | null;
  decimals: number;
  prefix: string;
  suffix: string;
  rawNumeric: string;
};

export type SplitDetectedText = {
  id: string;
  text: string;
  bbox: SplitTextBBox;
  kind: "text" | "number" | "logo";
  container: {
    type: "pill" | "plain";
    fill: string | null;
    radiusPxHint: number;
    padX: number;
    padY: number;
    rect: SplitTextBBox | null;
  };
  layoutGroupId: string | null;
  textBlockId: string | null;
  style: {
    color: string;
    fontWeight: "normal" | "bold";
    align: "left" | "center" | "right";
    fontFamily: string;
    fontSizeRel: number;
    scaleX: number;
  };
  number: SplitTextNumberMeta | null;
};

/** True when OCR text has at least two whitespace-separated tokens. */
export function canSplitDetectedText(item: { text: string }): boolean {
  return /\S+\s+\S+/.test(item.text);
}

function measureSplitSegmentWeights(
  item: SplitDetectedText,
  segments: string[],
): number[] {
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const sizePx = 100;
        const weight: FontWeightNum =
          item.style.fontWeight === "bold" ? 700 : 400;
        ctx.font = fontCss(
          item.style.fontFamily || "Montserrat",
          weight,
          sizePx,
        );
        const scaleX =
          Number.isFinite(item.style.scaleX) && (item.style.scaleX ?? 1) > 0
            ? (item.style.scaleX as number)
            : 1;
        return segments.map((s) =>
          Math.max(1e-6, ctx.measureText(s || " ").width * scaleX),
        );
      }
    }
  } catch {
    /* fall through to char weights */
  }
  return segments.map((s) => Math.max(1, (s || " ").length));
}

/**
 * Split one detection into separate placeholders per whitespace-separated
 * token. Bboxes keep parent y/h and divide width by glyph (or char) weights;
 * interstitial spaces are not included in child boxes. Children are always
 * plain (pill plate must not be shared).
 */
export function splitDetectedTextBySpaces(
  item: SplitDetectedText,
  parseNumber: (text: string) => SplitTextNumberMeta | null = () => null,
): SplitDetectedText[] | null {
  const matches = [...item.text.matchAll(/\S+/g)];
  if (matches.length < 2) return null;

  const tokens = matches.map((m) => ({
    text: m[0],
    index: m.index ?? 0,
  }));

  type Piece = { kind: "token" | "gap"; text: string };
  const pieces: Piece[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0) {
      const gapStart = tokens[i - 1].index + tokens[i - 1].text.length;
      const gapEnd = tokens[i].index;
      pieces.push({
        kind: "gap",
        text: item.text.slice(gapStart, gapEnd) || " ",
      });
    }
    pieces.push({ kind: "token", text: tokens[i].text });
  }

  const weights = measureSplitSegmentWeights(
    item,
    pieces.map((p) => p.text),
  );
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  let cursor = 0;
  const tokenBoxes: { x: number; w: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const w = item.bbox.w * (weights[i] / total);
    if (pieces[i].kind === "token") {
      tokenBoxes.push({ x: item.bbox.x + cursor, w });
    }
    cursor += w;
  }

  return tokens.map((tok, i) => {
    const number = parseNumber(tok.text);
    const box = tokenBoxes[i];
    return {
      id: `${item.id}__s${i}`,
      text: tok.text,
      bbox: {
        x: box.x,
        y: item.bbox.y,
        w: Math.max(box.w, 1e-6),
        h: item.bbox.h,
      },
      kind: number ? ("number" as const) : ("text" as const),
      container: {
        type: "plain" as const,
        fill: null,
        radiusPxHint: 0,
        padX: 0.45,
        padY: 0.28,
        rect: null,
      },
      layoutGroupId: null,
      textBlockId: null,
      style: { ...item.style },
      number,
    };
  });
}
