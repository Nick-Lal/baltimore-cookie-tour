---
name: llm-council
description: >
  Convene an LLM Council (after Andrej Karpathy's llmcouncil) to judge, review, or answer
  something hard: multiple models answer independently, anonymously peer-review and rank each
  other's responses, and a chairman synthesizes the final verdict. Use when the user asks for a
  council review, a multi-model judgment, or the highest-confidence assessment of a deliverable
  (website, document, analysis, plan) or question.
---

# LLM Council

Karpathy's llmcouncil (github.com/karpathy/llmcouncil) sends one query to several frontier
models, has them anonymously rank each other's answers, then has a chairman model write the
final response informed by everything. This skill reproduces that three-stage protocol with
the models available to this harness via the Agent/Workflow tools.

## Council composition

Use the maximum model diversity the harness offers, one member per model tier:

| Seat | Model (Agent `model` param) | Persona注 |
|---|---|---|
| Member 1 | `fable`  | most capable generalist |
| Member 2 | `opus`   | senior deep-reasoning reviewer |
| Member 3 | `sonnet` | fast, broad, pragmatic reviewer |
| Member 4 | `haiku`  | concision + clarity advocate |

注 Personas are NOT differentiated by prompt content — every member gets the IDENTICAL brief
(that is the point of the council: independent perspectives from independent models, not
role-played diversity). If more seats are wanted, add a second seat per model with a different
review dimension, but never leak which model produced which response.

## The three stages (run as ONE Workflow for determinism)

**Stage 1 — First opinions.** Dispatch the identical brief to all members in parallel
(`parallel()` of `agent()` calls, each with its `model` override). Each returns a structured
response. Never show members each other's output at this stage.

**Stage 2 — Anonymous peer review.** Shuffle the stage-1 responses into a fixed anonymized
order (Response A, B, C, ...; use the seat index, never the model name). Each member receives
ALL responses (including, unavoidably, its own — Karpathy keeps this too) and must (a) critique
each response's accuracy and insight, and (b) output a strict ranking best→worst with one-line
justifications. Instruct members to judge content only, not style similarity, and to be
adversarial: hunt for errors, omissions, and unsupported claims.

**Stage 3 — Chairman synthesis.** The chairman (default: `fable`, or the model the main loop
runs on) receives the original brief, all stage-1 responses (still anonymized), and all stage-2
critiques/rankings. It produces: (1) the consensus points every member agreed on, (2) the
genuine disagreements and who is right (with reasons), (3) the final synthesized
answer/verdict/action list, and (4) the aggregate ranking table with de-anonymized model names
(only the chairman's report may de-anonymize).

## Structured output schemas

Stage 1 (answering a question): `{ answer, key_points[], confidence }`
Stage 1 (judging a deliverable): `{ verdict_summary, strengths[], defects[{severity, description, fix}], score_0_100, must_fix_before_ship[] }`
Stage 2: `{ critiques[{response_id, critique}], ranking[response_id...], ranking_rationale }`
Stage 3 is prose plus `{ final_score_0_100, must_fix[], nice_to_have[] }` when judging.

## Judging a website or document (the common case here)

Give every member the SAME materials: the live URL or file paths, the intended audiences, and
the acceptance bar. For a website, instruct members to read the actual pages (Read/WebFetch)
— never judge from a description. Require each defect to name the page/section it occurs on.
The chairman's `must_fix` list is the work queue; re-convene the council after fixes only if
must_fix items were substantive (a second full round, not more).

## Ground rules

- Members must receive identical inputs; any asymmetry invalidates the ranking.
- Anonymization is by seat letter; models must never be named inside stage-2 inputs.
- The council judges; the main loop decides. Treat the chairman's must_fix list as strong
  advice, overridable only with stated reasons.
- Cost scales with seats × stages; for small questions use 3 seats (fable, opus, haiku) and
  skip nothing — the peer-review stage is what makes it a council rather than a poll.
