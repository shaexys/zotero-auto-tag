/* global Zotero, IOUtils, PathUtils, Services */

Zotero.AutoTag = {
  // ========== Config ==========
  get API_KEY() {
    return Zotero.Prefs.get("extensions.autotag.openai_key", true) || "";
  },
  get API_URL() {
    return (
      Zotero.Prefs.get("extensions.autotag.api_url", true) ||
      "https://api.openai.com/v1/chat/completions"
    );
  },
  get MODEL() {
    return (
      Zotero.Prefs.get("extensions.autotag.model", true) || "gpt-4o-mini"
    );
  },
  get TAXONOMY_PATH() {
    return (
      Zotero.Prefs.get("extensions.autotag.taxonomy_path", true) ||
      ""  // set to the absolute path of your taxonomy file, e.g. examples/taxonomy-example.md
    );
  },
  get ENABLED() {
    const val = Zotero.Prefs.get("extensions.autotag.enabled", true);
    return val === undefined ? true : val;
  },
  get AUTO_ON_ADD() {
    const val = Zotero.Prefs.get("extensions.autotag.auto_on_add", true);
    return val === undefined ? true : val;
  },

  ADD_DELAY_MS: 5000, // Wait for metadata to populate after item-add
  BATCH_WINDOW_MS: 3000, // Batch items added within this window
  API_TIMEOUT_MS: 30000, // OpenAI API timeout

  _notifierID: null,
  _pendingItems: [],
  _batchTimer: null,
  _processingItems: new Set(), // Self-trigger guard
  _taxonomyCache: null,
  _taxonomyCacheTime: 0,
  _TAXONOMY_CACHE_TTL: 60000, // Re-read taxonomy if older than 60s
  _menuItemID: "auto-tag-context-menu",
  _menuSeparatorID: "auto-tag-context-separator",

  // ========== Lifecycle ==========
  init({ id, version, rootURI }) {
    this._log(`Initialized v${version}`);

    // Set default prefs if not already set
    const defaults = {
      "extensions.autotag.openai_key": "",
      "extensions.autotag.api_url":
        "https://api.openai.com/v1/chat/completions",
      "extensions.autotag.model": "gpt-4o-mini",
      "extensions.autotag.taxonomy_path":
        "",  // set to the absolute path of your taxonomy file, e.g. examples/taxonomy-example.md
      "extensions.autotag.enabled": true,
      "extensions.autotag.auto_on_add": true,
    };

    for (const [key, defaultVal] of Object.entries(defaults)) {
      if (Zotero.Prefs.get(key, true) === undefined) {
        Zotero.Prefs.set(key, defaultVal, true);
      }
    }

    this._notifierID = Zotero.Notifier.registerObserver(
      this._observer,
      ["item"],
      "AutoTag"
    );
    this._log("Notifier observer registered");

    this._addContextMenu();
  },

  destroy() {
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
    }
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._pendingItems = [];
    this._processingItems.clear();
    this._taxonomyCache = null;
    this._removeContextMenu();
    this._log("Destroyed");
  },

  // ========== Context Menu ==========
  _addContextMenu() {
    const win = Zotero.getMainWindow();
    if (!win) return;
    const doc = win.document;
    const menu = doc.getElementById("zotero-itemmenu");
    if (!menu) {
      this._log("Item context menu not found, retrying in 2s");
      setTimeout(() => this._addContextMenu(), 2000);
      return;
    }

    const separator = doc.createXULElement("menuseparator");
    separator.id = this._menuSeparatorID;
    menu.appendChild(separator);

    const menuItem = doc.createXULElement("menuitem");
    menuItem.id = this._menuItemID;
    menuItem.setAttribute("label", "Auto-Tag (AI)");
    menuItem.addEventListener("command", () => {
      Zotero.AutoTag.processSelectedItems();
    });
    menu.appendChild(menuItem);

    this._log("Context menu item added");
  },

  _removeContextMenu() {
    const win = Zotero.getMainWindow();
    if (!win) return;
    const doc = win.document;
    for (const id of [this._menuItemID, this._menuSeparatorID]) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
    this._log("Context menu item removed");
  },

  // ========== Manual Trigger (selected items) ==========
  async processSelectedItems() {
    if (!this.ENABLED) {
      this._log("Plugin disabled");
      return;
    }

    const apiKey = this.API_KEY;
    if (!apiKey) {
      this._log(
        "No API key set. Run in Zotero JS console: Zotero.Prefs.set('extensions.autotag.openai_key', 'sk-...', true)"
      );
      return;
    }

    const zp = Zotero.getActiveZoteroPane();
    const selectedItems = zp.getSelectedItems();
    if (selectedItems.length === 0) {
      this._log("No items selected");
      return;
    }

    // Filter to regular items (skip attachments, notes)
    const items = selectedItems.filter((item) => item.isRegularItem());
    if (items.length === 0) {
      this._log("No regular items selected");
      return;
    }

    this._log(`Manual run: ${items.length} item(s) selected`);

    const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
    progressWin.changeHeadline("Auto-Tag: Classifying papers...");
    progressWin.show();

    const taxonomy = await this._loadTaxonomy();
    if (!taxonomy) {
      progressWin.changeHeadline("Auto-Tag: Error loading taxonomy");
      progressWin.startCloseTimer(4000);
      return;
    }

    let tagged = 0;
    let skipped = 0;
    let errors = 0;

    for (const item of items) {
      const title = item.getField("title").substring(0, 50);
      try {
        const result = await this._classifyAndTag(item, taxonomy, true);
        if (result === "tagged") {
          tagged++;
        } else {
          skipped++;
        }
      } catch (e) {
        this._log(`Error processing "${title}": ${e.message}`);
        errors++;
      }
    }

    progressWin.changeHeadline("Auto-Tag: Done");
    const summary = new progressWin.ItemProgress(
      "",
      `${tagged} tagged, ${skipped} skipped, ${errors} errors`
    );
    summary.setProgress(100);
    progressWin.startCloseTimer(4000);

    this._log(
      `Manual run complete: ${tagged} tagged, ${skipped} skipped, ${errors} errors`
    );
  },

  // ========== Notifier Observer ==========
  _observer: {
    notify(event, type, ids, extraData) {
      if (event === "add" && type === "item") {
        Zotero.AutoTag._onItemsAdded(ids);
      }
    },
  },

  _onItemsAdded(ids) {
    if (!this.ENABLED || !this.AUTO_ON_ADD) return;
    if (!this.API_KEY) return;

    this._pendingItems.push(...ids);

    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
    }
    this._batchTimer = setTimeout(() => {
      const batch = [...this._pendingItems];
      this._pendingItems = [];
      this._batchTimer = null;
      this._processBatch(batch);
    }, this.BATCH_WINDOW_MS);
  },

  // ========== Batch Processing ==========
  async _processBatch(ids) {
    await this._sleep(this.ADD_DELAY_MS);

    const items = [];
    for (const id of ids) {
      try {
        const item = await Zotero.Items.getAsync(id);
        if (!item || !item.isRegularItem()) continue;
        // Skip if no title
        const title = item.getField("title");
        if (!title || title.trim() === "") continue;
        items.push(item);
      } catch (e) {
        this._log(`Error loading item ${id}: ${e.message}`);
      }
    }

    if (items.length === 0) {
      this._log("No processable items in batch");
      return;
    }

    this._log(`Processing batch of ${items.length} item(s)`);

    const taxonomy = await this._loadTaxonomy();
    if (!taxonomy) {
      this._log("Cannot process batch: taxonomy unavailable");
      return;
    }

    let tagged = 0;
    for (const item of items) {
      try {
        const result = await this._classifyAndTag(item, taxonomy);
        if (result === "tagged") tagged++;
      } catch (e) {
        this._log(
          `Error processing "${item.getField("title")}": ${e.message}`
        );
      }
    }

    this._log(`Batch complete: ${tagged}/${items.length} tagged`);
  },

  // ========== Core Classification Logic ==========
  // force=true: strip existing taxonomy tags and re-classify (right-click)
  // force=false: skip if already tagged (auto-add on new items)
  async _classifyAndTag(item, taxonomy, force = false) {
    const title = item.getField("title");
    const abstract = item.getField("abstractNote");
    const hasAbstract = abstract && abstract.trim() !== "";

    if (!hasAbstract) {
      this._log(`Warning: no abstract for "${title.substring(0, 50)}", classifying from title + metadata`);
    }

    // Check existing tags — distinguish CLASSIFICATION (Domain/Design/Analysis) vs STUDY-TYPE markers (/Original, /Review)
    // Only classification tags trigger the "already tagged, skip" path. Manual /Original or /Review markers must NOT block auto-classification.
    const existingTags = item.getTags().map((t) => t.tag);
    const classificationTags = existingTags.filter(
      (t) =>
        t.startsWith("#Domain/") ||
        t.startsWith("#Design/") ||
        t.startsWith("#Analysis/")
    );
    const studyTypeTags = existingTags.filter(
      (t) => t === "/Original" || t === "/Review"
    );
    const userHasStudyType = studyTypeTags.length > 0;

    if (classificationTags.length > 0 && !force) {
      this._log(
        `Skipping "${title.substring(0, 50)}" (already has classification tags)`
      );
      return "skipped";
    }

    this._log(`Classifying: "${title.substring(0, 60)}"`);

    // Gather extra metadata for context (especially useful when no abstract)
    const extraMeta = {};
    const journal = item.getField("publicationTitle");
    if (journal) extraMeta.journal = journal;
    const doi = item.getField("DOI");
    if (doi) extraMeta.doi = doi;
    const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
    if (itemType) extraMeta.itemType = itemType;
    const date = item.getField("date");
    if (date) extraMeta.year = date;

    // Call LLM API
    const llmResult = await this._callOpenAI(
      title,
      hasAbstract ? abstract : null,
      taxonomy.markdown,
      extraMeta
    );
    if (!llmResult) {
      this._log(`LLM classification failed for "${title.substring(0, 50)}"`);
      return "skipped";
    }

    // Validate tags against taxonomy
    let validatedTags = this._validateTags(llmResult, taxonomy.validPaths);
    if (validatedTags.length === 0) {
      this._log(
        `No valid tags returned for "${title.substring(0, 50)}"`
      );
      return "skipped";
    }

    // In auto_on_add mode (force=false): preserve user's manual study_type marker if present.
    // Avoids LLM adding conflicting /Original when user already marked /Review (or vice versa).
    if (!force && userHasStudyType) {
      validatedTags = validatedTags.filter((t) => t !== "/Original" && t !== "/Review");
      this._log(
        `Preserved user's manual study_type (${studyTypeTags.join(",")}); dropped LLM's study_type`
      );
    }

    // Apply tags. In force mode the old taxonomy and study-type tags are removed
    // only now, after a valid result exists, so a failed call leaves them intact.
    this._processingItems.add(item.id);
    try {
      if (force) {
        for (const tag of [...classificationTags, ...studyTypeTags]) {
          item.removeTag(tag);
        }
      }
      for (const tag of validatedTags) {
        item.addTag(tag, 0);
      }
      await item.saveTx();
      this._log(
        `Tagged "${title.substring(0, 50)}" with: ${validatedTags.join(", ")}`
      );
    } finally {
      this._processingItems.delete(item.id);
    }

    return "tagged";
  },

  // ========== Taxonomy Parser ==========
  async _loadTaxonomy() {
    const now = Date.now();
    if (
      this._taxonomyCache &&
      now - this._taxonomyCacheTime < this._TAXONOMY_CACHE_TTL
    ) {
      return this._taxonomyCache;
    }

    const filePath = this.TAXONOMY_PATH;
    if (!filePath) {
      this._log("No taxonomy file set: add extensions.autotag.taxonomy_path in Zotero's Config Editor");
      return null;
    }
    this._log(`Loading taxonomy from: ${filePath}`);

    try {
      // Normalize Windows line endings so section headings match
      const content = (await IOUtils.readUTF8(filePath)).replace(/\r\n/g, "\n");

      // Extract the Classification Tags section
      const hierarchyMatch = content.match(
        /# Classification Tags\n([\s\S]*?)(?=\n# (?!#)|$)/
      );
      if (!hierarchyMatch) {
        this._log("Could not find '# Classification Tags' section in taxonomy file");
        return null;
      }
      const hierarchySection = hierarchyMatch[1];

      // Extract all tag paths from the hierarchy
      // Matches backtick-enclosed paths like `Domain/Depression/Risk-Factor` or `#Domain/Depression/Risk-Factor`
      const validPaths = new Set();
      const pathRegex = /`#?([A-Z][A-Za-z]+\/[^`]+)`/g;
      let match;
      // Paths mentioned inside the optional Tagging Rules subsection are not taxonomy entries.
      const pathSection = hierarchySection.replace(/## Tagging Rules\n[\s\S]*?(?=\n## |$)/, "");
      while ((match = pathRegex.exec(pathSection)) !== null) {
        validPaths.add(match[1]);
      }

      for (const l1 of ["Domain", "Design", "Analysis"]) {
        validPaths.add(l1);
      }

      // Domain uses Cartesian schema: parse the Topic and Aspect tables under "## Domain"
      // and expand all valid Domain/{Topic}/{Aspect} combinations into validPaths.
      const domainMatch = hierarchySection.match(/## Domain\n([\s\S]*?)(?=\n## |$)/);
      if (domainMatch) {
        const ds = domainMatch[1];
        const extractTableTokens = (label) => {
          const blockRe = new RegExp(`\\*\\*${label}\\*\\*[\\s\\S]*?\\|\\s*-+\\s*\\|[\\s\\S]*?(?=\\n\\n|\\n\\*\\*|$)`);
          const blockMatch = ds.match(blockRe);
          if (!blockMatch) return [];
          return [...blockMatch[0].matchAll(/\|\s*`([^`\/]+)`\s*\|/g)].map(m => m[1]);
        };
        const topics = extractTableTokens("Topics");
        const aspects = extractTableTokens("Aspects");
        for (const t of topics) {
          validPaths.add(`Domain/${t}`);
          for (const a of aspects) {
            validPaths.add(`Domain/${t}/${a}`);
          }
        }
        this._log(`Domain Cartesian expansion: ${topics.length} topics × ${aspects.length} aspects = ${topics.length * aspects.length} combinations`);
      }

      this._log(`Taxonomy loaded: ${validPaths.size} valid paths`);

      // Build the markdown to send to LLM (the hierarchy section)
      const taxonomy = {
        markdown: hierarchySection.trim(),
        validPaths: validPaths,
      };

      this._taxonomyCache = taxonomy;
      this._taxonomyCacheTime = now;
      return taxonomy;
    } catch (e) {
      this._log(`Error loading taxonomy: ${e.message}`);
      this._taxonomyCache = null;
      return null;
    }
  },

  // ========== OpenAI API Call ==========
  async _callOpenAI(title, abstract, taxonomyMarkdown, extraMeta = {}) {
    const apiKey = this.API_KEY;
    if (!apiKey) {
      this._log("No API key configured");
      return null;
    }

    const systemPrompt = `You are a research paper classifier. Your job is to assign hierarchical tags from the provided taxonomy to academic papers based on their title and available metadata. Return JSON only, no explanation.`;

    // Build paper section with available metadata
    let paperSection = `**Title:** ${title}`;
    if (abstract) {
      paperSection += `\n\n**Abstract:** ${abstract}`;
    }
    if (extraMeta.journal) {
      paperSection += `\n**Journal:** ${extraMeta.journal}`;
    }
    if (extraMeta.year) {
      paperSection += `\n**Year:** ${extraMeta.year}`;
    }
    if (extraMeta.itemType) {
      paperSection += `\n**Item type:** ${extraMeta.itemType}`;
    }

    const noAbstractNote = abstract
      ? ""
      : "\n12. This paper has NO abstract. Classify based on the title and any available metadata. Only assign tags you are reasonably confident about from the title. Set confidence to \"low\" if the title is ambiguous.";

    const userPrompt = `## Taxonomy

${taxonomyMarkdown}

## Rules

1. Assign paper-level tags ONLY (use \`#\` prefix for Domain, Design, and Analysis tags)
2. Title Case all segments, acronyms always uppercase (EHR, ML)
3. Choose the DEEPEST (most specific) applicable level in the hierarchy. Prefer leaf nodes over parent nodes
4. Domain tags use Topic x Aspect schema: \`#Domain/{Topic}/{Aspect}\`. Combine ANY Topic from the Topics table with ANY Aspect from the Aspects table; every combination is valid. Domain is OPTIONAL: SKIP Domain entirely for pure methodology papers, reference standards (such as diagnostic manuals), and reviews that span many Topics. When a Topic fits but no Aspect matches the paper's content, stop at Topic-only (such as \`#Domain/Depression\`) rather than force-fitting a misleading Aspect.
5. Design and Analysis use hierarchical paths, such as \`#Design/Data/EHR\`
6. For study type, assign exactly one: \`/Original\` or \`/Review\`
7. Assign ALL applicable tags; do not limit the number. Every relevant Domain, Design, and Analysis category should be represented
8. Only use tags whose components exist in the taxonomy above. Design and Analysis are CLOSED taxonomies (do not invent new branches). Domain is an OPEN Cartesian schema: ANY Topic × ANY Aspect from the listed tables is valid (this is not "inventing")
9. Read the inline descriptions for each tag to understand its meaning. Abbreviations have specific definitions that may differ from common usage
10. Study type internal consistency: any aggregation of existing literature (systematic, narrative, scoping or umbrella review, meta-analysis) is \`/Review\`; \`/Original\` is for primary empirical research. Never assign both to the same paper
11. If the taxonomy above contains a "Tagging Rules" subsection, follow those rules; they take precedence over rules 1-10${noAbstractNote}

## Paper

${paperSection}

## Output Format

Return valid JSON only:
{
  "domain_tags": ["#Domain/..."],
  "design_tags": ["#Design/..."],
  "analysis_tags": ["#Analysis/..."],
  "study_type": "/Original",
  "confidence": "high"
}`;

    const body = {
      model: this.MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    };

    try {
      const response = await fetch(this.API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        this._log(
          `API error ${response.status}: ${errText.substring(0, 200)}`
        );
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        this._log("No content in API response");
        return null;
      }

      const parsed = JSON.parse(content);
      return parsed;
    } catch (e) {
      this._log(`API call error: ${e.message}`);
      return null;
    }
  },

  // ========== Tag Validation ==========
  _validateTags(llmResult, validPaths) {
    const validated = [];

    // Process domain, design, analysis tags
    const tagArrays = [
      llmResult.domain_tags || [],
      llmResult.design_tags || [],
      llmResult.analysis_tags || [],
    ];

    for (const tags of tagArrays) {
      for (const tag of tags) {
        if (typeof tag !== "string") continue;

        // Normalize: ensure # prefix
        let normalized = tag.startsWith("#") ? tag : `#${tag}`;

        // Extract path without # for validation
        const path = normalized.substring(1);

        // Check if this path (or any parent path) exists in taxonomy
        if (this._isValidPath(path, validPaths)) {
          validated.push(normalized);
        } else {
          this._log(`Rejected invalid tag: ${normalized}`);
        }
      }
    }

    // Deduplicate: remove parent tags when a more specific child exists
    // e.g., if #Analysis/ML/Prediction/Deep-Learning exists, remove #Analysis/ML and #Analysis/ML/Prediction
    const deduped = validated.filter((tag) => {
      return !validated.some(
        (other) => other !== tag && other.startsWith(tag + "/")
      );
    });

    // Process study type
    const studyType = llmResult.study_type;
    if (studyType === "/Original" || studyType === "/Review") {
      deduped.push(studyType);
    }

    return deduped;
  },

  _isValidPath(path, validPaths) {
    // Exact match
    if (validPaths.has(path)) return true;

    // Check if path is a valid prefix up to a known node
    // e.g., "Domain/Depression" is valid even if only "Domain/Depression/Risk-Factor" is listed
    // because "Domain" uses Topic x Aspect schema where any Topic exists
    for (const valid of validPaths) {
      if (valid.startsWith(path + "/")) return true;
    }

    // Check if path extends a known valid path
    // e.g., "Domain/Perinatal/Burden" should be valid if "Domain" topics are open
    // and "Burden" is a known aspect
    const parts = path.split("/");
    if (parts.length >= 2 && parts[0] === "Domain") {
      // Domain uses open schema: any Topic x any Aspect
      const knownTopics = new Set();
      const knownAspects = new Set();
      for (const valid of validPaths) {
        const vp = valid.split("/");
        if (vp[0] === "Domain" && vp.length >= 2) knownTopics.add(vp[1]);
        if (vp[0] === "Domain" && vp.length >= 3) knownAspects.add(vp[2]);
      }
      if (parts.length === 2) return knownTopics.has(parts[1]);
      if (parts.length === 3)
        return knownTopics.has(parts[1]) && knownAspects.has(parts[2]);
    }

    return false;
  },

  // ========== Helpers ==========
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  _log(msg) {
    Zotero.debug(`[AutoTag] ${msg}`);
    Services.console.logStringMessage(`[AutoTag] ${msg}`);
  },
};
