(function () {
    let worker = null;
    let workerUrl = null;
    let currentRecords = [];
    let currentClusters = [];
    let lastAnalysisMeta = null;
    let settingsContainer = null;
    let resultsContainer = null;
    const DuplicateEngine = buildDuplicateEngine();
    let pendingJob = null;
    const settingsControls = {
        threshold: null,
        thresholdRange: null,
        smartToggle: null,
        timeGuardToggle: null,
        timeGuardDays: null,
        stopPhrases: null
    };
    const settingsHints = {
        smart: null,
        threshold: null,
        guard: null
    };
    let resultsListenerAttached = false;
    const compareModal = {
        node: document.getElementById('compare-modal'),
        body: document.getElementById('compare-modal-body'),
        title: document.getElementById('compare-modal-title')
    };
    let compareModalReady = false;

    document.addEventListener('app:ready', ({ detail }) => {
        settingsContainer = document.getElementById('duplicate-settings');
        buildSettingsUI();
        syncSettingsState();
        setupWorker();
        resultsContainer = document.getElementById('duplicate-results');
        if (resultsContainer && !resultsListenerAttached) {
            resultsContainer.addEventListener('click', handleActionClick);
            resultsListenerAttached = true;
        }
        initCompareModal();
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
        document.getElementById('btn-run-duplicates').textContent = 'Обработка...';
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
            runButton.textContent = 'Найти дубли';
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
        const settings = AppCore.getSettings().duplicates || {};
        if (settingsControls.threshold) {
            let percent = Number(settings.baseThreshold) * 100;
            if (!Number.isFinite(percent)) percent = 62;
            percent = Math.round(percent);
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
            settingsControls.threshold.value = String(percent);
            if (settingsControls.thresholdRange) {
                settingsControls.thresholdRange.value = String(percent);
            }
            if (settingsHints.threshold) {
                settingsHints.threshold.textContent = 'Этот порог применяется, если авто режим отключён. Сейчас: ' + percent + '%.';
            }
        }
        if (settingsControls.smartToggle) {
            settingsControls.smartToggle.checked = Boolean(settings.smartThreshold);
            if (settingsHints.smart) {
                const short = settings.thresholdShort != null ? Math.round(settings.thresholdShort * 100) : 0;
                const medium = settings.thresholdMedium != null ? Math.round(settings.thresholdMedium * 100) : 0;
                const long = settings.thresholdLong != null ? Math.round(settings.thresholdLong * 100) : 0;
                settingsHints.smart.textContent = 'Авто режим: короткие тексты >= ' + short + '%, средние >= ' + medium + '%, длинные >= ' + long + '%.';
            }
        }
        if (settingsControls.timeGuardToggle) {
            const enabled = settings.timeGuardEnabled !== undefined ? Boolean(settings.timeGuardEnabled) : true;
            settingsControls.timeGuardToggle.checked = enabled;
            if (settingsControls.timeGuardDays) {
                let daysValue = settings.timeGuardDays != null ? Number(settings.timeGuardDays) : 14;
                if (!Number.isFinite(daysValue)) daysValue = 0;
                if (daysValue < 0) daysValue = 0;
                if (daysValue > 60) daysValue = 60;
                settingsControls.timeGuardDays.disabled = !enabled;
                settingsControls.timeGuardDays.value = String(daysValue);
                if (settingsHints.guard) {
                    settingsHints.guard.textContent = enabled
                        ? 'Будут сравниваться обращения в пределах ' + daysValue + ' дней от даты создания.'
                        : 'Фильтр по дате отключен.';
                }
            }
        }
        if (settingsControls.stopPhrases) {
            settingsControls.stopPhrases.value = settings.stopPhrases != null ? String(settings.stopPhrases) : '';
        }
    }

    function buildSettingsUI() {
        if (!settingsContainer) return;
        settingsControls.threshold = null;
        settingsControls.thresholdRange = null;
        settingsControls.smartToggle = null;
        settingsControls.timeGuardToggle = null;
        settingsControls.timeGuardDays = null;
        settingsControls.stopPhrases = null;
        settingsHints.smart = null;
        settingsHints.threshold = null;
        settingsHints.guard = null;
        settingsContainer.innerHTML = '';

        const thresholdCard = document.createElement('div');
        thresholdCard.className = 'setting';
        const thresholdLabel = document.createElement('label');
        thresholdLabel.textContent = 'Ручной порог похожести, %';
        thresholdCard.appendChild(thresholdLabel);
        const thresholdInput = document.createElement('input');
        thresholdInput.type = 'number';
        thresholdInput.min = '0';
        thresholdInput.max = '100';
        thresholdInput.step = '1';
        thresholdInput.addEventListener('change', function (event) {
            let value = Number(event.target.value);
            if (!Number.isFinite(value)) value = 62;
            if (value < 0) value = 0;
            if (value > 100) value = 100;
            event.target.value = String(Math.round(value));
            AppCore.updateSetting('duplicates', 'baseThreshold', value / 100);
            if (settingsControls.thresholdRange) {
                settingsControls.thresholdRange.value = String(Math.round(value));
            }
        });
        thresholdCard.appendChild(thresholdInput);
        const thresholdRange = document.createElement('input');
        thresholdRange.type = 'range';
        thresholdRange.min = '0';
        thresholdRange.max = '100';
        thresholdRange.step = '1';
        thresholdRange.className = 'setting__range';
        thresholdRange.addEventListener('input', function (event) {
            const value = Number(event.target.value);
            thresholdInput.value = String(value);
        });
        thresholdRange.addEventListener('change', function (event) {
            const value = Number(event.target.value);
            AppCore.updateSetting('duplicates', 'baseThreshold', value / 100);
        });
        thresholdCard.appendChild(thresholdRange);
        const thresholdHint = document.createElement('p');
        thresholdHint.className = 'setting__hint';
        thresholdCard.appendChild(thresholdHint);
        settingsControls.threshold = thresholdInput;
        settingsControls.thresholdRange = thresholdRange;
        settingsHints.threshold = thresholdHint;
        settingsContainer.appendChild(thresholdCard);

        const smartCard = document.createElement('div');
        smartCard.className = 'setting';
        const smartLabel = document.createElement('label');
        smartLabel.className = 'setting__checkbox-label';
        const smartInput = document.createElement('input');
        smartInput.type = 'checkbox';
        smartInput.addEventListener('change', function (event) {
            AppCore.updateSetting('duplicates', 'smartThreshold', event.target.checked);
        });
        smartLabel.appendChild(smartInput);
        const smartText = document.createElement('span');
        smartText.textContent = 'Авто режим порога по длине описания';
        smartLabel.appendChild(smartText);
        smartCard.appendChild(smartLabel);
        const smartHint = document.createElement('p');
        smartHint.className = 'setting__hint';
        smartCard.appendChild(smartHint);
        settingsControls.smartToggle = smartInput;
        settingsHints.smart = smartHint;
        settingsContainer.appendChild(smartCard);

        const guardCard = document.createElement('div');
        guardCard.className = 'setting';
        const guardToggleLabel = document.createElement('label');
        guardToggleLabel.className = 'setting__checkbox-label';
        const guardToggle = document.createElement('input');
        guardToggle.type = 'checkbox';
        guardToggle.addEventListener('change', function (event) {
            AppCore.updateSetting('duplicates', 'timeGuardEnabled', event.target.checked);
        });
        guardToggleLabel.appendChild(guardToggle);
        const guardText = document.createElement('span');
        guardText.textContent = 'Учитывать только обращения, созданные рядом по времени';
        guardToggleLabel.appendChild(guardText);
        guardCard.appendChild(guardToggleLabel);
        const guardInline = document.createElement('div');
        guardInline.className = 'setting__inline';
        const guardInlineLabel = document.createElement('span');
        guardInlineLabel.textContent = 'Интервал, дней';
        guardInline.appendChild(guardInlineLabel);
        const guardDays = document.createElement('input');
        guardDays.type = 'number';
        guardDays.min = '0';
        guardDays.max = '60';
        guardDays.step = '1';
        guardDays.addEventListener('change', function (event) {
            let value = Number(event.target.value);
            if (!Number.isFinite(value)) value = 0;
            if (value < 0) value = 0;
            if (value > 60) value = 60;
            event.target.value = String(Math.round(value));
            AppCore.updateSetting('duplicates', 'timeGuardDays', value);
        });
        guardInline.appendChild(guardDays);
        guardCard.appendChild(guardInline);
        const guardHint = document.createElement('p');
        guardHint.className = 'setting__hint';
        guardCard.appendChild(guardHint);
        settingsControls.timeGuardToggle = guardToggle;
        settingsControls.timeGuardDays = guardDays;
        settingsHints.guard = guardHint;
        settingsContainer.appendChild(guardCard);

        const stopCard = document.createElement('div');
        stopCard.className = 'setting setting--stretch';
        const stopLabel = document.createElement('label');
        stopLabel.textContent = 'Стоп-фразы (каждая с новой строки)';
        stopCard.appendChild(stopLabel);
        const stopArea = document.createElement('textarea');
        stopArea.addEventListener('change', function (event) {
            AppCore.updateSetting('duplicates', 'stopPhrases', event.target.value);
        });
        stopCard.appendChild(stopArea);
        settingsControls.stopPhrases = stopArea;
        settingsContainer.appendChild(stopCard);
    }

    function renderClusters(clusters, meta) {
        const container = document.getElementById('duplicate-results');
        const exportButton = document.getElementById('btn-export-duplicates');
        if (exportButton) {
            exportButton.disabled = !clusters.length;
        }
        if (!container) return;
        if (!clusters.length) {
            container.innerHTML = '<div class="empty-state">Загрузите файл и запустите анализ, чтобы увидеть кластеры дублей.</div>';
            return;
        }
        const fragment = document.createDocumentFragment();
        const totalDuplicates = clusters.reduce(function (sum, cluster) {
            const base = cluster && Array.isArray(cluster.members) ? cluster.members.length : 0;
            const duplicates = cluster && Array.isArray(cluster.duplicates) && cluster.duplicates.length
                ? cluster.duplicates.length
                : Math.max(base - 1, 0);
            return sum + duplicates;
        }, 0);
        const summary = document.createElement('div');
        summary.className = 'duplicates-summary';
        const summaryTotal = document.createElement('strong');
        summaryTotal.className = 'duplicates-summary__total';
        summaryTotal.textContent = 'Всего дублей к закрытию: ' + totalDuplicates;
        summary.appendChild(summaryTotal);
        const summaryGroups = document.createElement('span');
        summaryGroups.textContent = 'Групп: ' + clusters.length;
        summary.appendChild(summaryGroups);
        fragment.appendChild(summary);

        clusters.forEach(function (cluster, clusterIndex) {
            const wrapper = document.createElement('div');
            wrapper.className = 'cluster';
            const header = document.createElement('div');
            header.className = 'cluster__header';
            const headerTop = document.createElement('div');
            headerTop.className = 'cluster__top';
            const title = document.createElement('h3');
            title.className = 'cluster__title';
            const clusterAuthor = cluster.author ? cluster.author : 'Неизвестная группа';
            const memberCount = cluster.members && cluster.members.length ? cluster.members.length : 0;
            title.textContent = clusterAuthor + ' - ' + memberCount + ' обращений';
            headerTop.appendChild(title);
            const dismissButton = document.createElement('button');
            dismissButton.type = 'button';
            dismissButton.className = 'cluster__dismiss';
            dismissButton.dataset.action = 'dismiss-cluster';
            dismissButton.dataset.cluster = String(clusterIndex);
            dismissButton.textContent = 'Скрыть группу';
            headerTop.appendChild(dismissButton);
            header.appendChild(headerTop);

            const stats = document.createElement('div');
            stats.className = 'cluster__stats';
            const statsParts = [];
            const thresholds = meta && meta.thresholds ? meta.thresholds : {};
            if (meta && meta.smartThreshold) {
                const short = thresholds.short != null ? Math.round(thresholds.short * 100) : null;
                const medium = thresholds.medium != null ? Math.round(thresholds.medium * 100) : null;
                const long = thresholds.long != null ? Math.round(thresholds.long * 100) : null;
                const shortText = short != null ? short + '%' : '-';
                const mediumText = medium != null ? medium + '%' : '-';
                const longText = long != null ? long + '%' : '-';
                statsParts.push('Автонастройка: короткие >= ' + shortText + ', средние >= ' + mediumText + ', длинные >= ' + longText);
            } else if (thresholds.base != null) {
                const basePercent = Math.round(thresholds.base * 100);
                statsParts.push('Порог похожести: ' + basePercent + '%');
            }
            if (meta && meta.timeGuard && meta.timeGuard.enabled) {
                statsParts.push('Окно по дате +/-' + meta.timeGuard.days + ' д.');
            }
            if (!statsParts.length) {
                statsParts.push('Информация о порогах недоступна');
            }
            stats.textContent = statsParts.join(' | ');
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
                row.dataset.clusterIndex = String(clusterIndex);
                row.dataset.recordId = record.id ? record.id : '';

                const fieldId = document.createElement('div');
                fieldId.className = 'record__field record__id';
                const titleWrap = document.createElement('div');
                titleWrap.className = 'record__title';
                const badge = document.createElement('span');
                badge.className = 'record__badge';
                badge.textContent = record.isPrimary ? 'Осн.' : 'Дубль';
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
                openButton.dataset.label = 'Открыть';
                if (!record.isPrimary && masterId) {
                    openButton.dataset.primary = masterId;
                }
                openButton.textContent = 'Открыть';
                actions.appendChild(openButton);
                if (record.isPrimary) {
                    const compareButton = document.createElement('button');
                    compareButton.dataset.action = 'compare';
                    compareButton.dataset.cluster = String(clusterIndex);
                    compareButton.textContent = 'Сравнить описания';
                    actions.appendChild(compareButton);
                }
                row.appendChild(actions);

                list.appendChild(row);
            });
            wrapper.appendChild(list);
            fragment.appendChild(wrapper);
        });
        container.innerHTML = '';
        container.appendChild(fragment);
    }

    function handleActionClick(event) {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        const button = target.closest('button[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'dismiss-cluster') {
            const clusterIndex = button.dataset.cluster;
            dismissCluster(clusterIndex);
            return;
        }
        if (action === 'compare') {
            const clusterIndex = button.dataset.cluster;
            openCompareModal(clusterIndex);
            return;
        }
        const id = button.dataset.id;
        if (!id) return;
        if (action === 'open') {
            const url = 'https://sfera.vtb.ru/sd/support?open=' + encodeURIComponent(id);
            const primaryId = button.dataset.primary;
            if (primaryId && primaryId !== id) {
                copyClosureText(primaryId).then(function (copied) {
                    if (copied) {
                        showCopyFeedback(button);
                    }
                });
            }
            window.open(url, '_blank', 'noopener');
        }
    }

    function dismissCluster(clusterIndex) {
        const index = Number(clusterIndex);
        if (!Number.isFinite(index) || index < 0) return;
        if (!currentClusters || !currentClusters.length) return;
        if (index >= currentClusters.length) return;
        currentClusters.splice(index, 1);
        renderClusters(currentClusters, lastAnalysisMeta);
    }

    function showCopyFeedback(button) {
        if (!button) return;
        const base = button.dataset.label && button.dataset.label !== ''
            ? button.dataset.label
            : button.textContent;
        button.textContent = base + ' (скопировано)';
        setTimeout(function () {
            button.textContent = base;
        }, 2000);
    }

    function copyClosureText(primaryId) {
        const text = 'Ошибочное обращение\nДубль обращения ' + primaryId + '. Работы продолжаются там.';
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).then(function () {
                return true;
            }).catch(function () {
                return fallbackCopyText(text);
            });
        }
        return Promise.resolve(fallbackCopyText(text));
    }

    function fallbackCopyText(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        let success = false;
        try {
            success = document.execCommand('copy');
        } catch (err) {
            success = false;
        }
        document.body.removeChild(textarea);
        if (!success) {
            alert('Не удалось скопировать текст. Скопируйте вручную:\n' + text);
        }
        return success;
    }

    function initCompareModal() {
        if (!compareModal.node || compareModalReady) return;
        compareModalReady = true;
        compareModal.node.addEventListener('click', function (event) {
            const target = event.target;
            if (target && target.dataset && target.dataset.compareClose !== undefined) {
                closeCompareModal();
            }
        });
        const closers = compareModal.node.querySelectorAll('[data-compare-close]');
        Array.prototype.forEach.call(closers, function (button) {
            button.addEventListener('click', function () {
                closeCompareModal();
            });
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && isCompareModalOpen()) {
                closeCompareModal();
            }
        });
    }

    function openCompareModal(clusterIndex) {
        if (!compareModal.node || !compareModal.body) return;
        const index = Number(clusterIndex);
        if (!Number.isFinite(index) || index < 0) return;
        const cluster = currentClusters && currentClusters[index] ? currentClusters[index] : null;
        if (!cluster) return;
        const primary = cluster.primary || null;
        const authorName = cluster.author ? cluster.author : 'Автор не указан';
        if (compareModal.title) {
            const idLabel = primary && primary.id ? primary.id : '-';
            compareModal.title.textContent = 'Сравнение описаний: ' + idLabel;
        }
        compareModal.body.innerHTML = '';

        const primarySection = document.createElement('div');
        primarySection.className = 'compare-modal__section';
        const primaryHeading = document.createElement('h4');
        primaryHeading.textContent = 'Основное обращение ' + (primary && primary.id ? primary.id : '-');
        primarySection.appendChild(primaryHeading);
        const primaryMeta = document.createElement('p');
        primaryMeta.className = 'compare-modal__meta';
        let primaryMetaText = 'Автор: ' + authorName;
        if (primary && primary.createdAt) {
            primaryMetaText += ' | Создано: ' + primary.createdAt;
        }
        primaryMeta.textContent = primaryMetaText;
        primarySection.appendChild(primaryMeta);
        const primaryText = document.createElement('p');
        primaryText.className = 'compare-modal__text';
        primaryText.textContent = primary && primary.description ? primary.description : 'Описание отсутствует';
        primarySection.appendChild(primaryText);
        compareModal.body.appendChild(primarySection);

        const duplicatesSection = document.createElement('div');
        duplicatesSection.className = 'compare-modal__section';
        const duplicatesHeading = document.createElement('h4');
        const duplicates = cluster.duplicates || [];
        duplicatesHeading.textContent = duplicates.length ? 'Дубли (' + duplicates.length + ')' : 'Дубли';
        duplicatesSection.appendChild(duplicatesHeading);
        if (duplicates.length) {
            const list = document.createElement('div');
            list.className = 'compare-modal__list';
            duplicates.forEach(function (dup) {
                const item = document.createElement('div');
                item.className = 'compare-modal__item';
                const itemHeading = document.createElement('h5');
                const dupId = dup && dup.id ? dup.id : '-';
                const dupSimilarity = dup && dup.similarity ? dup.similarity : '0%';
                itemHeading.textContent = dupId + ' - ' + dupSimilarity;
                item.appendChild(itemHeading);
                const itemMeta = document.createElement('p');
                itemMeta.className = 'compare-modal__meta';
                let metaText = '';
                if (dup && dup.createdAt) {
                    metaText += 'Создано: ' + dup.createdAt;
                }
                if (dup && dup.similarityDetail) {
                    if (metaText) metaText += ' | ';
                    metaText += dup.similarityDetail;
                }
                itemMeta.textContent = metaText ? metaText : 'Дополнительные детали отсутствуют';
                item.appendChild(itemMeta);
                const itemText = document.createElement('p');
                itemText.textContent = dup && dup.description ? dup.description : 'Описание отсутствует';
                item.appendChild(itemText);
                list.appendChild(item);
            });
            duplicatesSection.appendChild(list);
        } else {
            const empty = document.createElement('p');
            empty.className = 'compare-modal__text';
            empty.textContent = 'Дубли для сравнения отсутствуют.';
            duplicatesSection.appendChild(empty);
        }
        compareModal.body.appendChild(duplicatesSection);
        compareModal.body.scrollTop = 0;
        compareModal.node.setAttribute('aria-hidden', 'false');
    }

    function closeCompareModal() {
        if (!compareModal.node) return;
        compareModal.node.setAttribute('aria-hidden', 'true');
    }

    function isCompareModalOpen() {
        return compareModal.node && compareModal.node.getAttribute('aria-hidden') === 'false';
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
