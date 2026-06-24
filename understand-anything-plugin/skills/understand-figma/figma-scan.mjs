#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFileKey, FigmaApiSource, parseDocument, extractTokens } from "@understand-anything/core/figma";

const [, , projectRoot, urlOrKey] = process.argv;
if (!projectRoot || !urlOrKey) {
  console.error("usage: figma-scan.mjs <projectRoot> <figmaUrlOrKey>");
  process.exit(1);
}

const fileKey = parseFileKey(urlOrKey);
const source = new FigmaApiSource(fileKey); // reads FIGMA_TOKEN from env; throws a friendly error if missing
const doc = await source.fetchDocument();
const styles = await source.fetchStyles().catch(() => ({ meta: { styles: [] } }));

const structural = parseDocument(doc, fileKey);
const tokens = extractTokens(doc, styles, structural.nodes, fileKey);
const nodes = [...structural.nodes, ...tokens.nodes];
const edges = [...structural.edges, ...tokens.edges];

// Pre-fetch thumbnails for screens only (bounded). URLs are pre-signed and
// may expire after a few hours — fine for view-after-generate; re-run to refresh.
const screens = structural.nodes.filter((n) => n.type === "screen");
try {
  const images = await source.renderImages(screens.map((n) => n.figmaMeta.nodeId));
  for (const s of screens) {
    const url = images[s.figmaMeta.nodeId];
    if (url) s.figmaMeta.thumbnailUrl = url;
  }
} catch {
  // thumbnails are optional — never fail the scan on image render
}

const manifest = {
  project: {
    name: doc.name,
    languages: ["figma"],
    frameworks: [],
    description: `Figma design file: ${doc.name}`,
    analyzedAt: new Date().toISOString(),
    gitCommitHash: "",
  },
  fileKey,
  nodes,
  edges,
};

const interDir = join(projectRoot, ".understand-anything", "intermediate");
mkdirSync(interDir, { recursive: true });
writeFileSync(join(interDir, "scan-manifest.json"), JSON.stringify(manifest, null, 2));

const count = (t) => nodes.filter((n) => n.type === t).length;
console.error(
  `Figma scan: ${count("page")} pages, ${count("screen")} screens, ` +
  `${count("component")} components, ${count("componentSet")} sets, ` +
  `${count("instance")} instances, ${count("token")} tokens`,
);
