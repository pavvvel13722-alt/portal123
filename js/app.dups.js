(function () {
    let worker = null;
    let workerUrl = null;
    let currentRecords = [];
    let currentClusters = [];
    let lastAnalysisMeta = null;
    let settingsContainer = null;
    const DuplicateEngine = buildDuplicateEngine();
    let pendingJob = null;

    document.addEventListener('app:ready', ({ detail }) => {
        settingsContainer = document.getElementById('duplicate-settings');
        AppCore.mountSettings(
            settingsContainer,
            [
                { key: 'smartThreshold', label: 'Умный порог по длине', type: 'checkbox', defaultValue: true },
                { key: 'thresholdShort', label: 'Порог для коротких описаний (<8 токенов)', type: 'number', step: 0.01, min: 0, max: 1 },
                { key: 'thresholdMedium', label: 'Порог для средних описаний (8-19 токенов)', type: 'number', step: 0.01, min: 0, max: 1 },
                { key: 'thresholdLong', label: 'Порог для длинных описаний (>=20 токенов)', type: 'number', step: 0.01, min: 0, max: 1 },
                { key: 'baseThreshold', label: 'Порог без умной логики', type: 'number', step: 0.01, min: 0, max: 1 },
                { key: 'timeGuardEnabled', label: 'Учитывать интервал +/- дней', type: 'checkbox', defaultValue: true },
                { key: 'timeGuardDays', label: 'Интервал по дате (дни)', type: 'number', step: 1, min: 0, max: 60 },
                { key: 'stopPhrases', label: 'Стоп-фразы в описании (по одной в строке)', type: 'textarea' }
            ],
            'duplicates'
        );
        syncSettingsState();
        setupWorker();
    });

    document.addEventListener('app:settings-update', ({ detail }) => {
        if (detail.group === 'duplicates') {
            syncSettingsState();
        }
    });

    document.addEventListener('app:data-updated', ({ detail }) => {
        currentRecords = detail.records;
        currentClusters = [];
        lastAnalysisMeta = null;
        pendingJob = null;
        renderClusters([], null);
    });

    document.getElementById('btn-run-duplicates').addEventListener('click', () => {
        if (!currentRecords.length) return;
        const settings = AppCore.getSettings().duplicates;
        document.getElementById('btn-run-duplicates').textContent = '⏳ Обработка...';
        document.getElementById('btn-run-duplicates').disabled = true;
        const payload = {
            records: prepareWorkerPayload(currentRecords),
            settings
        };
        pendingJob = payload;
        try {
            const instance = ensureWorker();
            if (!instance) {
                throw new Error('Не удалось создать Web Worker');
            }
            instance.postMessage({
                type: 'analyze',
                payload
            });
        } catch (error) {
            console.error('Failed to start duplicate analysis', error);
            alert('Не удалось запустить анализ дублей. Подробности в консоли.');
            resetRunButton();
            teardownWorker();
            runDuplicatesFallback();
        }
    });

    document.getElementById('btn-export-duplicates').addEventListener('click', () => {
        if (!currentClusters.length) return;
        const rows = [['PrimaryID', 'DuplicateID', 'Author', 'Similarity', 'CreatedAt', 'Priority', 'Status']];
        currentClusters.forEach((cluster) => {
            cluster.duplicates.forEach((dup) => {
                rows.push([
                    cluster.primary.id,
                    dup.id,
                    cluster.author,
                    dup.similarity,
                    dup.createdAt,
                    dup.priority || '',
                    dup.status || ''
                ]);
            });
        });
        const csv = rows
            .map(function (row) {
                return row
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
        link.download = 'duplicates.csv';
        link.click();
        URL.revokeObjectURL(link.href);
    });

    function handleWorkerMessage(event) {
        const { type, payload } = event.data || {};
        if (type === 'analysis-complete') {
            currentClusters = payload.clusters;
            lastAnalysisMeta = payload.meta;
            renderClusters(currentClusters, lastAnalysisMeta);
            resetRunButton();
            pendingJob = null;
        }
        if (type === 'analysis-error') {
            const payloadError = payload && payload.error ? payload.error : payload;
            console.error('Duplicate analysis failed', payloadError);
            alert('Не удалось выполнить анализ дублей. Подробности в консоли.');
            resetRunButton();
            runDuplicatesFallback();
        }
    }

    function handleWorkerError(event) {
        const runtimeMessage = event && event.message ? event.message : '';
        const runtimeError = event && event.error ? event.error : '';
        console.error('Duplicate worker runtime error', runtimeMessage, runtimeError);
        alert('Произошла ошибка Web Worker. Проверьте консоль.');
        resetRunButton();
        teardownWorker();
        runDuplicatesFallback();
    }

    function resetRunButton() {
        const runButton = document.getElementById('btn-run-duplicates');
        if (runButton) {
            runButton.textContent = '🔍 Найти дубли';
            runButton.disabled = false;
        }
    }

    function ensureWorker() {
        if (worker) return worker;
        return setupWorker();
    }

    function setupWorker() {
        if (typeof Worker === 'undefined') {
            console.error('Web Worker API недоступен в этом окружении');
            return null;
        }
        teardownWorker();
        const created = createWorker();
        if (!created) {
            return null;
        }
        worker = created.worker;
        workerUrl = created.url;
        const releaseUrl = () => {
            if (workerUrl) {
                URL.revokeObjectURL(workerUrl);
                workerUrl = null;
            }
        };
        worker.addEventListener('message', releaseUrl, { once: true });
        worker.addEventListener('message', handleWorkerMessage);
        worker.addEventListener('error', handleWorkerError);
        return worker;
    }

    function teardownWorker() {
        if (worker) {
            try {
                worker.terminate();
            } catch (err) {
                console.warn('Не удалось завершить воркер дублей', err);
            }
            worker = null;
        }
        if (workerUrl) {
            URL.revokeObjectURL(workerUrl);
            workerUrl = null;
        }
    }

    function prepareWorkerPayload(records) {
        if (!Array.isArray(records)) return [];
        return records.map((record) => ({
            id: record.id || '',
            author: record.author || '',
            requester: record.requester || '',
            contact: record.contact || '',
            description: record.description || '',
            createdAt: record.createdAt || '',
            priority: record.priority || '',
            status: record.status || '',
            sla: record.sla || '',
            dueAt: record.dueAt || ''
        }));
    }

    function syncSettingsState() {
        if (!settingsContainer) return;
        const smartToggle = settingsContainer.querySelector('[data-setting-key="smartThreshold"]');
        const smartDependent = settingsContainer.querySelectorAll('[data-setting-key="thresholdShort"], [data-setting-key="thresholdMedium"], [data-setting-key="thresholdLong"]');
        const guardToggle = settingsContainer.querySelector('[data-setting-key="timeGuardEnabled"]');
        const guardField = settingsContainer.querySelector('[data-setting-key="timeGuardDays"]');
        const smartOn = smartToggle ? smartToggle.checked : Boolean(AppCore.getSettingValue('duplicates', 'smartThreshold'));
        smartDependent.forEach((input) => {
            input.disabled = !smartOn;
        });
        if (guardField) {
            const guardOn = guardToggle ? guardToggle.checked : Boolean(AppCore.getSettingValue('duplicates', 'timeGuardEnabled'));
            guardField.disabled = !guardOn;
        }
    }

    function renderClusters(clusters, meta) {
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
            const clusterAuthor = cluster.author ? cluster.author : 'Неизвестная группа';
            title.textContent = clusterAuthor + ' - ' + cluster.members.length + ' обращений';
            const stats = document.createElement('div');
            stats.className = 'cluster__stats';
            const statsParts = [];
            const thresholds = meta && meta.thresholds ? meta.thresholds : {};
            if (meta && meta.smartThreshold) {
                const short = thresholds.short != null ? (thresholds.short * 100).toFixed(0) : '-';
                const medium = thresholds.medium != null ? (thresholds.medium * 100).toFixed(0) : '-';
                const long = thresholds.long != null ? (thresholds.long * 100).toFixed(0) : '-';
                statsParts.push('Умный порог: <8 -> ' + short + '%, 8-19 -> ' + medium + '%, >=20 -> ' + long + '%');
            } else if (thresholds.base != null) {
                statsParts.push('Порог: ' + (thresholds.base * 100).toFixed(0) + '%');
            }
            if (meta && meta.timeGuard && meta.timeGuard.enabled) {
                statsParts.push('Интервал +/-' + meta.timeGuard.days + ' д.');
            }
            if (!statsParts.length) {
                statsParts.push('Параметры порога недоступны');
            }
            stats.textContent = statsParts.join(' | ');
            header.appendChild(title);
            header.appendChild(stats);
            wrapper.appendChild(header);

        const list = document.createElement('div');
        list.className = 'record-list';
        const masterId = cluster.primary && cluster.primary.id ? cluster.primary.id : '';
        cluster.members.forEach(function (record) {
            const row = document.createElement('div');
            row.className = 'record';
            if (record.isPrimary) row.classList.add('record--primary');
            else row.classList.add('record--duplicate');

            const fieldId = document.createElement('div');
            fieldId.className = 'record__field record__id';
            const titleWrap = document.createElement('div');
            titleWrap.className = 'record__title';
            const badge = document.createElement('span');
            badge.className = 'record__badge';
            badge.textContent = record.isPrimary ? '🟩' : '🟥';
            titleWrap.appendChild(badge);
            const link = document.createElement('a');
            const recordId = record.id ? record.id : '';
            const linkUrl = 'https://sfera.vtb.ru/sd/support?open=' + encodeURIComponent(recordId);
            link.href = linkUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = recordId || '-';
            titleWrap.appendChild(link);
            fieldId.appendChild(titleWrap);
            const snippet = document.createElement('div');
            snippet.className = 'record__snippet';
            snippet.innerHTML = record.snippet ? record.snippet : '<span class="record__meta">Нет описания</span>';
            fieldId.appendChild(snippet);
            row.appendChild(fieldId);

            const fieldAuthor = document.createElement('div');
            fieldAuthor.className = 'record__field';
            const authorSpan = document.createElement('span');
            authorSpan.textContent = record.author || '-';
            fieldAuthor.appendChild(authorSpan);
            const role = document.createElement('span');
            role.className = 'record__meta';
            role.textContent = record.isPrimary ? 'Основное обращение' : 'Дубль основного';
            fieldAuthor.appendChild(role);
            row.appendChild(fieldAuthor);

            const fieldPriority = document.createElement('div');
            fieldPriority.className = 'record__field';
            const prioritySpan = document.createElement('span');
            prioritySpan.textContent = record.priority || '-';
            fieldPriority.appendChild(prioritySpan);
            const slaSpan = document.createElement('span');
            slaSpan.className = 'record__meta';
            slaSpan.textContent = record.sla ? 'SLA: ' + record.sla : '';
            fieldPriority.appendChild(slaSpan);
            row.appendChild(fieldPriority);

            const fieldDate = document.createElement('div');
            fieldDate.className = 'record__field';
            const dateSpan = document.createElement('span');
            dateSpan.textContent = record.createdAt || '-';
            fieldDate.appendChild(dateSpan);
            const statusSpan = document.createElement('span');
            statusSpan.className = 'record__meta';
            statusSpan.textContent = record.status || '';
            fieldDate.appendChild(statusSpan);
            row.appendChild(fieldDate);

            const fieldSimilarity = document.createElement('div');
            fieldSimilarity.className = 'record__field';
            const similaritySpan = document.createElement('span');
            if (record.similarity) similaritySpan.textContent = record.similarity;
            else if (record.isPrimary) similaritySpan.textContent = '-';
            else similaritySpan.textContent = '0%';
            fieldSimilarity.appendChild(similaritySpan);
            const similarityMeta = document.createElement('span');
            similarityMeta.className = 'record__meta';
            similarityMeta.textContent = record.similarityDetail || 'Порог: -';
            fieldSimilarity.appendChild(similarityMeta);
            row.appendChild(fieldSimilarity);

            const actions = document.createElement('div');
            actions.className = 'record__actions';
            const openButton = document.createElement('button');
            openButton.dataset.action = 'open';
            openButton.dataset.id = recordId;
            openButton.textContent = '🔗 Открыть';
            actions.appendChild(openButton);
            const copyButton = document.createElement('button');
            copyButton.dataset.action = 'copy';
            copyButton.dataset.id = recordId;
            copyButton.dataset.primary = masterId;
            copyButton.textContent = '📋 Текст закрытия';
            if (record.isPrimary) copyButton.disabled = true;
            actions.appendChild(copyButton);
            row.appendChild(actions);

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
            const url = 'https://sfera.vtb.ru/sd/support?open=' + encodeURIComponent(id);
            window.open(url, '_blank', 'noopener');
        }
        if (action === 'copy') {
            const primaryId = button.dataset.primary || id;
            const text = 'Ошибочное обращение\nДубль обращения ' + primaryId + '. Работы продолжаются там.';
            navigator.clipboard.writeText(text).then(function () {
                button.textContent = '✅ Скопировано';
                setTimeout(function () {
                    button.textContent = '📋 Текст закрытия';
                }, 2000);
            }).catch(function () {
                alert('Не удалось скопировать текст. Скопируйте вручную:\n' + text);
            });
        }
    }

    function buildDuplicateEngine() {
        const factory = (typeof window !== 'undefined' && typeof window.DuplicateEngineFactory === 'function')
            ? window.DuplicateEngineFactory
            : null;
        if (!factory) {
            console.error('Не удалось найти движок дублей');
            return {
                analyze: () => ({ clusters: [], meta: null }),
                serializeError: (err) => ({ message: String(err || 'Unknown error') })
            };
        }
        try {
            return factory();
        } catch (error) {
            console.error('Не удалось подготовить резервный движок дублей', error);
            return {
                analyze: () => ({ clusters: [], meta: null }),
                serializeError: (err) => ({ message: String(err || 'Unknown error') })
            };
        }
    }

    function runDuplicatesFallback() {
        if (!pendingJob || !pendingJob.records || !pendingJob.records.length) {
            pendingJob = null;
            return;
        }
        try {
            const result = DuplicateEngine.analyze(pendingJob.records, pendingJob.settings || {});
            currentClusters = result.clusters || [];
            lastAnalysisMeta = result.meta || null;
            renderClusters(currentClusters, lastAnalysisMeta);
        } catch (error) {
            console.error('Fallback duplicate analysis failed', error);
            alert('Не удалось выполнить анализ дублей. Подробности в консоли.');
        } finally {
            resetRunButton();
            pendingJob = null;
        }
    }

    function getWorkerScript() {
        const factory = (typeof window !== 'undefined' && typeof window.DuplicateEngineFactory === 'function')
            ? window.DuplicateEngineFactory
            : null;
        if (!factory) {
            throw new Error('DuplicateEngineFactory недоступен');
        }
        const factorySource = '(' + factory.toString() + ')';
        const lines = [];
        lines.push('const engineFactory = ' + factorySource + ';');
        lines.push('const engine = engineFactory();');
        lines.push('self.onmessage = function (event) {');
        lines.push('    const data = event.data || {};');
        lines.push('    if (data.type === "analyze") {');
        lines.push('        const payload = data.payload || {};');
        lines.push('        const records = Array.isArray(payload.records) ? payload.records : [];');
        lines.push('        const settings = payload.settings || {};');
        lines.push('        try {');
        lines.push('            const result = engine.analyze(records, settings);');
        lines.push('            self.postMessage({ type: "analysis-complete", payload: result });');
        lines.push('        } catch (error) {');
        lines.push('            self.postMessage({ type: "analysis-error", payload: { error: engine.serializeError(error) } });');
        lines.push('        }');
        lines.push('    }');
        lines.push('};');
        return lines.join('\n');
    }

    function createWorker() {
        try {
            const script = getWorkerScript();
            const blob = new Blob([script], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const worker = new Worker(url);
            return { worker, url };
        } catch (error) {
            console.error('Не удалось создать воркер дублей', error);
            return null;
        }
    }
})();
