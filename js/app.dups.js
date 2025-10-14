(function () {
    const worker = createWorker();
    let currentRecords = [];
    let currentClusters = [];

    document.addEventListener('app:ready', ({ detail }) => {
        const container = document.getElementById('duplicate-settings');
        AppCore.mountSettings(
            container,
            [
                { key: 'similarityThreshold', label: 'Порог похожести (0-1)', type: 'number', step: 0.01, min: 0, max: 1 },
                { key: 'dateWindow', label: 'Окно по дате (± дней)', type: 'number', min: 0, max: 30, step: 1 },
                { key: 'stopwords', label: 'Стоп-слова (через запятую)', type: 'textarea' }
            ],
            'duplicates'
        );
    });

    document.addEventListener('app:data-updated', ({ detail }) => {
        currentRecords = detail.records;
        currentClusters = [];
        renderClusters([]);
    });

    document.getElementById('btn-run-duplicates').addEventListener('click', () => {
        if (!currentRecords.length) return;
        const settings = AppCore.getSettings().duplicates;
        document.getElementById('btn-run-duplicates').textContent = '⏳ Обработка…';
        document.getElementById('btn-run-duplicates').disabled = true;
        worker.postMessage({
            type: 'analyze',
            payload: {
                records: currentRecords,
                settings
            }
        });
    });

    document.getElementById('btn-export-duplicates').addEventListener('click', () => {
        if (!currentClusters.length) return;
        const rows = [['PrimaryID', 'DuplicateID', 'GroupLabel', 'Similarity', 'CreatedAt', 'Priority', 'Status']];
        currentClusters.forEach((cluster) => {
            cluster.duplicates.forEach((dup) => {
                rows.push([
                    cluster.primary.id,
                    dup.id,
                    cluster.label,
                    dup.similarity,
                    dup.createdAt,
                    dup.priority || '',
                    dup.status || ''
                ]);
            });
        });
        const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'duplicates.csv';
        link.click();
        URL.revokeObjectURL(link.href);
    });

    worker.addEventListener('message', (event) => {
        const { type, payload } = event.data;
        if (type === 'analysis-complete') {
            currentClusters = payload.clusters;
            renderClusters(currentClusters);
            document.getElementById('btn-run-duplicates').textContent = '🔍 Найти дубли';
            document.getElementById('btn-run-duplicates').disabled = false;
        }
    });

    function renderClusters(clusters) {
        const container = document.getElementById('duplicate-results');
        document.getElementById('btn-export-duplicates').disabled = !clusters.length;
        if (!clusters.length) {
            container.innerHTML = '<div class="empty-state">Загрузите файл и запустите анализ, чтобы увидеть кластеры дублей.</div>';
            return;
        }
        const fragment = document.createDocumentFragment();
        clusters.forEach((cluster) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'cluster';
            const header = document.createElement('div');
            header.className = 'cluster__header';
            const title = document.createElement('h3');
            title.className = 'cluster__title';
            title.textContent = `${cluster.label || 'Неизвестная группа'} — ${cluster.members.length} обращений`;
            const stats = document.createElement('div');
            stats.className = 'cluster__stats';
            stats.textContent = `Порог ≥ ${(cluster.threshold * 100).toFixed(0)}%, окно ±${cluster.window} д.`;
            header.appendChild(title);
            header.appendChild(stats);
            wrapper.appendChild(header);

            const list = document.createElement('div');
            list.className = 'record-list';
            const masterId = cluster.primary?.id || '';
            cluster.members.forEach((record) => {
                const row = document.createElement('div');
                row.className = 'record';
                if (record.isPrimary) row.classList.add('record--primary');
                else row.classList.add('record--duplicate');

                row.innerHTML = `
                    <div class="record__field record__id">
                        <a href="https://sfera.vtb.ru/sd/support?open=${record.id}" target="_blank" rel="noopener noreferrer">${record.id || '—'}</a>
                        <span class="record__meta">${record.title || ''}</span>
                    </div>
                    <div class="record__field">
                        <span>${record.author || '—'}</span>
                        <span class="record__meta">${[record.status || '', record.contact ? `Контакт: ${record.contact}` : ''].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div class="record__field">
                        <span>${record.priority || '—'}</span>
                        <span class="record__meta">SLA: ${record.sla || '—'}</span>
                    </div>
                    <div class="record__field">
                        <span>${record.createdAt || '—'}</span>
                        <span class="record__meta">Норматив: ${record.dueAt || '—'}</span>
                    </div>
                    <div class="record__field">
                        <span>${record.similarity ? record.similarity : record.isPrimary ? '—' : '0%'}</span>
                        <span class="record__meta">Похожесть</span>
                    </div>
                    <div class="record__actions">
                        <button data-action="open" data-id="${record.id}">🔗 Открыть</button>
                        <button data-action="copy" data-id="${record.id}" data-primary="${masterId}" ${record.isPrimary ? 'disabled' : ''}>📋 Текст закрытия</button>
                    </div>
                `;
                list.appendChild(row);
            });
            wrapper.appendChild(list);
            fragment.appendChild(wrapper);
        });
        container.innerHTML = '';
        container.appendChild(fragment);
        container.querySelectorAll('.record__actions button').forEach((button) => {
            button.addEventListener('click', handleActionClick);
        });
    }

    function handleActionClick(event) {
        const button = event.currentTarget;
        const action = button.dataset.action;
        const id = button.dataset.id;
        if (!id) return;
        if (action === 'open') {
            window.open(`https://sfera.vtb.ru/sd/support?open=${id}`, '_blank', 'noopener');
        }
        if (action === 'copy') {
            const primaryId = button.dataset.primary || id;
            const text = `Ошибочное обращение\nДубль обращения ${primaryId}. Работы продолжаются там.`;
            navigator.clipboard.writeText(text).then(() => {
                button.textContent = '✅ Скопировано';
                setTimeout(() => {
                    button.textContent = '📋 Текст закрытия';
                }, 2000);
            }).catch(() => {
                alert('Не удалось скопировать текст. Скопируйте вручную:\n' + text);
            });
        }
    }

    function createWorker() {
        const script = `
            const PRIORITY_WEIGHTS = {
                'критический': 5,
                'critical': 5,
                'очень высокий': 4,
                'high': 4,
                'высокий': 4,
                'средний': 3,
                'normal': 3,
                'низкий': 2,
                'low': 2,
                'плановый': 1,
                'плановая': 1,
                'низкий приоритет': 1
            };

            const SLA_WEIGHTS = {
                'нарушено': 3,
                'просрочено': 3,
                'в риске': 2,
                'risk': 2,
                'ожидает': 1.5,
                'ожидание': 1.5,
                'выполнено': 1,
                'закрыто': 1,
                'нет данных': 0
            };

            self.onmessage = (event) => {
                const { type, payload } = event.data;
                if (type === 'analyze') {
                    const result = analyze(payload.records, payload.settings);
                    self.postMessage({ type: 'analysis-complete', payload: result });
                }
            };

            function analyze(records, settings) {
                const stopwords = buildStopwords(settings.stopwords);
                const windowDays = Number(settings.dateWindow) || 0;
                const threshold = Number(settings.similarityThreshold) || 0.62;
                const prepared = records.map((rec, index) => prepareRecord(rec, stopwords, index));
                const grouped = groupByActor(prepared);
                const clusters = [];

                for (const group of grouped.values()) {
                    const { key, label, items } = group;
                    const edges = buildEdges(items, windowDays, threshold);
                    const components = connectedComponents(items, edges);
                    components.forEach((component) => {
                        if (component.length <= 1) return;
                        const cluster = buildCluster(component, threshold, windowDays, label, key);
                        clusters.push(cluster);
                    });
                }

                clusters.sort((a, b) => b.members.length - a.members.length);
                return { clusters, threshold, window: windowDays };
            }

            function buildStopwords(stopwordsString) {
                if (!stopwordsString) return new Set();
                return new Set(stopwordsString.split(/[,;\n]/).map((word) => word.trim().toLowerCase()).filter(Boolean));
            }

            function prepareRecord(record, stopwords, index) {
                const text = `${record.title || ''} ${record.description || ''}`;
                const normalized = normalizeText(text, stopwords);
                const trigrams = getTrigramVector(normalized);
                const dateValue = parseDate(record.createdAt);
                return {
                    ...record,
                    index,
                    normalized,
                    trigrams,
                    createdTime: dateValue,
                    createdDate: dateValue ? new Date(dateValue) : null,
                    groupLabel: (record.contact || record.author || record.requester || '').trim()
                };
            }

            function normalizeText(text, stopwords) {
                return text
                    .toLowerCase()
                    .replace(/[^a-zа-я0-9\s]+/g, ' ')
                    .split(/\s+/)
                    .filter((word) => word && !stopwords.has(word))
                    .join(' ');
            }

            function getTrigramVector(text) {
                const map = new Map();
                const padded = `  ${text}  `;
                for (let i = 0; i < padded.length - 2; i++) {
                    const trigram = padded.slice(i, i + 3);
                    map.set(trigram, (map.get(trigram) || 0) + 1);
                }
                return map;
            }

            function parseDate(value) {
                if (!value) return null;
                if (typeof value === 'number') return value;
                if (value instanceof Date) return value.getTime();
                const trimmed = String(value).trim();
                if (!trimmed) return null;
                const iso = Date.parse(trimmed.replace(/\./g, '-').replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$2-$1'));
                if (!Number.isNaN(iso)) return iso;
                const parts = trimmed.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
                if (parts) {
                    const day = Number(parts[1]);
                    const month = Number(parts[2]) - 1;
                    const year = Number(parts[3].length === 2 ? `20${parts[3]}` : parts[3]);
                    const hours = Number(parts[4] || 0);
                    const minutes = Number(parts[5] || 0);
                    return Date.UTC(year, month, day, hours, minutes);
                }
                const fallback = Date.parse(trimmed);
                return Number.isNaN(fallback) ? null : fallback;
            }

            function groupByActor(records) {
                const map = new Map();
                records.forEach((record) => {
                    const label = record.groupLabel || record.contact || record.author || record.requester || 'Не указан';
                    const key = label ? label.toLowerCase() : 'не указан';
                    if (!map.has(key)) {
                        map.set(key, { key, label, items: [] });
                    }
                    map.get(key).items.push(record);
                });
                return map;
            }

            function buildEdges(records, windowDays, threshold) {
                const edges = new Map();
                const windowMs = windowDays * 24 * 60 * 60 * 1000;
                records.sort((a, b) => (a.createdTime || 0) - (b.createdTime || 0));
                for (let i = 0; i < records.length; i++) {
                    for (let j = i + 1; j < records.length; j++) {
                        const left = records[i];
                        const right = records[j];
                        if (windowMs && left.createdTime != null && right.createdTime != null) {
                            const diff = Math.abs(left.createdTime - right.createdTime);
                            if (diff > windowMs) {
                                if (right.createdTime - left.createdTime > windowMs) break;
                            }
                        }
                        const similarity = cosineSimilarity(left.trigrams, right.trigrams);
                        if (similarity >= threshold) {
                            connect(edges, left.index, right.index, similarity);
                        }
                    }
                }
                return edges;
            }

            function cosineSimilarity(mapA, mapB) {
                let dot = 0;
                let normA = 0;
                let normB = 0;
                mapA.forEach((value) => {
                    normA += value * value;
                });
                mapB.forEach((value) => {
                    normB += value * value;
                });
                const smaller = mapA.size < mapB.size ? mapA : mapB;
                const larger = smaller === mapA ? mapB : mapA;
                smaller.forEach((value, key) => {
                    const other = larger.get(key);
                    if (other) {
                        dot += value * other;
                    }
                });
                if (!dot || !normA || !normB) return 0;
                return dot / (Math.sqrt(normA) * Math.sqrt(normB));
            }

            function connect(edges, a, b, similarity) {
                if (!edges.has(a)) edges.set(a, new Map());
                if (!edges.has(b)) edges.set(b, new Map());
                edges.get(a).set(b, similarity);
                edges.get(b).set(a, similarity);
            }

            function connectedComponents(records, edges) {
                const visited = new Set();
                const components = [];
                const recordMap = new Map(records.map((rec) => [rec.index, rec]));
                for (const record of records) {
                    if (visited.has(record.index)) continue;
                    const stack = [record.index];
                    const component = [];
                    while (stack.length) {
                        const current = stack.pop();
                        if (visited.has(current)) continue;
                        visited.add(current);
                        const node = recordMap.get(current);
                        component.push(node);
                        const neighbors = edges.get(current);
                        if (neighbors) {
                            neighbors.forEach((_, neighbor) => {
                                if (!visited.has(neighbor)) stack.push(neighbor);
                            });
                        }
                    }
                    components.push(component);
                }
                return components;
            }

            function buildCluster(records, threshold, windowDays, label, key) {
                const primary = selectPrimary(records);
                const members = records
                    .map((record) => {
                        const similarity = record.index === primary.index
                            ? null
                            : cosineSimilarity(record.trigrams, primary.trigrams);
                        return {
                            id: record.id,
                            author: record.author,
                            contact: record.contact,
                            title: record.title,
                            status: record.status,
                            priority: record.priority,
                            sla: record.sla,
                            createdAt: record.createdAt,
                            dueAt: record.dueAt,
                            similarity: similarity != null ? `${Math.round(similarity * 100)}%` : null,
                            isPrimary: record.index === primary.index
                        };
                    })
                    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
                const duplicates = members.filter((member) => !member.isPrimary);
                return {
                    primary: members.find((member) => member.isPrimary),
                    members,
                    duplicates,
                    threshold,
                    window: windowDays,
                    label: label || 'Неизвестная группа',
                    groupKey: key
                };
            }

            function selectPrimary(records) {
                return records.slice().sort((a, b) => {
                    const priorityDiff = getPriorityWeight(b.priority) - getPriorityWeight(a.priority);
                    if (priorityDiff !== 0) return priorityDiff;
                    const slaDiff = getSlaWeight(b.sla) - getSlaWeight(a.sla);
                    if (slaDiff !== 0) return slaDiff;
                    const dateA = a.createdTime ?? Number.MAX_SAFE_INTEGER;
                    const dateB = b.createdTime ?? Number.MAX_SAFE_INTEGER;
                    return dateA - dateB;
                })[0];
            }

            function getPriorityWeight(priority) {
                if (!priority) return 0;
                const normalized = priority.toLowerCase();
                return PRIORITY_WEIGHTS[normalized] ?? 0;
            }

            function getSlaWeight(sla) {
                if (!sla) return 0;
                const normalized = sla.toLowerCase();
                return SLA_WEIGHTS[normalized] ?? 0;
            }
        `;
        const blob = new Blob([script], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        worker.addEventListener('message', () => {
            URL.revokeObjectURL(url);
        }, { once: true });
        return worker;
    }
})();
