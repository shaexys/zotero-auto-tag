# Auto-Tag (AI) for Zotero

A Zotero 7+ plugin that tags new papers against your own hierarchical taxonomy using an LLM, and rejects any tag the taxonomy does not contain.

## Why

A tag system is only useful if it is applied consistently, and hand-tagging hundreds of papers is where consistency breaks down. Letting a model tag freely is worse: it invents plausible tags that fragment the library. This plugin keeps the taxonomy as the single source of truth, a markdown file you maintain, and treats the model as a classifier that can only choose from it.

## How it works

1. When papers are added (or on right-click, "Auto-Tag (AI)"), the plugin sends each paper's title, abstract and basic metadata, together with the taxonomy section of your file, to an OpenAI-compatible chat-completions API.
2. The model returns tags in three branches (`Domain`, `Design`, `Analysis`) plus a study type (`/Original` or `/Review`).
3. **Every returned tag is validated against the taxonomy before it is written.** Paths outside the taxonomy (not a listed path, a parent of one, or a listed Topic and Aspect) are rejected and logged; when both a parent and a more specific child are returned, only the child is kept.
4. The `Domain` branch is a grid: any listed Topic combined with any listed Aspect is valid (`Domain/Depression/Risk-Factor`), so new topics need one table row, not a new branch.
5. Papers with no abstract are classified from title and metadata, and the model is told to tag only what the title supports.

The taxonomy file is re-read at most once a minute, so edits take effect without restarting Zotero.

## Setup

1. Build: `./build.sh` writes `auto-tag@shae.dev.xpi` one directory up. In Zotero: Tools, Add-ons, gear icon, Install Add-on From File.
2. In Zotero's Config Editor (Settings, Advanced), set:
   - `extensions.autotag.openai_key`: your API key
   - `extensions.autotag.taxonomy_path`: absolute path to your taxonomy file (start from `examples/taxonomy-example.md`)
   - optional: `extensions.autotag.model` (default `gpt-4o-mini`), `extensions.autotag.api_url` (an OpenAI-compatible chat-completions endpoint that supports JSON mode, `response_format: json_object`), `extensions.autotag.auto_on_add`

## Taxonomy format

See `examples/taxonomy-example.md`. The plugin reads only the `# Classification Tags` section; tag paths must be in backticks; the `Domain` section uses a **Topics** table and an **Aspects** table. An optional `## Tagging Rules` subsection holds rules specific to your taxonomy, which take precedence over the plugin's general rules.

## Companion

[auto-relate-zotero](https://github.com/shaexys/auto-relate-zotero) links papers already in your library through OpenAlex citation data.

## License

MIT
