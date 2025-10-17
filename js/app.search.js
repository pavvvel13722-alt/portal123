(function () {
    const chunkSize = 150;
    const elements = {
        runSearch: document.getElementById('btn-run-search'),
        exportSearch: document.getElementById('btn-export-search'),
        resetFilters: document.getElementById('btn-reset-filters'),
        query: document.getElementById('search-query'),
        keywords: document.getElementById('search-keywords'),
        resultContainer: document.getElementById('search-results'),
        resultCount: document.getElementById('search-result-count'),
        filterStatus: document.getElementById('filter-status'),
        filterPriority: document.getElementById('filter-priority'),
        categoryList: document.getElementById('category-list'),
        addCategory: document.getElementById('btn-add-category'),
        importCategories: document.getElementById('btn-import-categories'),
        exportCategories: document.getElementById('btn-export-categories'),
        categoryImportInput: document.getElementById('category-import-input'),
        modal: document.getElementById('category-modal'),
        modalForm: document.getElementById('category-form'),
        modalTitle: document.getElementById('category-modal-title'),
        modalName: document.getElementById('category-name'),
        modalKeywords: document.getElementById('category-keywords'),
        modalThreshold: document.getElementById('category-threshold')
    };

    const multiSelects = {};
    let openMultiSelectInstance = null;
    let openMultiSelectRoot = null;

    let records = [];
    let processedRecords = [];
    let recordMap = new Map();
    let index = null;
    let activeCategoryId = null;
    let currentResults = [];
    let renderedCount = 0;
    let scrollHost = null;
    let modalState = { id: null };

    document.addEventListener('app:ready', () => {
        initMultiSelects();
        renderCategories();
        setupEvents();
        updateKeywordChips();
        updateResultCounter(0);
    });

    document.addEventListener('app:data-updated', ({ detail }) => {
        records = detail.records;
        processedRecords = preprocessRecords(records);
        recordMap = new Map(processedRecords.map((item) => [item.__id, item]));
        rebuildIndex(processedRecords);
        populateFilterOptions(records);
        resetSearchState();
    });

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (openMultiSelectInstance && openMultiSelectRoot && target instanceof Node && !openMultiSelectRoot.contains(target)) {
            openMultiSelectInstance.close();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && openMultiSelectInstance) {
            openMultiSelectInstance.close();
        }
    });

    function setupEvents() {
        elements.runSearch.addEventListener('click', runSearch);
        elements.exportSearch.addEventListener('click', exportCurrentResults);
        elements.resetFilters.addEventListener('click', () => {
            if (multiSelects.status) {
                multiSelects.status.clear(true);
                multiSelects.status.close();
            }
            if (multiSelects.priority) {
                multiSelects.priority.clear(true);
                multiSelects.priority.close();
            }
            runSearch();
        });
        elements.query.addEventListener('input', () => {
            updateKeywordChips();
        });

        elements.addCategory.addEventListener('click', () => {
            openCategoryModal();
        });

        elements.exportCategories.addEventListener('click', exportCategories);
        elements.importCategories.addEventListener('click', () => {
            elements.categoryImportInput.value = '';
            elements.categoryImportInput.click();
        });
        elements.categoryImportInput.addEventListener('change', importCategories);

        elements.categoryList.addEventListener('click', (event) => {
            const item = event.target.closest('.category-item');
            if (!item) return;
            const id = item.dataset.id;
            const action = event.target.dataset.action;
            const settings = AppCore.getSettings();
            const categories = [...settings.search.categories];
            const index = categories.findIndex((cat) => cat.id === id);
            if (index === -1) return;
            if (action === 'edit') {
                openCategoryModal(categories[index]);
                return;
            }
            if (action === 'delete') {
                if (!confirm('Удалить категорию?')) return;
                categories.splice(index, 1);
                AppCore.replaceGroup('search', { ...settings.search, categories });
                renderCategories(categories);
                if (activeCategoryId === id) {
                    activeCategoryId = null;
                    updateKeywordChips();
                    runSearch();
                }
                return;
            }
            if (!action) {
                setActiveCategory(id);
            }
        });

        elements.modal.addEventListener('click', (event) => {
            if (event.target.dataset.modalClose !== undefined) {
                closeCategoryModal();
            }
        });

        elements.modalForm.addEventListener('submit', (event) => {
            event.preventDefault();
            saveCategoryFromModal();
        });
    }

    function resetSearchState() {
        currentResults = [];
        renderedCount = 0;
        updateResultCounter(0);
        elements.resultContainer.innerHTML = '<div class="empty-state">Введите запрос или выберите категорию для поиска.</div>';
        elements.exportSearch.disabled = true;
    }

    function preprocessRecords(list) {
        return list.map((record, idx) => {
            const authorText = (record.author || '').toLowerCase();
            const descriptionText = (record.description || '').toLowerCase();
            const tokens = tokenize(authorText + ' ' + descriptionText);
            const statusValue = (record.status || '').toLowerCase();
            const priorityValue = (record.priority || '').toLowerCase();
            return {
                ...record,
                __id: String(idx),
                authorText,
                descriptionText,
                statusValue,
                priorityValue,
                tokens,
                tokenSet: new Set(tokens)
            };
        });
    }

    function rebuildIndex(list) {
        if (!window.FlexSearch) return;
        index = new FlexSearch.Document({
            cache: 100,
            tokenize: 'forward',
            document: {
                id: '__id',
                index: [
                    { field: 'author', tokenize: 'forward', resolution: 9, weight: 2 },
                    { field: 'description', tokenize: 'forward', resolution: 9, weight: 4 }
                ]
            }
        });
        list.forEach((record) => {
            index.add({
                __id: record.__id,
                author: record.author || '',
                description: record.description || ''
            });
        });
    }

    function runSearch() {
        if (!processedRecords.length) return;
        const queryInput = elements.query.value.trim();
        const category = AppCore.getSettings().search.categories.find((cat) => cat.id === activeCategoryId);
        const tokens = extractTokens(queryInput);
        const categoryKeywords = category ? category.keywords : [];
        const allKeywords = new Set([...tokens.all, ...categoryKeywords.map((kw) => kw.toLowerCase())]);
        updateKeywordChips();
        if (!allKeywords.size) {
            resetSearchState();
            return;
        }

        const candidateIds = gatherCandidates(allKeywords);
        const filters = collectFilters();
        const results = [];
        const highlightTerms = Array.from(new Set([...tokens.all, ...categoryKeywords.map((kw) => kw.toLowerCase())]));

        candidateIds.forEach((id) => {
            const record = recordMap.get(id);
            if (!record) return;
            if (!passesFilters(record, filters)) return;
            const score = computeScore(record, tokens, category);
            if (!score) return;
            if (category && score < category.threshold) return;
            results.push({
                ...record,
                score,
                descriptionHighlighted: highlightText(record.description || '', highlightTerms)
            });
        });

        results.sort((a, b) => b.score - a.score || compareDatesDesc(a.createdAt, b.createdAt));
        currentResults = results;
        renderedCount = 0;
        updateResultCounter(currentResults.length);
        renderSearchResults();
    }

    function gatherCandidates(keywords) {
        if (!index) return processedRecords.map((rec) => rec.__id);
        const set = new Set();
        keywords.forEach((keyword) => {
            if (!keyword) return;
            const results = index.search(keyword, { enrich: true, limit: 1000 });
            results.forEach((result) => {
                result.result.forEach((id) => set.add(String(id)));
            });
        });
        if (!set.size) {
            processedRecords.forEach((rec) => set.add(rec.__id));
        }
        return set;
    }

    function collectFilters() {
        return {
            status: multiSelects.status ? multiSelects.status.getSelectedValues() : [],
            priority: multiSelects.priority ? multiSelects.priority.getSelectedValues() : []
        };
    }

    function passesFilters(record, filters) {
        if (filters.status.length && !filters.status.includes(record.statusValue)) return false;
        if (filters.priority.length && !filters.priority.includes(record.priorityValue)) return false;
        return true;
    }

    function computeScore(record, tokens, category) {
        let score = 0;
        const descriptionText = record.descriptionText;
        const authorText = record.authorText;

        tokens.phrases.forEach((phrase) => {
            if (!phrase) return;
            if (descriptionText.includes(phrase) || authorText.includes(phrase)) {
                score += 5;
            }
        });

        const wordCandidates = new Set(tokens.words);
        if (category) {
            category.keywords.forEach((keyword) => {
                const normalized = keyword.toLowerCase();
                if (!normalized) return;
                if (normalized.split(/\s+/).length > 1) {
                    if (descriptionText.includes(normalized) || authorText.includes(normalized)) {
                        score += 5;
                    }
                } else {
                    wordCandidates.add(normalized);
                }
            });
        }

        wordCandidates.forEach((word) => {
            if (!word) return;
            if (record.tokenSet.has(word)) {
                score += 2;
            } else {
                const similar = record.tokens.some((token) => levenshtein(token, word) <= 1);
                if (similar) {
                    score += 1;
                }
            }
        });

        return Math.round(score * 100) / 100;
    }

    function renderSearchResults() {
        if (scrollHost) {
            scrollHost.removeEventListener('scroll', onScrollAppend);
            scrollHost = null;
        }

        if (!currentResults.length) {
            elements.resultContainer.innerHTML = '<div class="empty-state">Совпадения не найдены. Попробуйте изменить ключевые слова или порог.</div>';
            elements.exportSearch.disabled = true;
            return;
        }

        elements.exportSearch.disabled = false;
        var tableHtml = '';
        tableHtml += '<div class="table-scroll">';
        tableHtml += '<table class="table">';
        tableHtml += '<thead>';
        tableHtml += '<tr>';
        tableHtml += '<th>ID</th>';
        tableHtml += '<th>Описание</th>';
        tableHtml += '<th>Создано</th>';
        tableHtml += '<th>Статус</th>';
        tableHtml += '<th>Приоритет</th>';
        tableHtml += '</tr>';
        tableHtml += '</thead>';
        tableHtml += '<tbody></tbody>';
        tableHtml += '</table>';
        tableHtml += '</div>';
        elements.resultContainer.innerHTML = tableHtml;
        scrollHost = elements.resultContainer.querySelector('.table-scroll');
        appendRows();
        if (scrollHost) {
            scrollHost.addEventListener('scroll', onScrollAppend);
        }
    }

    function appendRows() {
        const tbody = elements.resultContainer.querySelector('tbody');
        if (!tbody) return;
        const fragment = document.createDocumentFragment();
        const slice = currentResults.slice(renderedCount, renderedCount + chunkSize);
        if (!slice.length) return;
        slice.forEach((row) => {
            const tr = document.createElement('tr');
            const descriptionFull = escapeAttribute(row.description || '');
            const rowId = row.id || '';
            const linkUrl = 'https://sfera.vtb.ru/sd/support?open=' + encodeURIComponent(rowId);
            const highlightedDescription = row.descriptionHighlighted || escapeHtml(row.description || '');
            let rowHtml = '';
            rowHtml += '<td><a href="' + linkUrl + '" target="_blank" rel="noopener">' + escapeHtml(rowId) + '</a></td>';
            rowHtml += '<td><span class="description-cell" title="' + descriptionFull + '">' + highlightedDescription + '</span></td>';
            rowHtml += '<td>' + escapeHtml(row.createdAt || '') + '</td>';
            rowHtml += '<td>' + escapeHtml(row.status || '') + '</td>';
            rowHtml += '<td>' + escapeHtml(row.priority || '') + '</td>';
            tr.innerHTML = rowHtml;
            fragment.appendChild(tr);
        });
        tbody.appendChild(fragment);
        renderedCount += slice.length;
    }

    function onScrollAppend(event) {
        const el = event.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
            appendRows();
        }
    }

    function exportCurrentResults() {
        if (!currentResults.length) return;
        const rows = [['ID', 'Описание', 'Создано', 'Статус', 'Приоритет']];
        currentResults.forEach((row) => {
            rows.push([
                row.id,
                row.description,
                row.createdAt,
                row.status,
                row.priority
            ]);
        });
        const csv = rows
            .map(function (line) {
                return line
                    .map(function (cell) {
                        const value = String(cell == null ? '' : cell).replace(/"/g, '""');
                        return '"' + value + '"';
                    })
                    .join(';');
            })
            .join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'search-results.csv';
        link.click();
        URL.revokeObjectURL(link.href);
    }

    function extractTokens(query) {
        if (!query) {
            return { all: [], phrases: [], words: [] };
        }
        const phrases = [];
        const phraseMatches = query.match(/"([^"]+)"/g) || [];
        phraseMatches.forEach((match) => {
            const content = match.replace(/"/g, '').trim().toLowerCase();
            if (content) phrases.push(content);
        });
        const cleaned = query.replace(/"([^"]+)"/g, ' ').trim();
        const parts = cleaned.split(/[,;\s]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
        const multiWord = parts.filter((part) => part.split(/\s+/).length > 1);
        multiWord.forEach((phrase) => phrases.push(phrase));
        const singles = parts.filter((part) => part.split(/\s+/).length === 1);
        return {
            all: [...phrases, ...singles],
            phrases,
            words: singles
        };
    }

    function tokenize(text) {
        return text.split(/[^a-zа-я0-9ё]+/i).filter(Boolean);
    }

    function highlightText(text, keywords) {
        if (!text) return '';
        let highlighted = escapeHtml(text);
        keywords.forEach((keyword) => {
            if (!keyword) return;
            const escaped = keyword.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
            highlighted = highlighted.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark class="highlight">$1</mark>');
        });
        return highlighted;
    }

    function levenshtein(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b[i - 1] === a[j - 1]) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j - 1] + 1
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    function renderCategories(categories = AppCore.getSettings().search.categories) {
        const container = elements.categoryList;
        if (!categories.length) {
            container.innerHTML = '<li class="empty-state">Добавьте категории для быстрого поиска.</li>';
            return;
        }
        const fragment = document.createDocumentFragment();
        categories.forEach((category) => {
            const li = document.createElement('li');
            li.className = 'category-item';
            if (category.id === activeCategoryId) li.classList.add('category-item--active');
            li.dataset.id = category.id;
            const header = document.createElement('div');
            header.className = 'category-item__header';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'category-item__name';
            nameSpan.textContent = category.name;
            header.appendChild(nameSpan);
            const actions = document.createElement('div');
            actions.className = 'category-item__actions';
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'Порог >= ' + String(category.threshold);
            actions.appendChild(badge);
            const editBtn = document.createElement('button');
            editBtn.className = 'button button--ghost';
            editBtn.dataset.action = 'edit';
            editBtn.type = 'button';
            editBtn.title = 'Редактировать';
            editBtn.textContent = 'Ред.';
            actions.appendChild(editBtn);
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'button button--ghost';
            deleteBtn.dataset.action = 'delete';
            deleteBtn.type = 'button';
            deleteBtn.title = 'Удалить';
            deleteBtn.textContent = 'Удал.';
            actions.appendChild(deleteBtn);
            header.appendChild(actions);
            li.appendChild(header);
            const keywordsWrap = document.createElement('div');
            keywordsWrap.className = 'category-item__keywords';
            const chipsHtml = category.keywords
                .map(function (keyword) { return '<span class="chip">' + escapeHtml(keyword) + '</span>'; })
                .join('');
            keywordsWrap.innerHTML = chipsHtml;
            li.appendChild(keywordsWrap);
            fragment.appendChild(li);
        });
        container.innerHTML = '';
        container.appendChild(fragment);
    }

    function setActiveCategory(id) {
        activeCategoryId = id === activeCategoryId ? null : id;
        renderCategories();
        updateKeywordChips();
        runSearch();
    }

    function updateKeywordChips() {
        const chipContainer = elements.keywords;
        const query = elements.query.value;
        const queryTokens = extractTokens(query);
        const category = AppCore.getSettings().search.categories.find((cat) => cat.id === activeCategoryId);
        const chips = [];
        queryTokens.all.forEach((token) => chips.push(token));
        if (category) {
            category.keywords.forEach((keyword) => chips.push(keyword));
        }
        if (!chips.length) {
            chipContainer.innerHTML = '<span class="chip">Нет ключевых слов</span>';
            return;
        }
        const chipsHtml = chips
            .map(function (chip) { return '<span class="chip">' + escapeHtml(chip) + '</span>'; })
            .join('');
        chipContainer.innerHTML = chipsHtml;
    }

    function updateResultCounter(count) {
        if (!elements.resultCount) return;
        elements.resultCount.textContent = 'Найдено: ' + count;
    }

    function populateFilterOptions(list) {
        const statuses = new Set();
        const priorities = new Set();
        list.forEach((record) => {
            if (record.status) statuses.add(record.status);
            if (record.priority) priorities.add(record.priority);
        });
        const sortedStatuses = Array.from(statuses).sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }));
        const sortedPriorities = Array.from(priorities).sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }));
        if (multiSelects.status) multiSelects.status.setOptions(sortedStatuses);
        if (multiSelects.priority) multiSelects.priority.setOptions(sortedPriorities);
    }

    function openCategoryModal(category) {
        const isEdit = Boolean(category);
        modalState = { id: category && category.id ? category.id : null };
        elements.modalTitle.textContent = isEdit ? 'Редактирование категории' : 'Новая категория';
        elements.modalName.value = category && category.name ? category.name : '';
        elements.modalKeywords.value = category && Array.isArray(category.keywords) ? category.keywords.join('\n') : '';
        elements.modalThreshold.value = category && category.threshold != null ? category.threshold : 5;
        elements.modal.setAttribute('aria-hidden', 'false');
    }

    function closeCategoryModal() {
        elements.modal.setAttribute('aria-hidden', 'true');
        modalState = { id: null };
    }

    function saveCategoryFromModal() {
        const name = elements.modalName.value.trim();
        const keywordsInput = elements.modalKeywords.value;
        const thresholdValue = Number(elements.modalThreshold.value);
        if (!name) {
            alert('Введите название категории');
            return;
        }
        const keywords = keywordsInput
            .split(/[;\n]+/)
            .map((keyword) => keyword.trim())
            .filter(Boolean);
        if (!keywords.length) {
            alert('Добавьте хотя бы одно ключевое слово');
            return;
        }
        const threshold = Number.isFinite(thresholdValue) ? thresholdValue : 0;
        const settings = AppCore.getSettings();
        const categories = [...settings.search.categories];
        if (modalState.id) {
            const index = categories.findIndex((cat) => cat.id === modalState.id);
            if (index !== -1) {
                categories[index] = { ...categories[index], name, keywords, threshold };
            }
        } else {
            categories.push({
                id: generateCategoryId(),
                name,
                keywords,
                threshold
            });
        }
        AppCore.replaceGroup('search', { ...settings.search, categories });
        renderCategories(categories);
        if (modalState.id === activeCategoryId) {
            updateKeywordChips();
            runSearch();
        }
        closeCategoryModal();
    }

    function generateCategoryId() {
        return 'cat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    }

    function importCategories(event) {
        const target = event.target || event.currentTarget;
        const files = target && target.files ? target.files : null;
        const file = files && files.length ? files[0] : null;
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                if (!Array.isArray(parsed)) throw new Error('Некорректный формат');
                const normalized = parsed
                    .map((item) => normalizeCategory(item))
                    .filter(Boolean);
                if (!normalized.length) throw new Error('Нет валидных категорий');
                const settings = AppCore.getSettings();
                AppCore.replaceGroup('search', { ...settings.search, categories: normalized });
                activeCategoryId = null;
                renderCategories(normalized);
                updateKeywordChips();
                runSearch();
            } catch (err) {
                console.error(err);
                alert('Не удалось импортировать категории. Проверьте файл.');
            }
        };
        reader.readAsText(file, 'utf-8');
    }

    function normalizeCategory(item) {
        if (!item || typeof item !== 'object') return null;
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        const threshold = Number(item.threshold);
        const keywords = Array.isArray(item.keywords)
            ? item.keywords.map((kw) => (typeof kw === 'string' ? kw.trim() : '')).filter(Boolean)
            : [];
        if (!name || !keywords.length) return null;
        return {
            id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : generateCategoryId(),
            name,
            threshold: Number.isFinite(threshold) ? threshold : 0,
            keywords
        };
    }

    function exportCategories() {
        const categories = AppCore.getSettings().search.categories;
        if (!categories.length) {
            alert('Нет категорий для экспорта');
            return;
        }
        const blob = new Blob([JSON.stringify(categories, null, 2)], { type: 'application/json;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'categories.json';
        link.click();
        URL.revokeObjectURL(link.href);
    }

    function initMultiSelects() {
        multiSelects.status = createMultiSelect('filter-status', 'Все статусы', runSearch);
        multiSelects.priority = createMultiSelect('filter-priority', 'Все приоритеты', runSearch);
    }

    function createMultiSelect(id, placeholder, onChange) {
        const root = document.querySelector('[data-multi="' + id + '"]');
        const hiddenInput = document.getElementById(id);
        if (!root || !hiddenInput) {
            return {
                setOptions() {},
                getSelectedValues() {
                    return [];
                },
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
            const selectedLabels = Array.from(state.selected.values());
            labelNode.textContent = selectedLabels.length <= 2
                ? selectedLabels.join(', ')
                : 'Выбрано: ' + selectedLabels.length;
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
                        ? {
                            label: clean,
                            normalized: clean.toLowerCase()
                        }
                        : null;
                })
                .filter(Boolean);
            dropdown.innerHTML = '';
            clear(true);
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
            if (typeof onChange === 'function') onChange();
        });

        dropdown.addEventListener('click', (event) => {
            event.stopPropagation();
        });

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
            clear,
            close
        };

        return api;
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

    function compareDatesDesc(a, b) {
        const dateA = Date.parse(a);
        const dateB = Date.parse(b);
        if (Number.isNaN(dateA) && Number.isNaN(dateB)) return 0;
        if (Number.isNaN(dateA)) return 1;
        if (Number.isNaN(dateB)) return -1;
        return dateB - dateA;
    }
})();
