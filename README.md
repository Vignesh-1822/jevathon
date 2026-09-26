# jev-goal

An independent, Jev-powered judge for autonomous multi-agent systems: it watches what an agent lane
actually did and asks [Jev](https://typesafe.ai) typed questions to tell **drift** (quietly narrowing
to a smaller, safer version of the task) apart from **adaptation** (the lane found real evidence its
plan is wrong, and changing course is the right move) — two things that look identical from the
outside but deserve opposite responses. It also pre-grades closure claims ("DONE") against a proof
ladder, so "it works" and "PR #123 merged, 14 tests pass, here's the failure case too" don't get
treated the same.

Built in one day for [Jevathon](https://app.notion.com/p/coderabbit/JEVATHON-Jev-Hackathon-SF-3e796e76cda18143b74af9944bc5cddc)
(TypeSafe AI x The AI Collective, Sept 26 2026, hosted at CodeRabbit).

## Why this is built *with* Jev, not just calling it once

Every verdict this tool produces is a typed Jev answer, not a heuristic:

- `jev-goal judge` asks Jev 8 typed questions per lane (`serves_charter`, `meets_bar`,
  `scope_narrowing`, `off_charter`, `blocked`, `adaptation`, `easier_not_better`, `progress`, plus a
  `choice` question when there's a task ledger to attribute work against) — see `judgeRequest()` in
  `jev-goal.mjs`.
- `jev-goal grade` asks 4-5 typed questions about a closure claim (`has_artifact`, `negative_control`,
  `overclaim`, `drift`, `rung`) — see `gradeRequest()`.
- The **verdict policy is separate code** (`judgeVerdict()`, `gradeVerdict()`) that reads Jev's
  probabilities against named thresholds (`JUDGE_T`, `GRADE_T`). This is deliberate: you can see
  exactly where a probability becomes a decision, and change the policy without touching what's asked.
- **Speculative fan-out**: every question a verdict might need is asked in one call, because a Jev
  call costs about the same for 1 question as for 20 (see the header comment in `jev.mjs`). A second
  round-trip to ask "oh, and is it blocked?" after already seeing the answer would cost a full call for
  a few extra tokens.
- Before anything leaves the machine, `scrub()` masks hex addresses, API-key-shaped strings, emails and
  URL query strings — the demo below shows this actually happening, not just claims it.

If you remove Jev from this tool, there is no tool left: the questions it asks *are* the judgment.

## Quickstart

```bash
node --version                 # needs >= 22
node jev-goal.mjs selftest     # 31 checks, fully offline: fake bus, fake ledger, fake Jev server
node jev.mjs selftest          # 35 checks on the client itself
```

To see it against a real Jev call:

```bash
export TYPESAFE_API_KEY=...          # or AI_GATEWAY_API_KEY for the Vercel AI Gateway route
node demo/build-fixtures.mjs         # writes demo/shared/ - a small fake goal with 6 lanes,
                                      # each hitting a different verdict on purpose
export JEV_GOAL_SHARED="$(pwd)/demo/shared"
export JEV_GOAL_LEDGER="$(pwd)/demo/shared/ledger.json"
export JEV_GOAL_EGRESS=1             # explicit opt-in before anything is sent anywhere
node jev-goal.mjs judge --all --send
```

Six lanes, six different real verdicts from one small fixture set:

| lane | what it did | verdict |
|---|---|---|
| A | real work, on its charter | `ON-TRACK` |
| B | swapped in a mock to pass a check | `DRIFT?` |
| C | nothing recent, stale heartbeat | `QUIET-LANE` (no call made — cost discipline) |
| D | found real evidence its charter is wrong | `ADAPT?` (writes a proposal file, changes nothing itself) |
| E | also found evidence, but the change is just easier | `DRIFT?` (adaptation requires the change be *better*, not merely easier) |
| F | waiting on another lane | `BLOCKED` |

```bash
node jev-goal.mjs grade 9001 --send    # a claim WITH a PR + test output + a failure case -> PLAUSIBLE
node jev-goal.mjs grade 9002 --send    # "it works now", no artifact                       -> NEEDS-ARTIFACT
node jev-goal.mjs grade 9003 --send    # "fully done, all checkpoints closed"               -> OVERCLAIM?
```

Every real call is dry-run by default (prints the exact request, sends nothing) until you set
`JEV_GOAL_EGRESS=1` and pass `--send` — whoever runs this decides when anything actually leaves the
machine.

## Rubric, honestly

- **Use of Jev**: architectural, not decorative — see above. Every branch a verdict can take traces
  back to a specific typed answer, in code you can read in one sitting (~580 lines, zero dependencies).
- **Technical**: `node jev-goal.mjs selftest` proves the plumbing and the policy without needing a key;
  `demo/` proves it against a real Jev call with no private infrastructure required.
- **Originality**: this is a reasonable, fairly direct application of a typed-decision model to agent
  oversight — not claiming to be the first typed-decision tool of any kind. What we think is genuinely
  distinct is treating drift and adaptation as *separate* typed questions with opposite responses,
  instead of one "is this okay" score.
- **Anti-slop**: no mock data pretending to be a live call, no unlabeled inference, no claim this tool
  can't back up. Where confidence in this README is inference rather than a measured result, it's said
  as inference.

## What this is not

This is a judgment layer, not an enforcement layer: verdicts are shadow-logged advice, never block a
lane, and an `ADAPT?` verdict only ever writes a proposal file for a human to read — it never edits
anyone's plan itself. That's intentional: a typed-decision model should surface judgment for a human or
a policy to act on, not silently take the action.

It also assumes a specific shape of input (a goal document, a lane roster, a timestamped bus of posts,
an optional task ledger). Real usage reads that from a live multi-agent coordination system; `demo/`
reproduces that shape standalone so this repo is runnable without one.

## License

MIT — see `LICENSE`.
