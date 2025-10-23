# Offline Incident Processing Portal

## Overview
The portal provides an offline workspace for loading incident exports in CSV format and analyzing them without any server dependencies. All logic runs in the browser, including duplicate detection, keyword search, and automatic tag discovery. The interface opens directly from index.html and relies only on the local js/vendor libraries bundled with the project. Settings that operators change are stored in localStorage, so each browser retains its configuration between sessions.

### Supported CSV exports
* Delimiters: semicolon (;) with quoted fields.
* Encodings: UTF-8 (with or without BOM) and Windows-1251.
* Maximum volume: designed for 10 000+ rows per file.

During import the portal applies deterministic delimiter detection, trims BOM markers, decodes text, normalizes headers, and builds uniform ticket records. When a column is missing, the loader derives fallback values from related fields (for example, requester and contact are used to fill empty author names). The same normalization routine is shared by all features and by the automated smoke test in tests/smoke.js.

## Application structure
The UI is split into three tabs that work on the normalized dataset:

1. Duplicate Finder (Дубли обращений) - groups similar incidents raised by the same author.
2. Case Search (Поиск по обращениям) - provides full-text lookup with editable categories and filters.
3. Tag Discovery (Поиск тегов) - extracts common n-gram phrases for each template name.

Each tab is implemented in a dedicated script (app.dups.js, app.search.js, app.tags.js) and communicates with a Web Worker engine (app.dups.engine.js, app.tags.engine.js) for heavy computations. When a worker cannot be spawned the main thread falls back to the same engine logic, so functionality remains available in restrictive environments.

### Theme and layout
The stylesheet css/style.css defines a responsive layout that adapts to desktop and tablet widths. A light/dark theme toggle is available in the header; the choice is saved in localStorage.theme. Components use pure CSS without external frameworks to guarantee offline availability.

## Duplicate Finder
Duplicate analysis searches for incidents submitted by the same author with highly similar descriptions.

### Text preparation
* Authors are normalized to lower case with the letter yo mapped to e and extra spaces removed.
* Only the description field participates in scoring. The text is lower-cased, stripped of punctuation and HTML fragments, and split into letter-or-digit tokens.
* Configurable stop phrases are removed (default examples: "добрый день", "здравствуйте", "прошу помочь").
* A light stemming pass trims typical Russian endings and applies a synonym map so technical terms like "vrm" and "врм" are treated as the same token.

### Similarity model
For each author the engine compares ticket pairs within the optional date window. It calculates:
* T3 - cosine similarity of character trigrams.
* J3 - Jaccard similarity of 3-word shingles.

The final score is 0.60 * T3 + 0.40 * J3. Length-aware thresholds decide whether the pair forms a duplicate:
* fewer than 8 tokens - require S >= 0.80.
* 8..19 tokens - require S >= 0.70.
* 20+ tokens - require S >= 0.62.

Operators can disable the smart thresholds and set a flat minimum if needed. Matching pairs are merged into clusters through a union-find structure. The master ticket in each cluster is the most recently created item; all others are marked as duplicates.

### Operator workflow
* Cluster headers show the author, master ticket link, and the number of duplicates that need closing.
* Each cluster has a "Not a duplicate" button. Removing a cluster immediately updates the summary counts and prevents the tickets from appearing in exports.
* Duplicate rows list ID, creation date, similarity percentage, token overlap ratio, and a snippet with highlighted common phrases.
* Quick actions:
  * Open in Sphere - constructs https://sfera.vtb.ru/sd/support?open= plus the encoded ID.
  * Copy closing note - copies the standard resolution: Ошибочное обращение / Дубль обращения <MASTER_ID>. Работы продолжаются там.
* Export duplicates - downloads duplicates.csv containing only duplicate rows (UTF-8 BOM, semicolon separator, quoted cells).

### Settings panel
* Date window - compare tickets within the selected number of days (default 14, can be disabled).
* Smart threshold - toggle adaptive thresholds; when off, a single slider defines the minimum score.
* Stop phrases - textarea with newline-separated phrases removed during normalization. Stored in localStorage.dupStopPhrases.

## Case Search
The search tab indexes incident data for fast filtering.

### Indexing scope
The search worker indexes ID, author, description, service, and tags, applying the same text normalization as the duplicate engine. Only author and description participate in the free-text score, matching the product requirements.

### Ranking model
Weights are assigned to match types:
* Exact multi-word phrase (2-3 words) - +5.
* Exact word match - +2.
* Fuzzy match (Levenshtein distance <= 1) - +1.
* Matches found in service or tag fields receive a x1.2 multiplier.

Results are sorted by total weight and displayed in a virtualized table with the following columns: ID, description, created date, status, and priority. The author column is intentionally hidden as requested.

### Filtering and actions
* Status and Priority - multi-select dropdowns populated from dataset values. Selecting multiple options applies an inclusive filter.
* Search - free-text field with highlighted matches in descriptions. Chip badges show the applied keywords.
* Reset filters - clears both the query and selected facets.
* Result counter - shows Найдено: N above the table.
* Export results (CSV) - downloads the current table view with columns ID;Автор;Описание;Создано;Статус;Приоритет (UTF-8 BOM, quoted cells). The author value is available in the export even though it is hidden in the table.

### Category management
Categories act as saved keyword bundles for frequent scenarios.
* Left sidebar lists categories. Clicking a category runs its search.
* Edit opens a modal that lets the operator change the name, keywords (one per line or separated by semicolons), and the score threshold.
* Delete removes a category instantly.
* Add category creates a blank entry.
* Import/Export buttons allow saving or loading the full category set as JSON.
* Category data is stored in localStorage.searchCategoriesV2.

## Tag Discovery
The tag extraction tab aggregates phrases per template (ticket title) across resolved incidents.

### Filters and parameters
* Template - multi-select built from unique Название values. When multiple templates are selected, results list each block separately.
* Status - multi-select pre-filled with Решено and Выполнено. Operators can adjust the list to analyze other states.
* Parameters - controls for minimum frequency (default 3), token length, n-gram sizes (1-3), and the number of top results (default 25).
* Actions - Найти теги, Сброс, Экспорт CSV, Экспорт JSON, and Копировать теги.

### Extraction pipeline
1. Collect descriptions for the chosen template/status combination.
2. Normalize text (lower case, letter yo mapped to e, strip punctuation/HTML, compress whitespace).
3. Remove stop phrases and stop tokens (editable via the shared settings interface).
4. Tokenize with Unicode letter/digit regex, filter by minimum length, and apply the synonym map.
5. Generate n-gram candidates (1-3 tokens), calculate:
   * Term frequency (TF).
   * Document frequency (DF).
   * TFIDF = DF * log(1 + M / (1 + DF)), where M is the number of descriptions.
   * Length boost: x1.0 for unigrams, x1.25 for bigrams, x1.45 for trigrams.
   * Domain boost: x1.15 when the phrase contains domain keywords (vpn, vrm, rdp, nla, сертификат, crypto pro, etc.).
6. Combine into SCORE = TFIDF * LENBOOST * DOMBOOST.
7. Apply overlap filtering: shorter phrases that appear mostly as parts of longer ones (>=70 percent overlap) are dropped.
8. Sort by score and take the top N rows.

### Operator tools
* The result header displays the template name and number of incidents contributing to the statistics.
* Tag chips show the phrase, score, and frequency. Operators can remove chips or add new ones manually; edits are saved in localStorage.tags_by_template_v1.
* The detailed table lists phrase, frequency, DF, TF-IDF, and score with sortable columns.
* Export CSV - outputs Template;Tag;Score;Frequency (UTF-8 BOM, quoted cells).
* Export JSON - outputs a dictionary { "Template": ["tag1","tag2", ...] } reflecting manual adjustments.

## Settings and storage summary
* Theme preference - localStorage.theme.
* Duplicate stop phrases - localStorage.dupStopPhrases.
* Duplicate smart threshold toggle and base values - localStorage.dupSettingsV2.
* Search categories - localStorage.searchCategoriesV2.
* Tag stop phrases and parameters - localStorage.tagSettingsV1.
* Manually curated tags per template - localStorage.tags_by_template_v1.

A Reset settings control in the portal clears all stored keys for a fresh start.

## Running tests
The repository contains tests/smoke.js, a Node-based smoke test that imports the shared parser, loads tickets_sample_100_same_author.csv, and verifies that duplicate clusters and template tags are produced. Run it with:

```
node tests/smoke.js
```

## Deployment
1. Ensure all files remain in the same directory hierarchy as shipped (css, js, js/vendor).
2. Distribute the folder to analysts or place it on a shared drive.
3. Open index.html via double-click or from the browser File > Open dialog.
4. Load a CSV export and continue working offline.

