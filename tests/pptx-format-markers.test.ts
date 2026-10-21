/**
 * PPTX format-marker helpers — bold/underline spans survive paragraph translate.
 * Run: npx vite-node tests/pptx-format-markers.test.ts
 */
import {
  collectAtNodes,
  encodeFormatMarkers,
  extractRunFormat,
  fixTranslationSpacing,
  parseFormatMarkers,
  planFormattedRewrite,
  rewriteAtNodes,
  stripFormatMarkers,
  type PptxFormatSegment,
  type PptxTextNode,
} from "../src/lib/pptxTranslation.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
}

// --- encode / parse round-trip ---
const segs: PptxFormatSegment[] = [
  {
    nodeIndices: [0],
    primaryNodeIndex: 0,
    text: "Opredeljena kot ",
    format: { bold: false, italic: false, underline: false },
  },
  {
    nodeIndices: [1],
    primaryNodeIndex: 1,
    text: "delež anketirancev, ki povezujejo znamko z",
    format: { bold: true, italic: false, underline: false },
  },
  {
    nodeIndices: [2],
    primaryNodeIndex: 2,
    text: " elementom v okviru kategorije.",
    format: { bold: false, italic: false, underline: false },
  },
];

const marked = encodeFormatMarkers(segs);
assert(
  marked ===
    "Opredeljena kot <b>delež anketirancev, ki povezujejo znamko z</b> elementom v okviru kategorije.",
  "encode wraps bold span",
);

const parsed = parseFormatMarkers(marked);
assertEq(parsed.length, 3, "parse three segments");
assertEq(parsed[1]!.format.bold, true, "middle is bold");
assertEq(parsed[0]!.format.bold, false, "lead plain");
assertEq(
  stripFormatMarkers(marked),
  "Opredeljena kot delež anketirancev, ki povezujejo znamko z elementom v okviru kategorije.",
  "strip markers",
);

const underlineMarked =
  "Ko je več kot 50% - <u>večina relevantnih potrošnikov</u>.";
const uParsed = parseFormatMarkers(underlineMarked);
assertEq(uParsed.length, 3, "underline parse");
assertEq(uParsed[1]!.format.underline, true, "middle underlined");

// spacing fix must not break tags
const spaced = fixTranslationSpacing(
  "Defined as the <b>percentage of respondents</b> who associate.",
);
assert(
  spaced.includes("<b>percentage of respondents</b>"),
  "spacing keeps bold tags",
);

// --- extract from OOXML ---
const sampleXml = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p>
        <a:r><a:rPr lang="sl-SI" dirty="0"/><a:t>Opredeljena kot </a:t></a:r>
        <a:r><a:rPr lang="sl-SI" b="1" dirty="0"/><a:t>delež anketirancev, ki povezujejo znamko z</a:t></a:r>
        <a:r><a:rPr lang="sl-SI" dirty="0"/><a:t> elementom v okviru kategorije.</a:t></a:r>
      </a:p>
      <a:p>
        <a:r><a:rPr lang="sl-SI" dirty="0"/><a:t>Ko je več kot 50% - </a:t></a:r>
        <a:r><a:rPr lang="sl-SI" dirty="0"><a:u val="sng"/></a:rPr><a:t>večina relevantnih potrošnikov</a:t></a:r>
        <a:r><a:rPr lang="sl-SI" dirty="0"/><a:t>.</a:t></a:r>
      </a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

const nodes = collectAtNodes("ppt/slides/slide1.xml", sampleXml, 1);
assertEq(nodes.length, 2, "two paragraphs");
assert(nodes[0]!.translateText.includes("<b>"), "para0 has bold marker");
assert(nodes[1]!.translateText.includes("<u>"), "para1 has underline marker");
assertEq(nodes[0]!.segments.length, 3, "bold para has 3 format segments");
assertEq(nodes[1]!.segments.length, 3, "underline para has 3 format segments");
assertEq(nodes[0]!.segments[1]!.format.bold, true, "seg bold");
assertEq(nodes[1]!.segments[1]!.format.underline, true, "seg underline");

const boldAt = sampleXml.indexOf(">delež");
assert(extractRunFormat(sampleXml, boldAt).bold, "extractRunFormat bold");

// --- rewrite keeps text in matching runs ---
const node0 = nodes[0]!;
const enBold =
  "Defined as the <b>percentage of respondents who associate the brand with</b> the element within the category.";
const plan = planFormattedRewrite(node0, enBold);
assertEq(plan.replacements.size, 3, "three replacements");
assertEq(
  plan.replacements.get(node0.segments[1]!.primaryNodeIndex),
  "percentage of respondents who associate the brand with",
  "bold run gets bold translation",
);
assertEq(
  plan.replacements.get(node0.segments[0]!.primaryNodeIndex),
  "Defined as the ",
  "plain lead",
);

const rewritten = rewriteAtNodes(sampleXml, plan.replacements, plan.clear);
assert(
  /b="1"[^>]*>[\s\S]*?<a:t[^>]*>percentage of respondents who associate the brand with<\/a:t>/.test(
    rewritten,
  ) ||
    rewritten.includes(
      'b="1" dirty="0"/><a:t>percentage of respondents who associate the brand with</a:t>',
    ),
  "bold rPr still wraps translated bold text",
);

// fallback when markers dropped → all in primary
const plainPlan = planFormattedRewrite(node0, "Defined as the percentage.");
assertEq(plainPlan.replacements.size, 1, "fallback single replacement");
assert(
  plainPlan.replacements.has(node0.primaryNodeIndex),
  "fallback uses primary",
);

// uniform paragraph (no mixed format) → no markers
const uniformXml = `<a:p><a:r><a:rPr b="1"/><a:t>Hello</a:t></a:r><a:r><a:rPr b="1"/><a:t> world</a:t></a:r></a:p>`;
const uniform = collectAtNodes("ppt/slides/slide2.xml", uniformXml, 2);
assertEq(uniform.length, 1, "one uniform para");
assertEq(uniform[0]!.translateText, "Hello world", "no markers when uniform");
assertEq(uniform[0]!.segments.length, 1, "one segment when same format");

// type smoke for PptxTextNode
const _n: PptxTextNode = node0;
assert(_n.translateText.length > 0, "node has translateText");

console.log("pptx-format-markers: ok");
