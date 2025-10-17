(function () {
    const STORAGE_KEY = 'tags_by_template_v1';
    const DEFAULT_STATUS_PRESET = ['решено', 'выполнено'];
    const MAX_TABLE_ROWS = 200;

    let worker = null;
    let workerUrl = null;
    let pendingJob = null;
    let currentRecords = [];
    let currentResults = [];
    let templateSelect = null;
    let statusSelect = null;
    let tagResultsContainer = null;
    let settingsContainer = null;
    const TagEngine = buildTagEngine();

    const tagsState = {
        overrides: loadOverrides(),
        editable: new Map(),
        displayNames: new Map()
    };

    document.addEventListener('app:ready', () => {
        settingsContainer = document.getElementById('tags-settings');
        if (settingsContainer) {
            AppCore.mountSettings(
                settingsContainer,
                [
                    { key: 'stopPhrases', label: 'Стоп-фразы (по одной в строке)', type: 'textarea' },
                    { key: 'stopTokens', label: 'Стоп-слова (по одному в строке)', type: 'textarea' },
                    { key: 'domainTokens', label: 'Доменные термины (по одному в строке)', type: 'textarea' },
                    { key: 'lenBoost1', label: 'Бонус для униграмм', type: 'number', step: 0.05 },
                    { key: 'lenBoost2', label: 'Бонус для биграмм', type: 'number', step: 0.05 },
                    { key: 'lenBoost3', label: 'Бонус для триграмм', type: 'number', step: 0.05 },
                    { key: 'domainBoost', label: 'Бонус за доменный термин', type: 'number', step: 0.05 },
                    { key: 'coverageThreshold', label: 'Порог перекрытия (0-1)', type: 'number', step: 0.05, min: 0, max: 1 }
                ],
                'tags'
            );
        }
        tagResultsContainer = document.getElementById('tag-results');
        setupFilters();
        setupWorkerEvents();
    });

    document.addEventListener('app:data-updated', ({ detail }) => {
        currentRecords = detail.records || [];
        currentResults = [];
        tagsState.editable.clear();
        tagsState.displayNames.clear();
        populateFilters();
        renderEmptyState();
        setExportButtonsEnabled(false);
        resetRunButton();
    });

    document.getElementById('btn-run-tags').addEventListener('click', runTagExtraction);
    document.getElementById('btn-reset-tags').addEventListener('click', resetFilters);
    document.getElementById('btn-export-tags-csv').addEventListener('click', exportTagsCsv);
    document.getElementById('btn-export-tags-json').addEventListener('click', exportTagsJson);

    document.getElementById('tag-results').addEventListener('click', handleResultsClick);
    document.getElementById('tag-results').addEventListener('submit', (event) => event.preventDefault());
    document.getElementById('tag-results').addEventListener('keydown', handleResultsKeydown);

    function setupFilters() {
        templateSelect = createMultiSelect('tag-filter-template', 'Все шаблоны');
        statusSelect = createMultiSelect('tag-filter-status', 'Решено, Выполнено');
        document.getElementById('tag-min-frequency').value = '3';
        document.getElementById('tag-min-token').value = '2';
        document.getElementById('tag-top-n').value = '25';
    }

    function populateFilters() {
        if (!templateSelect || !statusSelect) return;
        const templateLabels = Array.from(new Set(currentRecords.map((rec) => (rec.title || '').trim()).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'ru'));
        const statusLabels = Array.from(new Set(currentRecords.map((rec) => (rec.status || '').trim()).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'ru'));
        templateSelect.setOptions(templateLabels);
        statusSelect.setOptions(statusLabels);
        applyDefaultStatuses(statusLabels);
    }

    function applyDefaultStatuses(statusLabels) {
        if (!statusSelect) return;
        const normalizedAvailable = new Set(statusLabels.map(normalizeKey));
        const defaults = DEFAULT_STATUS_PRESET.filter((value) => normalizedAvailable.has(normalizeKey(value)));
        if (defaults.length) {
            statusSelect.setSelected(defaults, true);
            updateHiddenValue('tag-filter-status', defaults.map(normalizeKey));
        } else {
            statusSelect.clear(true);
            updateHiddenValue('tag-filter-status', []);
        }
    }

    function runTagExtraction() {
        if (!currentRecords.length) {
            alert('Загрузите CSV с обращениями.');
            return;
        }
        const params = gatherParams();
        if (!params.ngramSizes.length) {
            alert('Выберите хотя бы один размер n-грамм.');
            return;
        }
        const settings = AppCore.getSettings().tags || {};
        const payload = {
            records: currentRecords.map((rec) => ({
                title: rec.title || '',
                status: rec.status || '',
                description: rec.description || ''
            })),
            templates: templateSelect ? templateSelect.getSelectedValues() : [],
            statuses: statusSelect ? statusSelect.getSelectedValues() : [],
            params: params,
            settings
        };
        pendingJob = payload;
        setRunButtonBusy(true);
        try {
            const instance = ensureWorker();
            if (!instance) throw new Error('Не удалось создать воркер тегов');
            instance.postMessage({ type: 'extract', payload });
        } catch (error) {
            console.error('Tag extraction worker failed', error);
            teardownWorker();
            runTagExtractionFallback();
        }
    }

    function gatherParams() {
        const minFrequency = Number(document.getElementById('tag-min-frequency').value) || 3;
        const minTokenLength = Number(document.getElementById('tag-min-token').value) || 2;
        const topN = Number(document.getElementById('tag-top-n').value) || 25;
        const ngramSizes = [];
        [1, 2, 3].forEach((size) => {
            const checkbox = document.getElementById('tag-ngram-' + size);
            if (checkbox && checkbox.checked) {
                ngramSizes.push(size);
            }
        });
        return {
            minFrequency,
            minTokenLength,
            topN,
            ngramSizes
        };
    }

    function runTagExtractionFallback() {
        if (!pendingJob) {
            setRunButtonBusy(false);
            return;
        }
        try {
            const result = TagEngine.extract(pendingJob);
            handleExtractionResult(result);
        } catch (error) {
            console.error('Tag extraction fallback failed', error);
            alert('Не удалось выполнить поиск тегов. Подробности в консоли.');
        } finally {
            setRunButtonBusy(false);
            pendingJob = null;
        }
    }

    function handleExtractionResult(result) {
        const templates = (result && Array.isArray(result.templates)) ? result.templates : [];
        currentResults = templates;
        tagsState.editable.clear();
        tagsState.displayNames.clear();
        templates.forEach((item) => {
            const normalized = normalizeKey(item.normalizedTemplate || item.template);
            tagsState.displayNames.set(normalized, item.template);
            const override = tagsState.overrides.map.get(normalized);
            let baseTags = item.tags || [];
            if (override && override.tags && override.tags.length) {
                baseTags = override.tags
                    .map((tag) => {
                        const match = (item.tags || []).find((candidate) => normalizeKey(candidate.phrase) === normalizeKey(tag));
                        return {
                            phrase: tag,
                            score: match ? match.score : null,
                            tf: match ? match.tf : 0,
                            source: match ? 'auto' : 'custom'
                        };
                    });
            } else {
                baseTags = baseTags.map((tag) => ({
                    phrase: tag.phrase,
                    score: tag.score,
                    tf: tag.tf,
                    source: 'auto'
                }));
            }
            tagsState.editable.set(normalized, deduplicateTags(baseTags));
        });
        renderTagResults();
        setExportButtonsEnabled(currentResults.length > 0);
        setRunButtonBusy(false);
    }

    function renderTagResults() {
        if (!tagResultsContainer) return;
        if (!currentResults.length) {
            renderEmptyState();
            return;
        }
        const fragment = document.createDocumentFragment();
        currentResults.forEach((item) => {
            const normalized = normalizeKey(item.normalizedTemplate || item.template);
            const editable = tagsState.editable.get(normalized) || [];
            const card = document.createElement('article');
            card.className = 'tag-card';
            card.dataset.templateKey = normalized;
            card.innerHTML = buildCardMarkup(item, editable);
            fragment.appendChild(card);
        });
        tagResultsContainer.innerHTML = '';
        tagResultsContainer.appendChild(fragment);
    }

    function buildCardMarkup(item, editableTags) {
        const normalized = normalizeKey(item.normalizedTemplate || item.template);
        const chipHtml = buildChipMarkup(editableTags, normalized);
        const tableRows = (item.phrases || []).slice(0, MAX_TABLE_ROWS).map(function (phrase) {
            let rowHtml = '';
            rowHtml += '<tr>';
            rowHtml += '<td>' + escapeHtml(phrase.phrase) + '</td>';
            rowHtml += '<td>' + formatInteger(phrase.tf) + '</td>';
            rowHtml += '<td>' + formatInteger(phrase.df) + '</td>';
            rowHtml += '<td>' + formatNumber(phrase.tfidf) + '</td>';
            rowHtml += '<td>' + formatNumber(phrase.score) + '</td>';
            rowHtml += '</tr>';
            return rowHtml;
        }).join('');
        let tableHtml;
        if (tableRows) {
            tableHtml = '';
            tableHtml += '<div class="tag-card__table">';
            tableHtml += '<table class="tag-table">';
            tableHtml += '<thead>';
            tableHtml += '<tr>';
            tableHtml += '<th>Фраза</th>';
            tableHtml += '<th>Частота</th>';
            tableHtml += '<th>DF</th>';
            tableHtml += '<th>TF-IDF</th>';
            tableHtml += '<th>Score</th>';
            tableHtml += '</tr>';
            tableHtml += '</thead>';
            tableHtml += '<tbody>' + tableRows + '</tbody>';
            tableHtml += '</table>';
            tableHtml += '</div>';
        } else {
            tableHtml = '<p class="tag-card__empty">Подходящих фраз не найдено.</p>';
        }
        const processedMeta = item.processedCount && item.processedCount !== item.documentCount
            ? ' - учтено: ' + formatInteger(item.processedCount)
            : '';
        let html = '';
        html += '<header class="tag-card__header">';
        html += '<div>';
        html += '<h3 class="tag-card__title">Шаблон: ' + escapeHtml(item.template) + '</h3>';
        html += '<div class="tag-card__meta">Обращений: ' + formatInteger(item.documentCount) + processedMeta + '</div>';
        html += '</div>';
        html += '<div class="tag-card__actions">';
        html += '<button class="button button--ghost" type="button" data-action="copy-tags" data-template="' + escapeAttribute(normalized) + '">📋 Копировать</button>';
        html += '<button class="button button--primary" type="button" data-action="save-tags" data-template="' + escapeAttribute(normalized) + '">💾 Сохранить</button>';
        html += '</div>';
        html += '</header>';
        html += '<div class="tag-chip-list" data-chip-list="' + escapeAttribute(normalized) + '">';
        html += chipHtml || '<span class="tag-card__empty">Нет тегов</span>';
        html += '</div>';
        html += '<div class="tag-card__add" data-add-container="' + escapeAttribute(normalized) + '">';
        html += '<input type="text" placeholder="Новый тег" data-tag-input="' + escapeAttribute(normalized) + '">';
        html += '<button class="button" type="button" data-action="add-tag" data-template="' + escapeAttribute(normalized) + '">➕ Добавить</button>';
        html += '</div>';
        html += tableHtml;
        return html;
    }

    function buildChipMarkup(editableTags, templateKey) {
        return editableTags.map(function (tag, index) {
            const scoreLabel = tag.score != null
                ? 'score ' + formatNumber(tag.score) + ' - freq ' + formatInteger(tag.tf)
                : 'ручной';
            const classes = ['tag-chip'];
            if (!tag.score && tag.source === 'custom') {
                classes.push('tag-chip--custom');
            }
            let chipHtml = '';
            chipHtml += '<span class="' + classes.join(' ') + '" data-chip-index="' + index + '" data-template="' + escapeAttribute(templateKey) + '">';
            chipHtml += '<span class="tag-chip__label">';
            chipHtml += '<span>' + escapeHtml(tag.phrase) + '</span>';
            chipHtml += '<span class="tag-chip__score">' + escapeHtml(scoreLabel) + '</span>';
            chipHtml += '</span>';
            chipHtml += '<span class="tag-chip__actions">';
            chipHtml += '<button class="tag-chip__action" type="button" data-action="edit-tag" aria-label="Редактировать тег">✏️</button>';
            chipHtml += '<button class="tag-chip__action" type="button" data-action="remove-tag" aria-label="Удалить тег">✕</button>';
            chipHtml += '</span>';
            chipHtml += '</span>';
            return chipHtml;
        }).join('');
    }

    function renderEmptyState() {
        if (!tagResultsContainer) return;
        tagResultsContainer.innerHTML = ''
            + '<div class="empty-state">'
            + '<p>Выберите шаблон и нажмите "Найти теги", чтобы увидеть результаты.</p>'
            + '</div>';
    }

    function handleResultsClick(event) {
        const action = event.target.dataset.action;
        if (!action) return;
        event.preventDefault();
        const templateKey = event.target.dataset.template;
        if (!templateKey) return;
        switch (action) {
            case 'add-tag':
                applyAddTag(templateKey);
                break;
            case 'remove-tag':
                applyRemoveTag(templateKey, event.target.closest('[data-chip-index]'));
                break;
            case 'edit-tag':
                applyEditTag(templateKey, event.target.closest('[data-chip-index]'));
                break;
            case 'save-tags':
                persistTemplateTags(templateKey);
                break;
            case 'copy-tags':
                copyTemplateTags(templateKey);
                break;
            default:
                break;
        }
    }

    function handleResultsKeydown(event) {
        if (event.key !== 'Enter') return;
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        const templateKey = input.dataset.tagInput;
        if (!templateKey) return;
        event.preventDefault();
        applyAddTag(templateKey);
    }

    function applyAddTag(templateKey) {
        const input = tagResultsContainer.querySelector('input[data-tag-input="' + cssEscape(templateKey) + '"]');
        if (!input) return;
        const value = input.value.trim();
        if (!value) return;
        const normalized = normalizeKey(templateKey);
        const list = tagsState.editable.get(normalized) || [];
        if (list.some((tag) => normalizeKey(tag.phrase) === normalizeKey(value))) {
            input.value = '';
            return;
        }
        list.push({ phrase: value, score: null, tf: 0, source: 'custom' });
        tagsState.editable.set(normalized, deduplicateTags(list));
        updateChipList(normalized);
        input.value = '';
    }

    function applyRemoveTag(templateKey, chipElement) {
        if (!chipElement) return;
        const index = Number(chipElement.dataset.chipIndex);
        if (!Number.isFinite(index)) return;
        const normalized = normalizeKey(templateKey);
        const list = tagsState.editable.get(normalized) || [];
        if (index < 0 || index >= list.length) return;
        list.splice(index, 1);
        tagsState.editable.set(normalized, list);
        updateChipList(normalized);
    }

    function applyEditTag(templateKey, chipElement) {
        if (!chipElement) return;
        const index = Number(chipElement.dataset.chipIndex);
        const normalized = normalizeKey(templateKey);
        const list = tagsState.editable.get(normalized) || [];
        if (!Number.isFinite(index) || index < 0 || index >= list.length) return;
        const current = list[index];
        const nextValue = prompt('Изменить тег', current.phrase);
        if (nextValue == null) return;
        const trimmed = nextValue.trim();
        if (!trimmed) return;
        if (trimmed === current.phrase) return;
        if (list.some((tag, idx) => idx !== index && normalizeKey(tag.phrase) === normalizeKey(trimmed))) {
            alert('Такой тег уже есть в списке.');
            return;
        }
        current.phrase = trimmed;
        current.score = null;
        current.tf = 0;
        current.source = 'custom';
        tagsState.editable.set(normalized, list);
        updateChipList(normalized);
    }

    function updateChipList(templateKey) {
        const list = tagsState.editable.get(templateKey) || [];
        const container = tagResultsContainer.querySelector('[data-chip-list="' + cssEscape(templateKey) + '"]');
        if (!container) return;
        const markup = buildChipMarkup(list, templateKey);
        container.innerHTML = markup || '<span class="tag-card__empty">Нет тегов</span>';
    }

    function persistTemplateTags(templateKey) {
        const normalized = normalizeKey(templateKey);
        const list = (tagsState.editable.get(normalized) || []).map((tag) => tag.phrase).filter(Boolean);
        const displayName = tagsState.displayNames.get(normalized) || '';
        if (!displayName) {
            alert('Не удалось определить название шаблона.');
            return;
        }
        if (!list.length) {
            delete tagsState.overrides.raw[displayName];
            tagsState.overrides.map.delete(normalized);
        } else {
            tagsState.overrides.raw[displayName] = list;
            tagsState.overrides.map.set(normalized, { name: displayName, tags: list });
        }
        saveOverrides();
        alert('Теги сохранены.');
    }

    function copyTemplateTags(templateKey) {
        const normalized = normalizeKey(templateKey);
        const list = tagsState.editable.get(normalized) || [];
        if (!list.length) {
            alert('Нет тегов для копирования.');
            return;
        }
        const text = list.map((tag) => tag.phrase).join(', ');
        copyToClipboard(text)
            .then(() => {
                alert('Теги скопированы в буфер обмена.');
            })
            .catch(() => {
                alert('Не удалось скопировать теги.');
            });
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise((resolve, reject) => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', 'true');
            textarea.style.position = 'absolute';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                const result = document.execCommand('copy');
                document.body.removeChild(textarea);
                if (result) resolve(); else reject();
            } catch (error) {
                document.body.removeChild(textarea);
                reject(error);
            }
        });
    }

    function deduplicateTags(tags) {
        const seen = new Set();
        const result = [];
        tags.forEach((tag) => {
            const key = normalizeKey(tag.phrase);
            if (!key || seen.has(key)) return;
            seen.add(key);
            result.push({
                phrase: tag.phrase,
                score: tag.score,
                tf: tag.tf,
                source: tag.source || (tag.score == null ? 'custom' : 'auto')
            });
        });
        return result;
    }

    function resetFilters() {
        if (templateSelect && typeof templateSelect.clear === 'function') {
            templateSelect.clear(true);
        }
        if (statusSelect && typeof statusSelect.clear === 'function') {
            statusSelect.clear(true);
        }
        document.getElementById('tag-min-frequency').value = '3';
        document.getElementById('tag-min-token').value = '2';
        document.getElementById('tag-top-n').value = '25';
        document.getElementById('tag-ngram-1').checked = true;
        document.getElementById('tag-ngram-2').checked = true;
        document.getElementById('tag-ngram-3').checked = true;
        populateFilters();
        renderEmptyState();
        currentResults = [];
        tagsState.editable.clear();
        setExportButtonsEnabled(false);
    }

    function exportTagsCsv() {
        if (!currentResults.length) {
            alert('Нет данных для экспорта.');
            return;
        }
        const rows = [['Шаблон', 'Тег', 'Score', 'Частота']];
        currentResults.forEach((result) => {
            const normalized = normalizeKey(result.normalizedTemplate || result.template);
            const tags = tagsState.editable.get(normalized) || [];
            tags.forEach((tag) => {
                rows.push([
                    result.template,
                    tag.phrase,
                    tag.score != null ? formatNumber(tag.score) : '',
                    tag.tf ? String(tag.tf) : ''
                ]);
            });
        });
        const csv = rows.map((row) => row.map(escapeCsvCell).join(';')).join('\r\n');
        const bytes = encodeWindows1251(csv);
        downloadBlob(new Blob([bytes], { type: 'text/csv' }), 'tags.csv');
    }

    function exportTagsJson() {
        if (!currentResults.length) {
            alert('Нет данных для экспорта.');
            return;
        }
        const payload = {};
        currentResults.forEach((result) => {
            const normalized = normalizeKey(result.normalizedTemplate || result.template);
            const tags = tagsState.editable.get(normalized) || [];
            payload[result.template] = tags.map((tag) => tag.phrase);
        });
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        downloadBlob(blob, 'tags.json');
    }

    function setExportButtonsEnabled(enabled) {
        document.getElementById('btn-export-tags-csv').disabled = !enabled;
        document.getElementById('btn-export-tags-json').disabled = !enabled;
    }

    function downloadBlob(blob, filename) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

    function setRunButtonBusy(isBusy) {
        const button = document.getElementById('btn-run-tags');
        if (!button) return;
        if (isBusy) {
            button.textContent = '⏳ Обработка...';
            button.disabled = true;
        } else {
            button.textContent = '🔖 Найти теги';
            button.disabled = !currentRecords.length;
        }
    }

    function resetRunButton() {
        setRunButtonBusy(false);
    }

    function setupWorkerEvents() {
        window.addEventListener('beforeunload', teardownWorker);
    }

    function ensureWorker() {
        if (worker) return worker;
        const created = createWorker();
        if (!created) return null;
        worker = created.worker;
        workerUrl = created.url;
        worker.onmessage = handleWorkerMessage;
        worker.onerror = handleWorkerError;
        return worker;
    }

    function createWorker() {
        try {
            const script = getWorkerScript();
            const blob = new Blob([script], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const workerInstance = new Worker(url);
            return { worker: workerInstance, url };
        } catch (error) {
            console.error('Failed to create tag worker', error);
            return null;
        }
    }

    function teardownWorker() {
        if (worker) {
            worker.terminate();
            worker = null;
        }
        if (workerUrl) {
            URL.revokeObjectURL(workerUrl);
            workerUrl = null;
        }
    }

    function handleWorkerMessage(event) {
        const data = event.data || {};
        if (data.type === 'extraction-complete') {
            handleExtractionResult(data.payload || {});
            pendingJob = null;
        } else if (data.type === 'extraction-error') {
            const payloadError = data.payload && data.payload.error ? data.payload.error : data.payload;
            console.error('Tag worker error', payloadError);
            teardownWorker();
            runTagExtractionFallback();
        }
    }

    function handleWorkerError(error) {
        console.error('Worker runtime error', error);
        teardownWorker();
        runTagExtractionFallback();
    }

    function getWorkerScript() {
        const factory = (typeof window !== 'undefined' && typeof window.TagEngineFactory === 'function')
            ? window.TagEngineFactory
            : null;
        if (!factory) {
            throw new Error('TagEngineFactory недоступен');
        }
        const factorySource = '(' + factory.toString() + ')';
        const lines = [];
        lines.push('const engineFactory = ' + factorySource + ';');
        lines.push('const engine = engineFactory();');
        lines.push('self.onmessage = function (event) {');
        lines.push('    const data = event.data || {};');
        lines.push('    if (data.type === "extract") {');
        lines.push('        const payload = data.payload || {};');
        lines.push('        try {');
        lines.push('            const result = engine.extract(payload);');
        lines.push('            self.postMessage({ type: "extraction-complete", payload: result });');
        lines.push('        } catch (error) {');
        lines.push('            self.postMessage({ type: "extraction-error", payload: { error: engine.serializeError(error) } });');
        lines.push('        }');
        lines.push('    }');
        lines.push('};');
        return lines.join('\n');
    }

    function buildTagEngine() {
        const factory = (typeof window !== 'undefined' && typeof window.TagEngineFactory === 'function')
            ? window.TagEngineFactory
            : null;
        if (!factory) {
            console.error('TagEngineFactory не найден');
            return {
                extract: () => ({ templates: [] }),
                serializeError: (err) => ({ message: String(err || 'Unknown error') })
            };
        }
        try {
            return factory();
        } catch (error) {
            console.error('Не удалось инициализировать резервный движок тегов', error);
            return {
                extract: () => ({ templates: [] }),
                serializeError: (err) => ({ message: String(err || 'Unknown error') })
            };
        }
    }

    function loadOverrides() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return { raw: {}, map: new Map() };
            }
            const parsed = JSON.parse(raw);
            const map = new Map();
            Object.keys(parsed || {}).forEach((key) => {
                const list = Array.isArray(parsed[key]) ? parsed[key].map((tag) => String(tag)).filter(Boolean) : [];
                const normalized = normalizeKey(key);
                if (!normalized) return;
                map.set(normalized, { name: key, tags: list });
            });
            return { raw: parsed || {}, map };
        } catch (error) {
            console.warn('Не удалось загрузить сохранённые теги', error);
            return { raw: {}, map: new Map() };
        }
    }

    function saveOverrides() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(tagsState.overrides.raw, null, 2));
        } catch (error) {
            console.warn('Не удалось сохранить теги', error);
        }
    }

    function createMultiSelect(id, placeholder) {
        const root = document.querySelector('[data-multi="' + id + '"]');
        const hiddenInput = document.getElementById(id);
        if (!root || !hiddenInput) {
            return {
                setOptions() {},
                getSelectedValues() { return []; },
                setSelected() {},
                clear() {},
                close() {}
            };
        }
        const trigger = root.querySelector('.multi-select__trigger');
        const labelNode = root.querySelector('.multi-select__label');
        const dropdown = root.querySelector('.multi-select__dropdown');
        const state = {
            options: [],
            selected: new Map()
        };
        function updateLabel() {
            if (!labelNode) return;
            if (!state.selected.size) {
                labelNode.textContent = placeholder;
                return;
            }
            const labels = Array.from(state.selected.values());
            labelNode.textContent = labels.length <= 2 ? labels.join(', ') : 'Выбрано: ' + labels.length;
        }
        function syncHidden() {
            hiddenInput.value = Array.from(state.selected.keys()).join(',');
        }
        function close() {
            root.classList.remove('multi-select--open');
            dropdown.hidden = true;
            if (trigger) {
                trigger.setAttribute('aria-expanded', 'false');
            }
            if (openMultiSelectInstance === api) {
                openMultiSelectInstance = null;
                openMultiSelectRoot = null;
            }
        }
        function open() {
            if (!state.options.length) return;
            if (openMultiSelectInstance && openMultiSelectInstance !== api && typeof openMultiSelectInstance.close === 'function') {
                openMultiSelectInstance.close();
            }
            root.classList.add('multi-select--open');
            dropdown.hidden = false;
            if (trigger) {
                trigger.setAttribute('aria-expanded', 'true');
            }
            openMultiSelectInstance = api;
            openMultiSelectRoot = root;
        }
        function toggle() {
            if (root.classList.contains('multi-select--open')) {
                close();
            } else {
                open();
            }
        }
        function clear(silent = false) {
            const hadSelection = state.selected.size > 0;
            state.selected.clear();
            dropdown.querySelectorAll('input[type="checkbox"]').forEach((input) => {
                input.checked = false;
            });
            syncHidden();
            updateLabel();
            if (!silent && hadSelection && typeof onChange === 'function') {
                onChange();
            }
        }
        function applyOptions(options) {
            state.options = options
                .map((label) => {
                    const raw = label == null ? '' : String(label);
                    const clean = raw.trim();
                    return clean
                        ? { label: clean, normalized: normalizeKey(clean) }
                        : null;
                })
                .filter(Boolean);
            dropdown.innerHTML = '';
            state.selected.clear();
            syncHidden();
            updateLabel();
            if (!state.options.length) {
                close();
                return;
            }
            const list = document.createElement('ul');
            list.className = 'multi-select__list';
            state.options.forEach((option, index) => {
                const item = document.createElement('li');
                item.className = 'multi-select__item';
                const checkboxId = id + '-' + index;
                let itemHtml = '';
                itemHtml += '<label for="' + escapeAttribute(checkboxId) + '">';
                itemHtml += '<input type="checkbox" id="' + escapeAttribute(checkboxId) + '" value="' + escapeAttribute(option.normalized) + '">';
                itemHtml += '<span>' + escapeHtml(option.label) + '</span>';
                itemHtml += '</label>';
                item.innerHTML = itemHtml;
                list.appendChild(item);
            });
            dropdown.appendChild(list);
            close();
        }
        function setSelected(values, silent = false) {
            const desired = new Set((values || []).map(normalizeKey).filter(Boolean));
            state.selected.clear();
            dropdown.querySelectorAll('input[type="checkbox"]').forEach((input) => {
                const isSelected = desired.has(input.value);
                input.checked = isSelected;
                if (isSelected) {
                    const option = state.options.find((opt) => opt.normalized === input.value);
                    if (option) {
                        state.selected.set(option.normalized, option.label);
                    }
                }
            });
            syncHidden();
            updateLabel();
        }
        dropdown.addEventListener('change', (event) => {
            const input = event.target;
            if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
            const value = input.value;
            const option = state.options.find((opt) => opt.normalized === value);
            if (!option) return;
            if (input.checked) {
                state.selected.set(value, option.label);
            } else {
                state.selected.delete(value);
            }
            syncHidden();
            updateLabel();
        });
        dropdown.addEventListener('click', (event) => event.stopPropagation());
        if (trigger) {
            trigger.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggle();
            });
            trigger.addEventListener('keydown', (event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    toggle();
                } else if (event.key === 'Escape') {
                    close();
                }
            });
        }
        updateLabel();
        const api = {
            setOptions: applyOptions,
            getSelectedValues() {
                return Array.from(state.selected.keys());
            },
            setSelected,
            clear,
            close
        };
        registerGlobalListeners();
        return api;
    }

    let openMultiSelectInstance = null;
    let openMultiSelectRoot = null;
    let listenersRegistered = false;

    function registerGlobalListeners() {
        if (listenersRegistered) return;
        document.addEventListener('click', (event) => {
            if (!openMultiSelectRoot) return;
            if (openMultiSelectRoot.contains(event.target)) return;
            if (openMultiSelectInstance && typeof openMultiSelectInstance.close === 'function') {
                openMultiSelectInstance.close();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                if (openMultiSelectInstance && typeof openMultiSelectInstance.close === 'function') {
                    openMultiSelectInstance.close();
                }
            }
        });
        listenersRegistered = true;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttribute(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/'/g, '&#39;');
    }

    function cssEscape(value) {
        return value.replace(/"/g, '\\"');
    }

    function escapeCsvCell(value) {
        const text = String(value == null ? '' : value);
        if (/[";\n]/.test(text)) {
            return '"' + text.replace(/"/g, '""') + '"';
        }
        return text;
    }

    function formatNumber(value) {
        if (!Number.isFinite(value)) return '';
        return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatInteger(value) {
        if (!Number.isFinite(value)) return '0';
        return Math.round(value).toLocaleString('ru-RU');
    }

    function normalizeKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/ё/g, 'е');
    }

    function updateHiddenValue(id, values) {
        const input = document.getElementById(id);
        if (!input) return;
        input.value = values.join(',');
    }

    function encodeWindows1251(text) {
        const extraMap = new Map([
            [0x0402, 0x80], [0x0403, 0x81], [0x201A, 0x82], [0x0453, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
            [0x20AC, 0x88], [0x2030, 0x89], [0x0409, 0x8A], [0x2039, 0x8B], [0x040A, 0x8C], [0x040C, 0x8D], [0x040B, 0x8E], [0x040F, 0x8F],
            [0x0452, 0x90], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
            [0x2122, 0x99], [0x0459, 0x9A], [0x203A, 0x9B], [0x045A, 0x9C], [0x045C, 0x9D], [0x045B, 0x9E], [0x045F, 0x9F],
            [0x00A0, 0xA0], [0x040E, 0xA1], [0x045E, 0xA2], [0x0408, 0xA3], [0x00A4, 0xA4], [0x0490, 0xA5], [0x00A6, 0xA6], [0x00A7, 0xA7],
            [0x0401, 0xA8], [0x00A9, 0xA9], [0x0404, 0xAA], [0x00AB, 0xAB], [0x00AC, 0xAC], [0x00AD, 0xAD], [0x00AE, 0xAE], [0x0407, 0xAF],
            [0x00B0, 0xB0], [0x00B1, 0xB1], [0x0406, 0xB2], [0x0456, 0xB3], [0x0491, 0xB4], [0x00B5, 0xB5], [0x00B6, 0xB6], [0x00B7, 0xB7],
            [0x0451, 0xB8], [0x2116, 0xB9], [0x0454, 0xBA], [0x00BB, 0xBB], [0x0458, 0xBC], [0x0405, 0xBD], [0x0455, 0xBE], [0x0457, 0xBF]
        ]);
        const buffer = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i += 1) {
            const code = text.charCodeAt(i);
            if (code <= 0x7F) {
                buffer[i] = code;
            } else if (code >= 0x0410 && code <= 0x044F) {
                buffer[i] = code - 0x0410 + 0xC0;
            } else if (code === 0x0401) {
                buffer[i] = 0xA8;
            } else if (code === 0x0451) {
                buffer[i] = 0xB8;
            } else if (extraMap.has(code)) {
                buffer[i] = extraMap.get(code);
            } else {
                buffer[i] = 0x3F;
            }
        }
        return buffer;
    }
})();
