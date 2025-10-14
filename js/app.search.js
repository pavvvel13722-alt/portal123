(function () {
    const chunkSize = 150;
    let records = [];
    let processedRecords = [];
    let recordMap = new Map();
    let index = null;
    let activeCategoryId = null;
    let currentResults = [];
    let renderedCount = 0;

    document.addEventListener('app:ready', () => {
        renderCategories();
        setupEvents();
    });

    document.addEventListener('app:data-updated', ({ detail }) => {
        records = detail.records;
        processedRecords = preprocessRecords(records);
        recordMap = new Map(processedRecords.map((item) => [item.__id, item]));
        rebuildIndex(processedRecords);
        document.getElementById('search-results').innerHTML = '<div class="empty-state">Введите запрос или выберите категорию для поиска.</div>';
    });

    document.getElementById('btn-run-search').addEventListener('click', runSearch);

    document.getElementById('btn-export-search').addEventListener('click', () => {
        if (!currentResults.length) return;
        const rows = [['ID', 'Автор', 'Сервис', 'Название', 'Описание', 'Создано', 'Статус', 'Приоритет', 'Счёт']];
        currentResults.forEach((row) => {
            rows.push([
                row.id,
                row.author,
                row.service,
                row.title,
                row.description,
                row.createdAt,
                row.status,
                row.priority,
                row.score
            ]);
        });
        const csv = rows.map((line) => line.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'search-results.csv';
        link.click();
        URL.revokeObjectURL(link.href);
    });

    function setupEvents() {
        document.getElementById('btn-add-category').addEventListener('click', () => {
            const name = prompt('Название категории');
            if (!name) return;
            const keywords = prompt('Ключевые слова через запятую');
            if (keywords == null) return;
            const thresholdInput = prompt('Порог совпадений (число)', '5');
            const threshold = Number(thresholdInput) || 0;
            const settings = AppCore.getSettings();
            const categories = [...settings.search.categories];
            categories.push({
                id: Date.now().toString(36),
                name,
                keywords: keywords.split(/[,\n;]/).map((w) => w.trim()).filter(Boolean),
                threshold
            });
            AppCore.replaceGroup('search', { ...settings.search, categories });
            renderCategories(categories);
        });

        document.getElementById('category-list').addEventListener('click', (event) => {
            const item = event.target.closest('.category-item');
            if (!item) return;
            const id = item.dataset.id;
            const action = event.target.dataset.action;
            const settings = AppCore.getSettings();
            const categories = [...settings.search.categories];
            const index = categories.findIndex((cat) => cat.id === id);
            if (index === -1) return;
            if (action === 'edit') {
                const category = categories[index];
                const name = prompt('Название категории', category.name);
                if (!name) return;
                const keywords = prompt('Ключевые слова через запятую', category.keywords.join(', '));
                if (keywords == null) return;
                const thresholdInput = prompt('Порог совпадений', String(category.threshold));
                const threshold = Number(thresholdInput) || 0;
                categories[index] = {
                    ...category,
                    name,
                    keywords: keywords.split(/[,\n;]/).map((w) => w.trim()).filter(Boolean),
                    threshold
                };
                AppCore.replaceGroup('search', { ...settings.search, categories });
                renderCategories(categories);
                if (activeCategoryId === id) {
                    setActiveCategory(id);
                }
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
                }
                return;
            }
            if (!action) {
                setActiveCategory(id);
            }
        });
    }

    function renderCategories(categories = AppCore.getSettings().search.categories) {
        const container = document.getElementById('category-list');
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
                    <span>${category.name}</span>
                    <div>
                        <span class="badge">Порог ≥ ${category.threshold}</span>
                        <button class="button" data-action="edit" title="Редактировать">✏️</button>
                        <button class="button" data-action="delete" title="Удалить">🗑️</button>
                    </div>
                </div>
                <div class="category-item__keywords">${category.keywords
                    .map((keyword) => `<span class="chip">${keyword}</span>`)
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
    }

    function updateKeywordChips() {
        const chipContainer = document.getElementById('search-keywords');
        const query = document.getElementById('search-query').value;
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
        chipContainer.innerHTML = chips.map((chip) => `<span class="chip">${chip}</span>`).join('');
    }

    function preprocessRecords(list) {
        return list.map((record, idx) => {
            const text = [record.title, record.description, record.service, record.tags, record.author, record.id]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            const tokens = text.split(/[^a-zа-я0-9ё]+/i).filter(Boolean);
            const tokenSet = new Set(tokens);
            return {
                ...record,
                __id: String(idx),
                searchText: text,
                tokens,
                tokenSet
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
                    { field: 'title', tokenize: 'forward', resolution: 9, weight: 4 },
                    { field: 'description', tokenize: 'forward', resolution: 9, weight: 3 },
                    { field: 'service', tokenize: 'forward', resolution: 5, weight: 2 },
                    { field: 'tags', tokenize: 'forward', resolution: 5, weight: 2 },
                    { field: 'author', tokenize: 'forward', resolution: 3, weight: 1 },
                    { field: 'id', tokenize: 'forward', resolution: 3, weight: 1 }
                ]
            }
        });
        list.forEach((record) => {
            index.add({
                __id: record.__id,
                title: record.title,
                description: record.description,
                service: record.service,
                tags: record.tags,
                author: record.author,
                id: record.id
            });
        });
    }

    function runSearch() {
        if (!processedRecords.length) return;
        const queryInput = document.getElementById('search-query').value.trim();
        const category = AppCore.getSettings().search.categories.find((cat) => cat.id === activeCategoryId);
        const tokens = extractTokens(queryInput);
        const allKeywords = new Set([...tokens.all, ...(category ? category.keywords : [])]);
        updateKeywordChips();
        if (!allKeywords.size) {
            document.getElementById('search-results').innerHTML = '<div class="empty-state">Введите запрос или выберите категорию.</div>';
            currentResults = [];
            return;
        }
        const candidateIds = gatherCandidates(allKeywords);
        const filters = collectFilters();
        const results = [];
        const highlightTerms = Array.from(allKeywords).map((term) => term.toLowerCase());
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
                titleHighlighted: highlightText(record.title || '', highlightTerms),
                descriptionHighlighted: highlightText(record.description || '', highlightTerms)
            });
        });
        results.sort((a, b) => b.score - a.score);
        currentResults = results;
        renderedCount = 0;
        renderSearchResults();
    }

    function gatherCandidates(keywords) {
        if (!index) return processedRecords.map((rec) => rec.__id);
        const set = new Set();
        keywords.forEach((keyword) => {
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
            dateFrom: parseDate(document.getElementById('filter-date-from').value, true),
            dateTo: parseDate(document.getElementById('filter-date-to').value, false),
            priority: document.getElementById('filter-priority').value.trim().toLowerCase(),
            status: document.getElementById('filter-status').value.trim().toLowerCase(),
            service: document.getElementById('filter-service').value.trim().toLowerCase()
        };
    }

    function passesFilters(record, filters) {
        if (filters.priority && !(record.priority || '').toLowerCase().includes(filters.priority)) return false;
        if (filters.status && !(record.status || '').toLowerCase().includes(filters.status)) return false;
        if (filters.service && !(record.service || '').toLowerCase().includes(filters.service)) return false;
        if (filters.dateFrom || filters.dateTo) {
            const time = parseDate(record.createdAt);
            if (filters.dateFrom && (!time || time < filters.dateFrom)) return false;
            if (filters.dateTo && (!time || time > filters.dateTo)) return false;
        }
        return true;
    }

    function computeScore(record, tokens, category) {
        let score = 0;
        const serviceTags = `${record.service || ''} ${record.tags || ''}`.toLowerCase();
        const checkServiceBoost = (term) => (serviceTags.includes(term) ? 1.2 : 1);
        tokens.phrases.forEach((phrase) => {
            if (!phrase) return;
            if (record.searchText.includes(phrase)) {
                score += 5 * checkServiceBoost(phrase);
            }
        });
        const singleWords = new Set([...tokens.words, ...(category ? category.keywords.flatMap((kw) => (kw.split(/\s+/).length === 1 ? [kw.toLowerCase()] : [])) : [])]);
        singleWords.forEach((word) => {
            if (!word) return;
            if (record.tokenSet.has(word)) {
                score += 2 * checkServiceBoost(word);
            } else {
                const similar = record.tokens.some((token) => levenshtein(token, word) <= 1);
                if (similar) {
                    score += 1;
                }
            }
        });
        if (category) {
            category.keywords
                .filter((kw) => kw.split(/\s+/).length >= 2)
                .forEach((phrase) => {
                    const normalized = phrase.toLowerCase();
                    if (record.searchText.includes(normalized)) {
                        score += 5 * checkServiceBoost(normalized);
                    }
                });
        }
        return Math.round(score * 100) / 100;
    }

    function highlightText(text, keywords) {
        if (!text) return '';
        let highlighted = text;
        keywords.forEach((keyword) => {
            if (!keyword) return;
            const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi');
            highlighted = highlighted.replace(regex, '<mark class="highlight">$1</mark>');
        });
        return highlighted;
    }

    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function renderSearchResults() {
        const container = document.getElementById('search-results');
        if (!currentResults.length) {
            container.innerHTML = '<div class="empty-state">Совпадения не найдены. Попробуйте изменить ключевые слова или фильтры.</div>';
            document.getElementById('btn-export-search').disabled = true;
            return;
        }
        document.getElementById('btn-export-search').disabled = false;
        container.style.maxHeight = '70vh';
        container.style.overflowY = 'auto';
        container.innerHTML = `
            <table class="table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Автор</th>
                        <th>Сервис</th>
                        <th>Название</th>
                        <th>Описание</th>
                        <th>Создано</th>
                        <th>Статус</th>
                        <th>Приоритет</th>
                        <th>Счёт</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        `;
        renderedCount = 0;
        appendRows();
        container.removeEventListener('scroll', onScrollAppend);
        container.addEventListener('scroll', onScrollAppend);
    }

    function appendRows() {
        const tbody = document.querySelector('#search-results tbody');
        if (!tbody) return;
        const fragment = document.createDocumentFragment();
        const slice = currentResults.slice(renderedCount, renderedCount + chunkSize);
        if (!slice.length) return;
        slice.forEach((row) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><a href="https://sfera.vtb.ru/sd/support?open=${row.id}" target="_blank" rel="noopener">${row.id}</a></td>
                <td>${row.author || ''}</td>
                <td>${row.service || ''}</td>
                <td>${row.titleHighlighted || row.title || ''}</td>
                <td>${row.descriptionHighlighted || row.description || ''}</td>
                <td>${row.createdAt || ''}</td>
                <td>${row.status || ''}</td>
                <td>${row.priority || ''}</td>
                <td>${row.score}</td>
            `;
            fragment.appendChild(tr);
        });
        tbody.appendChild(fragment);
        renderedCount += slice.length;
    }

    function onScrollAppend(event) {
        const el = event.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
            appendRows();
        }
    }

    function parseDate(value, isStart) {
        if (!value) return null;
        const parts = value.split('-').map(Number);
        if (parts.length < 3) return null;
        const [year, month, day] = parts;
        if (isStart) {
            return Date.UTC(year, month - 1, day, 0, 0, 0);
        }
        return Date.UTC(year, month - 1, day, 23, 59, 59);
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
        const cleaned = query.replace(/"([^"]+)"/g, '').trim();
        const words = cleaned.split(/[,;\s]+/).map((word) => word.trim().toLowerCase()).filter(Boolean);
        const multiWordPhrases = words.filter((word) => word.split(/\s+/).length > 1);
        multiWordPhrases.forEach((phrase) => phrases.push(phrase));
        const singles = words.filter((word) => word.split(/\s+/).length === 1);
        return {
            all: [...phrases, ...singles],
            phrases,
            words: singles
        };
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

    document.getElementById('search-query').addEventListener('input', () => {
        updateKeywordChips();
    });
})();
