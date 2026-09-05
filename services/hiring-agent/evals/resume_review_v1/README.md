# TeamFlow résumé-review evaluation seed corpus

This directory contains versioned, synthetic, offline evaluation fixtures. It is not
production résumé data and its expected behavior has not yet been human reviewed.

- `validation.jsonl`: 30 cases intended for evaluator and policy development.
- `test.jsonl`: 20 cases protected by `test.lock.json`; normal verification is read-only.
- `adversarial.jsonl`: 15 security, reliability, tenancy, and extraction stress cases.

All records are marked `pending_human_review`. A file hash protects exact bytes, while
input and record fingerprints protect semantic identity and complete-record integrity.
Equivalence groups must remain inside one split. The lock prevents accidental or silent
changes to the test split; coordinated changes to data and locks still require code review
and a dataset-version decision.

Verify without network, model, database, or cloud access:

```bash
cd services/hiring-agent
python -m teamflow_hiring_agent.evaluation verify --dataset evals/resume_review_v1
```

Phase 5 also provides a read-only `risk-coverage` command. It takes a verified dataset,
the canonical confidence-policy file, a run manifest, and a separate label-set manifest:

```bash
python -m teamflow_hiring_agent.evaluation risk-coverage \
  --dataset evals/resume_review_v1 \
  --confidence-policy teamflow_hiring_agent/resume_review/confidence_policy_v1.json \
  --run-manifest /path/to/shadow-run-manifest.json \
  --label-set-manifest /path/to/label-set-manifest.json
```

Each manifest names a direct, hash-bound JSONL member stored beside it. The command
requires the exact complete verified validation population; verifies dataset, split,
case-ID, input, artifact, and policy identities; carries declared model/configuration,
prompt, result-schema, graph, and evaluator identities into the aggregate report; and
recomputes every assessment from its supplied cached signals under the canonical policy.
The label-set manifest binds the exact observation run, observation-set fingerprint, and
run-manifest fingerprint, while every label repeats the matched Agent 1 result
fingerprint. This prevents labels from being reused against a different cached output.
These checks detect inconsistency and replay within the artifact set, but do not prove
that the declared runtime produced those signals. The SHA-256 values and unsigned
manifests provide integrity and comparability, not external attestation. The command
rejects locked test/adversarial subsets and partial runs.
Equal scores remain one atomic cutoff, hard failures are never eligible for acceptance,
and output is aggregate-only with an explicit accept-none point and
`threshold_selected=false`.

Label manifests distinguish `fixture_only` from `human_approved`. Fixture labels require
the explicit `--allow-fixture-labels` flag and produce a visibly fixture-only report;
they test tooling mechanics and are not measurement evidence. A `human_approved`
manifest requires approval metadata, but that declaration is an auditable contract—not
independent proof that people performed the review.

This directory contains no observation producer, shadow-run artifacts, or approved label
set. All 65 seed cases remain `pending_human_review`, so no real risk/coverage report has
been run or saved and no acceptance threshold has been selected. Independent review,
adjudication, authenticated provenance, and governed artifact retention are required
before making a measured-quality claim.

The five additional validation cases in dataset v1.1.0 make a future 30-case comparison
structurally possible. They are still synthetic and pending review; their presence does
not prove balanced labels, independent annotation, judge agreement, or human evidence.

Phase 7's offline `diagnostic_judge` module defines a strict transient semantic packet,
closed three-dimension model output, content-free cached inputs/outcomes, and a comparable
run manifest. A no-retry Gemini adapter is bounded by an outer deadline, provider timeout,
token cap, temperature zero, structured schema, safety configuration, and disabled tools;
fixture and test transports are labeled separately from live-provider artifacts. No live
judge output or approved human-comparison artifact is committed here. Dataset/population
trust comes from the separate verifier/regression consumer, not from a run manifest's
unsigned hash declarations alone.

Once independently reviewed labels and two comparable full-validation judge caches exist,
the read-only consumer is invoked as follows:

```bash
python -m teamflow_hiring_agent.evaluation semantic-regression \
  --dataset evals/resume_review_v1 \
  --baseline-lock /path/to/baseline-lock.json \
  --candidate-run-manifest /path/to/candidate-run-manifest.json \
  --label-set-manifest /path/to/human-label-set-manifest.json
```

The baseline lock, both run manifests, and label manifest bind direct sibling artifacts
by SHA-256 and semantic fingerprints. Fixture labels require the explicit
`--allow-fixture-labels` option and always emit `fixture_only_not_evidence`; they cannot
produce a passing or failing human-evidence gate. The command never calls a model, writes
a baseline, selects a threshold, or controls production hiring behavior. A
`human_approved` status and approval record are auditable declarations, not independent
attestation that review or adjudication occurred.

Do not add real résumés, contact details, embeddings, provider responses, or secrets.
