# Example taxonomy for Auto-Tag

A small example in the format the plugin parses. Point `extensions.autotag.taxonomy_path` at your own file; only the `# Classification Tags` section is read. Every tag path must be written in backticks, and the LLM's output is rejected unless it matches a path listed here.

# Classification Tags

Three top-level categories. Depth below them is up to you; the plugin prefers the most specific matching tag and drops redundant parents.

## Domain

Schema: `Domain/{Topic}/{Aspect}`. Any Topic x Aspect combination is valid.

**Topics** (add as needed):

| Topic | Description |
|-------|-------------|
| `Depression` | Depressive disorders and symptoms |
| `Diabetes` | Type 1 and type 2 diabetes |

**Aspects** (fixed set, applies to all topics):

| Aspect | Description |
|--------|-------------|
| `Occurrence` | Prevalence, incidence, trends |
| `Risk-Factor` | What predicts or causes the condition |
| `Treatment` | Interventions and their effects |
| `Measurement` | How the condition is identified in research data |

## Design

- `Design/Data`
	- `Design/Data/EHR`: electronic health records
	- `Design/Data/Survey`: population surveys
	- `Design/Data/Wearables`: passive sensor data
- `Design/Population`
	- `Design/Population/Children`
	- `Design/Population/Adult`

## Analysis

- `Analysis/ML`
	- `Analysis/ML/Prediction`: supervised prediction models
	- `Analysis/ML/NLP`: clinical text processing
- `Analysis/Causal`: causal inference methods
- `Analysis/Survival`: time-to-event models

## Tagging Rules

Optional. The plugin sends this subsection to the model with the taxonomy, and these rules take precedence over its general rules. Use it for distinctions specific to your taxonomy.

1. Tag `Design/Data/Survey` only for population surveys, not for questionnaires collected inside a clinical study
2. Tag `Design/Population/Children` when the sample is mainly under 18, even if some adults are included

# Notes

Anything below the next top-level heading is ignored by the plugin.
