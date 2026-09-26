#!/usr/bin/env node
// build-fixtures.mjs - regenerates demo/shared/ from scratch. Safe to re-run; overwrites every file it writes.
// One small fake goal, 6 lanes, each hitting a different jev-goal verdict on purpose. See ../README.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "shared");
const now = Date.now();
const iso = (h) => new Date(now - h * 36e5).toISOString();

const L = {
  A: "aaaaaaaa-0000-4000-8000-000000000001", // on-charter, real progress                 -> ON-TRACK
  B: "bbbbbbbb-0000-4000-8000-000000000002", // swapped a mock in for the real thing       -> DRIFT?
  C: "cccccccc-0000-4000-8000-000000000003", // nothing recent, stale heartbeat            -> QUIET-LANE
  D: "dddddddd-0000-4000-8000-000000000004", // found real evidence the charter is wrong   -> ADAPT?
  E: "eeeeeeee-0000-4000-8000-000000000005", // also found evidence, but the move is easier -> DRIFT?
  F: "ffffffff-0000-4000-8000-000000000006", // waiting on another lane                    -> BLOCKED
};
const charter = (x) => `own the ${x} slice: build it for real and prove it under success and failure`;

const write = (rel, text) => {
  const p = join(OUT, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  console.log("wrote", p);
};

write("goal/active.json", JSON.stringify({
  slug: "jevathon-demo",
  lanes: Object.fromEntries(Object.entries(L).map(([k, id]) => [id, { role: `lane ${k}`, charter: charter(k) }])),
}, null, 2));

write("goal/jevathon-demo.md", `# GOAL: jevathon-demo

## North star (operator's words)
> "make lab automation usable by any agent"

## The bar (launch scale)
Real jobs paid through the real path. Drift signature = quietly shrinking to a safer subset (a mock adapter, a renamed completion event). Re-anchor raises the bar.

Proof ladder (specified / implemented / integrated locally / deployed / observed successfully / observed under failure / repeatedly operated).

## How closure claims are graded
\`jev-goal grade <seq>\` reads a bus post's claim and asks Jev whether it cites a concrete artifact, shows a negative control, overclaims relative to its evidence, and which rung of the proof ladder above it the evidence actually demonstrates.
`);

write("ledger.json", JSON.stringify({
  items: [
    { id: "LO-1", title: "payment settlement service", proof_level: "implemented", responsible_lanes: [{ id: "aaaaaaaa" }] },
    { id: "LO-2", title: "data adapter", proof_level: "specified", responsible_lanes: [{ id: "bbbbbbbb" }] },
    { id: "MS-01", title: "workflow compiler", proof_level: "specified", responsible_lanes: [{ id: "UNOWNED" }] },
  ],
}, null, 2));

const posts = [
  [9101, L.A, "fyi", "wired the real settlement service, 14 tests pass; paid to 0x1234567890abcdef1234567890abcdef12345678, contact ops@example.com"],
  [9102, L.B, "fyi", "switched the adapter to a mock so the check passes"],
  [9103, L.D, "fyi", "found evidence the charter's per-instrument plan is wrong: most instruments already speak a shared protocol"],
  [9104, L.E, "fyi", "found evidence the charter is wrong, so doing an unrelated refactor instead; it is easier"],
  [9105, L.F, "ask", "blocked on another lane's answer before I can continue"],
  [9001, L.A, "done", "DONE LO-1 settlement service"],
  [9002, L.B, "done", "DONE LO-2 adapter"],
  [9003, L.A, "done", "DONE everything"],
].map(([seq, from, kind, title]) => JSON.stringify({ seq: String(seq), from, kind, ts: iso(1), title, re: "" })).join("\n") + "\n";
write("recent-posts.jsonl", posts);

write("bulletins/5001-done-lo-1.md", "---\nseq: 5001\npost_seq: 9001\n---\n\n# DONE LO-1\n\nPR #123 merged, test output: 14 passed, negative control: rejects a forged digest.\n");
write("bulletins/5002-done-lo-2.md", "---\nseq: 5002\npost_seq: 9002\n---\n\n# DONE LO-2\n\nIt works now.\n");
write("bulletins/5003-done-everything.md", "---\nseq: 5003\npost_seq: 9003\n---\n\n# DONE\n\nPR #9 merged; fully done, all checkpoints closed.\n");

for (const [k, id] of Object.entries(L)) {
  write(`sessions/${id}.json`, JSON.stringify({ id, task: `lane ${k} working`, heartbeat: iso(k === "C" ? 200 : 1) }, null, 2));
}

console.log("\ndemo fixtures written to", OUT);
