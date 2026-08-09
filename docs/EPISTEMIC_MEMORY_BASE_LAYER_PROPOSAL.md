# Epistemic Memory Base Layer and Dynamic Priming

Status: design proposal; not an adopted implementation contract  
Date: 2026-08-08  
Scope: global Cognitive OS framework, with mem-graph as the current additive proving ground  
TypeDB posture: design reference or optional proof sidecar; not an adopted dependency or replacement

Current-governance note (2026-08-09): milestone statuses and gate terminology
in this proposal capture their historical design context. The former
MVP-001-to-MVP-002 tripwire is not an active blocker. The pure Phase 0 kernel is
available as a dormant repository module; persistence, MCP exposure, scheduling,
and authority promotion still require separate explicit operator authorization.

## Executive summary

This proposal defines a domain-neutral epistemic memory base layer for collaboration across projects, tasks, topics, agents, and sessions. It is not specific to QA orchestration. QA is one useful example of the general pattern, alongside software development, research, architecture, planning, operations, and future work.

The base layer should help an agent answer five questions whenever work begins or resumes:

1. What is the current scope and objective?
2. What is observed, believed, decided, and still uncertain?
3. Why are current beliefs and decisions justified?
4. Which guidance is authoritative and applicable here?
5. What changed previously, where did work stop, and which next actions are valid?

The proposed system is a provenance-first, scope-aware, contradiction-preserving memory architecture. It separates immutable observations from revisable beliefs, governed decisions, actions, outcomes, and reusable knowledge. It dynamically assembles a bounded epistemic briefing for each prompt instead of loading the entire graph or treating lexical relevance as authority.

The central design rule is:

> Make epistemic representation and retrieval rules global, while keeping most knowledge explicitly scoped.

## 1. Motivation

An ordinary memory can preserve a statement such as:

> Authentication is broken.

That statement does not establish:

- whether it was observed or inferred;
- which environment or version it applies to;
- which evidence supports or contradicts it;
- who asserted or approved it;
- how confident the system should be;
- whether it remains current;
- which decisions depended on it; or
- what would cause it to be revised.

An epistemic memory system preserves the reasoning structure surrounding a claim:

```text
Observation / Evidence
          |
          | supports or challenges
          v
        Belief
          |
          | informs
          v
       Decision
          |
          | authorizes or selects
          v
   Action / Artifact
          |
          | produces
          v
        Outcome
          |
          | confirms, weakens, or overturns
          v
    Revised Belief
```

This makes memory useful for continuity, audit, contradiction detection, belief revision, decision reconstruction, and team-shared reasoning—not only recollection.

## 2. Architectural boundary

Cognitive OS is a global, cross-project framework. The mem-graph repository is its current additive proving ground and persistence substrate, not the framework's permanent architectural boundary.

The base architecture is:

```text
Global epistemic substrate
|
+-- Partner layer
|   +-- collaboration preferences, responsibilities, and authority boundaries
|
+-- Procedural layer
|   +-- reusable methods, verification rules, and governance policies
|
+-- Semantic layer
|   +-- concepts, current beliefs, and validated cross-project knowledge
|
+-- Project overlays
|   +-- project-specific beliefs, decisions, policies, entities, and artifacts
|
+-- Task and investigation state
|   +-- active goals, uncertainties, theories, gates, and next actions
|
+-- Episodic history
    +-- executions, observations, corrections, outcomes, and closed trajectories
```

The framework must avoid two symmetric failures:

- **Over-globalization:** project-specific conclusions silently influence unrelated work.
- **Memory fragmentation:** stable collaboration preferences and reusable reasoning rules remain trapped inside one project.

The global layer defines how knowledge is represented, admitted, retrieved, trusted, revised, and retired. It does not make all stored content globally applicable.

## 3. Domain-neutral epistemic vocabulary

The vocabulary should work across QA, coding, research, architecture, operations, and other topics.

| Type | Meaning |
|---|---|
| Observation | Something directly seen, received, or measured |
| Evidence | An observation or artifact used to support or challenge a claim |
| Belief | A scoped, revisable interpretation of available evidence |
| Decision | A selected course of action with rationale and authority |
| Policy | A reusable rule governing future decisions or behavior |
| Procedure | A reusable method for performing or verifying work |
| Preference | A person or team's desired collaboration behavior |
| Goal | A desired future state linked to user or team value |
| Question | An unresolved uncertainty that may justify investigation |
| Action | Work performed because of a decision or plan |
| Outcome | The observed result of an action |
| Artifact | A file, report, plan, finding, test result, or other work product |
| Entity | A person, team, project, repository, system, environment, or concept |
| Episode | A bounded task trajectory containing context, actions, and outcomes |

These types should remain distinct even when one object plays multiple roles. For example, a test report is an artifact; when cited to support a regression belief, it also plays the role of evidence in that relationship.

## 4. The epistemic envelope

Every admitted memory should carry a consistent envelope independent of its subject matter.

```yaml
identity:
  id: canonical-id
  type: belief
  title: Token validation caused the authentication regression

content:
  statement: >
    The token-validation change is the most likely cause of the observed
    staging authentication failures.

epistemic:
  status: active
  confidence: 0.82
  assertion_kind: inferred
  authority: candidate

scope:
  project: example-project
  task: regression-investigation-142
  environment: staging
  version: build-482
  audience: team
  valid_from: 2026-08-08T18:00:00Z
  valid_until: null

provenance:
  source_type: agent_analysis
  source_actor: qa-skeptic-review
  observed_at: 2026-08-08T18:00:00Z
  source_references:
    - test-run-482
    - commit-abc123

relations:
  supported_by:
    - test-run-482
  challenged_by:
    - production-monitoring-normal
  supersedes: null
  motivated_decisions:
    - block-release-142

validity:
  reconsider_when:
    - failures reproduce on the unchanged branch
    - rollback does not restore tests
  refresh_strategy: re-evaluate after next controlled test

lifecycle:
  tier: milestone
  expires_at: null
```

The envelope prevents an agent-generated inference from being indistinguishable from an operator-approved decision or directly observed fact.

### Required distinctions

At minimum, the system should distinguish:

- observed versus inferred;
- candidate versus adopted;
- relevant versus authoritative;
- active versus superseded, archived, or invalid;
- project-scoped versus globally applicable;
- lexical association versus semantic assertion;
- source evidence versus derived cognitive state.

## 5. First-class epistemic relationships

Associative similarity and semantic truth have different lifecycles. Existing weighted, decaying synapses are valuable for discovery and activation, but they should not be interpreted as authoritative semantic assertions.

High-value semantic relationships include:

```text
evidence --supports------> belief
evidence --challenges----> belief
belief   --supersedes----> older belief
decision --based_on------> belief or evidence
decision --governed_by---> policy
action   --implements----> decision
action   --produces------> artifact
outcome  --result_of-----> action
outcome  --confirms------> belief
outcome  --contradicts---> belief
memory   --applies_to----> scope or entity
actor    --asserted------> belief
actor    --approved------> decision or artifact
```

A semantic relationship may need its own identity and metadata:

```yaml
relation_type: support
roles:
  evidence: test-run-482
  supported_claim: authentication-regression-belief
confidence: 0.90
status: active
asserted_by: qa-skeptic-review
observed_at: 2026-08-08T18:00:00Z
project: example-project
```

This design supports n-ary relationships when binary source-to-target edges lose important context. For example, a policy-applicability assertion can connect a policy, project, task family, environment, and approving authority through named roles.

## 6. Dynamic priming

The memory graph does not help an agent merely by existing. A session protocol must retrieve relevant state and inject a bounded briefing into the agent's context.

The primer should be a query-specific projection, not a database dump.

```text
Incoming prompt or resume signal
            |
            v
1. Resolve entities and aliases
            |
            v
2. Resolve project, task, topic, and environment scope
            |
            v
3. Select a bounded retrieval mode
            |
            v
4. Retrieve authoritative current guidance
            |
            v
5. Retrieve relevant beliefs, decisions, procedures, and state
            |
            v
6. Retrieve contradictions, uncertainty, and stale dependencies
            |
            v
7. Expand to evidence or history only when needed
            |
            v
8. Assemble a token-budgeted epistemic briefing
            |
            v
9. Begin or resume work
```

### 6.1 New-session prime

A new session needs stable orientation:

- partner and team collaboration context;
- explicit authority and approval boundaries;
- project objective and current phase;
- active canonical beliefs and decisions;
- applicable procedures and policies;
- unresolved questions and contradictions;
- recent material changes; and
- known next actions.

Example:

```yaml
partner_context:
  - The operator prefers evidence-backed reasoning and reviewable artifacts.
  - Consequential external updates require explicit authority.

project_context:
  project: mem-graph
  objective: Build a provenance-aware, cross-project cognitive substrate.
  current_phase: operator-selected bounded proving work

current_guidance:
  - Exact-project active guidance precedes graph expansion.
  - Retrieval rank and aliases establish relevance, not authority.

active_beliefs:
  - statement: Typed semantic admission is promising but requires a separately authorized contract.
    confidence: 1.0
    source: canonical-roadmap

open_questions:
  - Can first-class semantic relations answer a proven high-value query better
    than a narrow SQLite table or view?

next_valid_actions:
  - Continue independent live observations for the active task.
  - Design later candidates without silently authorizing them.
```

### 6.2 New-prompt prime

Within an active session, retrieval should narrow to the prompt's entities, topic, task family, and applicable procedures. Unrelated project memories should remain excluded unless analogy or cross-project audit is explicitly requested.

For a parser bug, the briefing should favor repository conventions, parser architecture, related incidents, tests, and current task state. QA-orchestration memories should not appear merely because they are important elsewhere.

### 6.3 Resume prime

A resumed task needs causal and operational continuity:

```yaml
task:
  id: task-142
  objective: Validate authentication regression

last_completed_action:
  action: execute-authentication-suite
  artifact: execution-results-482

current_state:
  result: 12 failures
  retry_count: 1
  environment: staging

current_belief:
  statement: Token validation may have caused the regression.
  confidence: 0.72

supporting_evidence:
  - test-run-482
  - commit-abc123

challenging_evidence:
  - production-monitoring-normal

pending_gate:
  requested_from: operator
  decision: approve skeptic review

next_valid_transitions:
  approve: skeptic-review
  revise: execute
  reject: close-task
```

The resume prime should reconstruct what was available and used at the last decision point, not only summarize the latest text.

## 7. Retrieval modes and progressive disclosure

The retrieval pipeline should select a bounded mode before graph expansion. Useful modes include:

- `investigation_resume`
- `episode_lookup`
- `evidence_audit`
- `knowledge_lookup`
- `belief_review`
- `policy_lookup`
- `decision_reconstruction`
- `reflection_cluster`
- `staleness_review`

Progressive disclosure limits context cost:

```text
Level 1: Current briefing and valid next actions
    |
    v when needed
Level 2: Applicable beliefs, decisions, policies, and procedures
    |
    v when challenged or audited
Level 3: Supporting and contradictory evidence
    |
    v for full reconstruction
Level 4: Original artifacts, event ledger, and execution trace
```

Most prompts should begin with Levels 1 and 2. The agent expands to raw evidence only when uncertainty, consequence, contradiction, or audit needs justify it.

## 8. Two-lane priming

A primer that returns only the highest-ranked current belief risks becoming an echo chamber. Priming should have two independent lanes.

### Lane A: current guidance

- adopted decisions;
- authoritative procedures;
- applicable policies;
- stable partner preferences;
- active beliefs and current task state.

### Lane B: epistemic tension

- credible contradictory evidence;
- competing active beliefs;
- low-confidence assumptions;
- unresolved questions;
- stale or expiring dependencies;
- decisions resting on superseded beliefs.

The second lane is especially important for consequential actions. Confidence should be displayed, but low confidence should not automatically suppress retrieval: a credible unresolved challenge may be more important than a highly confident background belief.

## 9. Ranking and authority

Candidate ranking should consider:

```text
retrieval priority =
    task relevance
  + exact scope fit
  + current status
  + authority and applicability
  + goal lineage
  + importance
  + appropriate freshness
  + verification quality
```

This is not intended as a literal uncalibrated arithmetic formula. The factors identify separate signals that should remain inspectable.

Critical rule:

> Relevance does not confer authority.

BM25 rank, semantic similarity, graph proximity, importance, boost, tags, aliases, layer, and lifecycle may help retrieve a record. None alone proves that the record is canonical, adopted, in scope, or applicable.

Before applying current guidance, the system must verify:

- canonical role;
- adoption state;
- project and task scope;
- active status;
- authority source;
- exclusions and validity conditions; and
- applicability to the current request.

The current user instruction remains authoritative over retrieved memory unless another higher-priority safety or system boundary applies. When a prompt conflicts with stored policy, the agent should surface the conflict and distinguish a one-time authorization from a durable policy change.

## 10. Entity and alias resolution

The interaction that motivated this proposal included the phrase `TableDB`, while the canonical relevant concept was `TypeDB`. An exact lexical search returned no memories; canonical entity resolution recovered existing TypeDB research and architectural decisions.

The primer therefore needs an entity-resolution stage:

```text
Observed mention: "TableDB"
        |
        v
candidate aliases and typo correction
        |
        v
canonical entity: TypeDB
        |
        v
retrieve relevant canonical memories and provenance
```

Resolution must remain reviewable. The system should record or display the mapping when ambiguity is material rather than silently rewriting user intent. A confirmed alias can become a retrieval aid; a one-time typo should not automatically become permanent semantic truth.

## 11. TypeDB as a design reference

TypeDB is relevant because its polymorphic entity-relation-attribute model provides:

- explicit entity, relation, and attribute types;
- first-class relations with named participant roles;
- relation-owned attributes;
- type hierarchies and interface-style polymorphism;
- schema-level constraints and validation; and
- explicit derived queries over connected typed data.

These mechanisms align with epistemic needs such as:

- evidence supporting or challenging a belief;
- a decision depending on multiple beliefs and policies;
- a policy applying through project, task, environment, and actor roles;
- a semantic assertion carrying confidence, provenance, status, and timestamps;
- detecting contradictory active commitments; and
- reconstructing actor, artifact, evidence, and decision paths.

### Adopted influence boundary

Existing Cognitive OS direction treats TypeDB as a design reference, not an adopted storage migration.

High-value ideas to translate selectively:

- explicit concept and relation types;
- named roles;
- first-class relationship instances when metadata is required;
- cardinality, uniqueness, eligibility, and role-player constraints;
- stored evidence separated from derived views;
- bounded subtype or interface applicability where it simplifies a proven query;
- human- and agent-readable schema documentation; and
- explainable results returning canonical memory, event, policy, and artifact IDs.

Ideas not authorized for transplantation without independent proof:

- TypeQL or a new general-purpose query language;
- a generic inference engine;
- unrestricted polymorphism, nested relations, or hypergraph machinery;
- a TypeDB client/server dependency or storage migration;
- replacing SQLite, FTS5/BM25, spreading activation, decay, or the event ledger;
- broad schema or database administration exposed to ordinary agents; and
- implementing a general ontology platform in anticipation of future needs.

The translation rule remains:

> Prefer the narrowest SQLite table, foreign key, constraint, trigger, view, recursive CTE, versioned validator, or purpose-built tool that proves the semantic benefit.

## 12. Potential hybrid architecture

TypeDB may be evaluated later as an optional, rebuildable semantic projection if a narrow SQLite implementation cannot safely or clearly answer a proven high-value query.

```text
                    mem-graph / SQLite
                   canonical substrate
                            |
        +-------------------+-------------------+
        |                   |                   |
        v                   v                   v
 FTS5/BM25 retrieval   associative graph   cognitive event ledger
 ranking and snippets  activation/decay    immutable provenance
        |                   |                   |
        +-------------------+-------------------+
                            |
                  selected stable projection
                            |
                            v
                   optional TypeDB sidecar
                            |
             +--------------+---------------+
             |              |               |
             v              v               v
         typed roles   constraints     derived semantic views
```

The projection would use existing canonical IDs. SQLite and the event ledger would remain the source of truth. The sidecar would have to be rebuildable, drift-detectable, operationally isolated, and justified by measured benefit.

## 13. Candidate structural queries

The epistemic layer should be justified by questions that are materially difficult or unsafe today:

1. Which active beliefs are supported only by invalid or superseded evidence?
2. Which decisions depend on beliefs that have since been challenged or replaced?
3. Which policies apply to this task through its project, environment, artifact type, and authority roles?
4. Which mutually contradictory commitments are simultaneously active in the same scope?
5. Who asserted, approved, challenged, or revised a belief, based on which artifact?
6. What evidence and policies were available and actually used when a decision was made?
7. Which later decision changed because a candidate policy was retrieved?
8. Which outcome confirmed, weakened, or overturned a prior belief?
9. Which memories are lexically relevant but ineligible to govern the current task?
10. Which cross-project lesson is genuinely portable, and under what exclusions?

## 14. Admission and belief revision

The system should not indiscriminately convert conversation into durable knowledge.

Candidate memories should pass gates for:

- future consequence;
- durability beyond the current turn;
- traceable evidence and justified confidence;
- novelty against canonical memory; and
- retrieval value greater than noise and maintenance cost.

Recommended state changes are:

- update the canonical memory when the concept is unchanged;
- create a new memory when the concept is genuinely new;
- supersede when a new belief replaces an older one;
- archive stale but historically useful state;
- invalidate confirmed erroneous state;
- retain unresolved contradiction explicitly; or
- discard routine, duplicate, or unsupported material.

Source observations and cognitive events should remain immutable. Beliefs and other projections are revisable. Supersession preserves history and explains why a later session sees a different current belief.

## 15. Safety and epistemic integrity

An epistemic primer can amplify errors if admission and retrieval are weak. Required safeguards include:

- provenance on consequential claims;
- explicit observed/inferred/candidate/adopted distinctions;
- project and task scope isolation;
- bounded graph expansion;
- status-aware retrieval;
- contradiction surfacing;
- authority verification independent of retrieval rank;
- append-only source evidence;
- supersession rather than silent rewriting;
- no automatic policy promotion or authority expansion;
- no permanent partner inference from a single interaction;
- no silent conversion of retrieved content into system instructions;
- token-budgeted primes; and
- human approval for consequential durable commitments.

Agent-generated conclusions should remain candidates until supported, evaluated, or explicitly adopted. One successful incident does not establish a universal rule.

## 16. Evaluation contract

The design is valuable only if it improves later work. Evaluation should measure outcomes, not merely whether memory was retrieved.

For each proof scenario, record:

1. The prompt, resolved scope, and retrieval mode.
2. Which memories were available.
3. Which memories were retrieved and actually used.
4. Which were excluded and why.
5. The decision path without the epistemic prime.
6. The decision path with the prime.
7. Whether the path changed because of retrieved memory.
8. Outcome quality, risk, latency, cost, and user correction.
9. Lifecycle or project contamination.
10. Contradictions surfaced or missed.
11. Whether evidence changed the relevant belief afterward.

Minimum success question:

> Did a later relevant prompt retrieve applicable, current, justified context that changed the decision beneficially without introducing authority, scope, or guardrail regressions?

## 17. Roadmap alignment

This proposal does not change the current roadmap or authorize implementation.

### Historical state when proposed

- **MVP-001 — Current-Guidance Retrieval:** implemented and then observed live.
- **MVP-002 — Typed Cognitive Admission and Projection Integrity:** frozen as a historical proof contract.
- **MVP-003 — First-Class Semantic Relations:** retained as historical candidate evidence.

### Relationship to later milestones

The epistemic envelope provides a conceptual target for typed admission. Any
persistent implementation must use an operator-adopted, versioned event and
projection contract rather than infer authority from this proposal.

First-class semantic relations belong to the MVP-003 candidate area. They should advance only if:

- typed admission catches meaningful failures;
- a high-value provenance, contradiction, or applicability query remains awkward or unsafe;
- a first-class relation answers it more clearly than a narrow table or view; and
- the proposal remains bounded rather than becoming a generic ontology system.

TypeDB evaluation remains a separate proof decision. No TypeDB dependency should be introduced merely because its conceptual model influenced this proposal.

## 18. Suggested proof sequence after explicit authorization

1. Select one real cross-session task family with measurable failure or continuity cost.
2. Freeze a baseline prime and outcome metric.
3. Define the smallest epistemic envelope fields required for that task.
4. Add one or two narrow semantic relationship types.
5. Create adversarial fixtures for stale scope, invalid authority, contradiction, and supersession.
6. Generate a new-session, new-prompt, and resume briefing from the same substrate.
7. Verify that the briefing is bounded, explainable, and reconstructable.
8. Test whether it changes a later decision beneficially.
9. Record guardrail, contamination, latency, and operator-correction outcomes.
10. Expand the ontology only when a new proven query requires it.

## 19. Non-goals

This proposal does not authorize:

- making QA orchestration the global memory schema;
- loading the full database into every prompt;
- treating confidence as calibrated probability without evidence;
- resolving contradictions by deleting one side;
- treating graph proximity as truth;
- treating aliases or lexical rank as authority;
- automatically converting conversation into permanent partner memory;
- replacing current user instructions with retrieved memory;
- adopting TypeDB or another database;
- implementing TypeQL, a generic inference engine, or a general ontology platform;
- changing existing synapse semantics;
- bypassing current Cognitive OS governance; or
- beginning persistence or semantic-relation implementation without explicit authorization.

## 20. Open design questions

1. Which epistemic envelope fields must be enforced at admission versus derived later?
2. Which relationship types justify first-class identity in the initial proof?
3. How should authority be represented mechanically rather than through instructions alone?
4. How should confidence be calibrated and revised across actors and evidence classes?
5. When should contradictory evidence be included in every prime versus retrieved on demand?
6. How should aliases be proposed, verified, scoped, and retired?
7. What token budget should be reserved for universal, project, task, and contradiction lanes?
8. Which partner preferences are safe to infer, and which require explicit adoption?
9. What constitutes sufficient evidence to promote a project lesson into cross-project knowledge?
10. Which proven query, if any, would justify a TypeDB projection sidecar?

## 21. Repository references

Deployment-local memory IDs are intentionally omitted. Resolve any canonical
tracker, scope boundary, or governing record from operator/project
configuration or exact-project guidance; never copy IDs from this proposal.

- [`cognitive-os/ROADMAP.md`](../cognitive-os/ROADMAP.md)
- [`MVP-001 current-guidance retrieval contract`](../cognitive-os/experiments/MVP-001-current-guidance-retrieval.md)
- [`MVP-002 typed admission and projection-integrity contract`](../cognitive-os/experiments/MVP-002-typed-admission-projection-integrity.md)

## 22. External TypeDB references

- [What is TypeDB?](https://typedb.com/docs/home/what-is-typedb/)
- [Entities, relations, and attributes](https://typedb.com/docs/core-concepts/typeql/entities-relations-attributes/)
- [TypeDB as a graph database](https://typedb.com/docs/use-cases/graph/)
- [Create a TypeDB schema](https://typedb.com/docs/home/get-started/schema)
- [TypeDB Studio](https://typedb.com/docs/tools/studio/)

---

The intended result is not an agent that remembers everything. It is an agent that can reconstruct the current justified position for the present task: what is known, what is believed, why it is believed, what remains uncertain, which guidance is authoritative, what changed, and which next actions are valid.
