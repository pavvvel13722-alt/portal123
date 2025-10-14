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
                { key: 'thresholdLong', label: 'Порог для длинных описаний (≥20 токенов)', type: 'number', step: 0.01, min: 0, max: 1 },
                { key: 'baseThreshold', label: 'Порог без умной логики', type: 'number', step: 0.01, min: 0, max: 1 },
                { key: 'timeGuardEnabled', label: 'Учитывать интервал ± дней', type: 'checkbox', defaultValue: true },
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
        document.getElementById('btn-run-duplicates').textContent = '⏳ Обработка…';
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
        const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
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
            console.error('Duplicate analysis failed', payload?.error);
            alert('Не удалось выполнить анализ дублей. Подробности в консоли.');
            resetRunButton();
            runDuplicatesFallback();
        }
    }

    function handleWorkerError(event) {
        console.error('Duplicate worker runtime error', event?.message, event?.error || '');
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
            title.textContent = `${cluster.author || 'Неизвестная группа'} — ${cluster.members.length} обращений`;
            const stats = document.createElement('div');
            stats.className = 'cluster__stats';
            const statsParts = [];
            const thresholds = meta?.thresholds || {};
            if (meta?.smartThreshold) {
                const short = thresholds.short != null ? (thresholds.short * 100).toFixed(0) : '—';
                const medium = thresholds.medium != null ? (thresholds.medium * 100).toFixed(0) : '—';
                const long = thresholds.long != null ? (thresholds.long * 100).toFixed(0) : '—';
                statsParts.push(`Умный порог: <8 → ${short}%, 8-19 → ${medium}%, ≥20 → ${long}%`);
            } else if (thresholds.base != null) {
                statsParts.push(`Порог: ${(thresholds.base * 100).toFixed(0)}%`);
            }
            if (meta?.timeGuard?.enabled) {
                statsParts.push(`Интервал ±${meta.timeGuard.days} д.`);
            }
            if (!statsParts.length) {
                statsParts.push('Параметры порога недоступны');
            }
            stats.textContent = statsParts.join(' · ');
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
                        <div class="record__title">
                            <span class="record__badge">${record.isPrimary ? '🟩' : '🟥'}</span>
                            <a href="https://sfera.vtb.ru/sd/support?open=${record.id}" target="_blank" rel="noopener noreferrer">${record.id || '—'}</a>
                        </div>
                        <div class="record__snippet">${record.snippet || '<span class="record__meta">Нет описания</span>'}</div>
                    </div>
                    <div class="record__field">
                        <span>${record.author || '—'}</span>
                        <span class="record__meta">${record.isPrimary ? 'Основное обращение' : 'Дубль основного'}</span>
                    </div>
                    <div class="record__field">
                        <span>${record.priority || '—'}</span>
                        <span class="record__meta">${record.sla ? `SLA: ${record.sla}` : ''}</span>
                    </div>
                    <div class="record__field">
                        <span>${record.createdAt || '—'}</span>
                        <span class="record__meta">${record.status || ''}</span>
                    </div>
                    <div class="record__field">
                        <span>${record.similarity ? record.similarity : record.isPrimary ? '—' : '0%'}</span>
                        <span class="record__meta">${record.similarityDetail || 'Порог: —'}</span>
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
        const factorySource = `(${factory.toString()})`;
        return `
            const engineFactory = ${factorySource};
            const engine = engineFactory();
            self.onmessage = (event) => {
                const data = event.data || {};
                if (data.type === 'analyze') {
                    const payload = data.payload || {};
                    const records = Array.isArray(payload.records) ? payload.records : [];
                    const settings = payload.settings || {};
                    try {
                        const result = engine.analyze(records, settings);
                        self.postMessage({ type: 'analysis-complete', payload: result });
                    } catch (error) {
                        self.postMessage({ type: 'analysis-error', payload: { error: engine.serializeError(error) } });
                    }
                }
            };
        `;
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
