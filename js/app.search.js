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

    function setupEvents() {
        elements.runSearch.addEventListener('click', runSearch);
        elements.exportSearch.addEventListener('click', exportCurrentResults);
        elements.resetFilters.addEventListener('click', () => {
            elements.filterStatus.value = '';
            elements.filterPriority.value = '';
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
            const tokens = tokenize(`${authorText} ${descriptionText}`);
            return {
                ...record,
                __id: String(idx),
                authorText,
                descriptionText,
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
            status: elements.filterStatus.value.trim().toLowerCase(),
            priority: elements.filterPriority.value.trim().toLowerCase()
        };
    }

    function passesFilters(record, filters) {
        if (filters.status && !(record.status || '').toLowerCase().includes(filters.status)) return false;
        if (filters.priority && !(record.priority || '').toLowerCase().includes(filters.priority)) return false;
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
        elements.resultContainer.innerHTML = `
            <div class="table-scroll">
                <table class="table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Автор</th>
                            <th>Описание</th>
                            <th>Создано</th>
                            <th>Статус</th>
                            <th>Приоритет</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        `;
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
            tr.innerHTML = `
                <td><a href="https://sfera.vtb.ru/sd/support?open=${encodeURIComponent(row.id)}" target="_blank" rel="noopener">${escapeHtml(row.id || '')}</a></td>
                <td>${escapeHtml(row.author || '')}</td>
                <td><span class="description-cell" title="${descriptionFull}">${row.descriptionHighlighted || escapeHtml(row.description || '')}</span></td>
                <td>${escapeHtml(row.createdAt || '')}</td>
                <td>${escapeHtml(row.status || '')}</td>
                <td>${escapeHtml(row.priority || '')}</td>
            `;
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
        const rows = [['ID', 'Автор', 'Описание', 'Создано', 'Статус', 'Приоритет']];
        currentResults.forEach((row) => {
            rows.push([
                row.id,
                row.author,
                row.description,
                row.createdAt,
                row.status,
                row.priority
            ]);
        });
        const csv = rows
            .map((line) => line.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';'))
            .join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
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
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            highlighted = highlighted.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="highlight">$1</mark>');
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
            li.innerHTML = `
                <div class="category-item__header">
                    <span class="category-item__name">${escapeHtml(category.name)}</span>
                    <div class="category-item__actions">
                        <span class="badge">Порог ≥ ${escapeHtml(String(category.threshold))}</span>
                        <button class="button button--ghost" data-action="edit" type="button" title="Редактировать">✏️</button>
                        <button class="button button--ghost" data-action="delete" type="button" title="Удалить">🗑️</button>
                    </div>
                </div>
                <div class="category-item__keywords">${category.keywords
                    .map((keyword) => `<span class="chip">${escapeHtml(keyword)}</span>`)
                    .join('')}</div>
            `;
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
        chipContainer.innerHTML = chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('');
    }

    function updateResultCounter(count) {
        if (!elements.resultCount) return;
        elements.resultCount.textContent = `Найдено: ${count}`;
    }

    function populateFilterOptions(list) {
        const statuses = new Set();
        const priorities = new Set();
        list.forEach((record) => {
            if (record.status) statuses.add(record.status);
            if (record.priority) priorities.add(record.priority);
        });
        setSelectOptions(elements.filterStatus, statuses, 'Все статусы');
        setSelectOptions(elements.filterPriority, priorities, 'Все приоритеты');
    }

    function setSelectOptions(select, values, placeholder) {
        const sorted = Array.from(values).sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }));
        select.innerHTML = `<option value="">${placeholder}</option>` + sorted.map((value) => {
            const escaped = escapeHtml(value);
            const attr = escapeAttribute(value.toLowerCase());
            return `<option value="${attr}">${escaped}</option>`;
        }).join('');
        select.selectedIndex = 0;
    }

    function openCategoryModal(category) {
        const isEdit = Boolean(category);
        modalState = { id: category?.id || null };
        elements.modalTitle.textContent = isEdit ? 'Редактирование категории' : 'Новая категория';
        elements.modalName.value = category?.name || '';
        elements.modalKeywords.value = category ? category.keywords.join('\n') : '';
        elements.modalThreshold.value = category?.threshold != null ? category.threshold : 5;
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
        return `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }

    function importCategories(event) {
        const file = event.target.files?.[0];
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
