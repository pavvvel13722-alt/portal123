(function () {
    const STORAGE_KEY = 'vtb-portal-settings';
    const deepClone = typeof structuredClone === 'function' ? structuredClone : (value) => JSON.parse(JSON.stringify(value));
    const DEFAULTS = {
        duplicates: {
            similarityThreshold: 0.62,
            dateWindow: 3,
            stopwords: 'и, в, во, не, что, он, на, я, с, со, как, а, то, все, она, так, его, но, да, ты, к, у, же, вы, за, бы, по, только, ее, мне, было, вот, от, меня, еще, нет, о, из, ему, теперь, когда, даже, ну, вдруг, ли, если, уже, или, ни, быть, был, него, до, вас, нибудь, опять, уж, вам, ведь, там, потом, себя, ничего, ей, может, они, тут, где, есть, надо, ней, для, мы, тебя, их, чем, была, сам, чтоб, без, будто, чего, раз'
        },
        search: {
            categories: [
                {
                    id: 'vrm',
                    name: 'Проблема подключения к ВРМ',
                    threshold: 5,
                    keywords: ['врм', 'vrm', 'удалённый рабочий', 'vpn', 'mstsc', 'rdp', 'crypto pro', 'ошибка соединения', 'сертификат', 'gateway']
                },
                {
                    id: 'password',
                    name: 'Смена/сброс пароля',
                    threshold: 5,
                    keywords: ['смена пароля', 'сброс пароля', 'учётка заблокирована', 'не помню пароль', 'vtb pro не пускает']
                }
            ]
        }
    };

    const state = {
        records: [],
        columns: [],
        fileName: null,
        settings: loadSettings()
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return deepClone(DEFAULTS);
            const parsed = JSON.parse(raw);
            return mergeDeep(deepClone(DEFAULTS), parsed);
        } catch (err) {
            console.warn('Не удалось загрузить настройки', err);
            return deepClone(DEFAULTS);
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
        } catch (err) {
            console.warn('Не удалось сохранить настройки', err);
        }
    }

    function mergeDeep(target, source) {
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                target[key] = mergeDeep(target[key] || {}, source[key]);
            } else {
                target[key] = source[key];
            }
        }
        return target;
    }

    function init() {
        setupTabs();
        setupFileUpload();
        document.dispatchEvent(new CustomEvent('app:ready', { detail: { settings: state.settings } }));
    }

    function setupTabs() {
        const tabs = document.querySelectorAll('.tabs__tab');
        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                if (tab.classList.contains('tabs__tab--active')) return;
                tabs.forEach((el) => {
                    el.classList.remove('tabs__tab--active');
                    el.setAttribute('aria-selected', 'false');
                });
                tab.classList.add('tabs__tab--active');
                tab.setAttribute('aria-selected', 'true');
                const target = tab.dataset.tab;
                document.querySelectorAll('.tab-panel').forEach((panel) => {
                    panel.classList.toggle('tab-panel--active', panel.id === `tab-${target}`);
                });
            });
        });
    }

    function setupFileUpload() {
        const fileInput = document.getElementById('csv-file');
        const info = document.getElementById('upload-info');

        fileInput.addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            info.textContent = 'Загружается…';
            try {
                const text = await readFileAsText(file);
                const parsed = Papa.parse(text, {
                    header: true,
                    skipEmptyLines: true,
                    delimiter: detectDelimiter(text),
                    transformHeader: (header) => header.trim(),
                    transform: (value) => (typeof value === 'string' ? value.trim() : value)
                });
                const columns = parsed.meta.fields || [];
                const cleaned = (parsed.data || []).filter(Boolean).map((row) => normalizeRow(row, columns));
                state.records = cleaned;
                state.columns = columns;
                state.fileName = file.name;
                info.textContent = `${file.name} · ${cleaned.length.toLocaleString('ru-RU')} записей`;
                toggleButtons(true);
                document.dispatchEvent(new CustomEvent('app:data-updated', {
                    detail: {
                        records: state.records,
                        columns: state.columns,
                        fileName: state.fileName
                    }
                }));
            } catch (err) {
                console.error(err);
                info.textContent = 'Ошибка чтения файла';
                toggleButtons(false);
            }
        });
    }

    function toggleButtons(enabled) {
        document.getElementById('btn-run-duplicates').disabled = !enabled;
        document.getElementById('btn-export-duplicates').disabled = !enabled;
        document.getElementById('btn-run-search').disabled = !enabled;
        document.getElementById('btn-export-search').disabled = !enabled;
    }

    async function readFileAsText(file) {
        const buffer = await file.arrayBuffer();
        const decoder = new TextDecoder('windows-1251');
        return decoder.decode(buffer);
    }

    function detectDelimiter(text) {
        const candidates = [';', ',', '\t'];
        const lines = text.split(/\r?\n/).slice(0, 10);
        let best = candidates[0];
        let bestScore = -Infinity;
        for (const delimiter of candidates) {
            let score = 0;
            for (const line of lines) {
                const count = line.split(delimiter).length;
                if (count > 1) score += count;
            }
            if (score > bestScore) {
                bestScore = score;
                best = delimiter;
            }
        }
        return best;
    }

    function normalizeRow(row, columns) {
        const mapping = {
            ID: 'id',
            Автор: 'author',
            Название: 'title',
            Описание: 'description',
            Статус: 'status',
            Приоритет: 'priority',
            Создано: 'createdAt',
            'Нормативный срок': 'dueAt',
            'SLA-индикатор': 'sla',
            'SLM-индикатор': 'sla',
            Сервис: 'service',
            Теги: 'tags',
            'Тэги': 'tags'
        };
        const normalized = {};
        for (const column of columns) {
            if (!Object.prototype.hasOwnProperty.call(mapping, column)) continue;
            const key = mapping[column];
            normalized[key] = row[column] ?? '';
        }
        normalized.title = normalized.title || '';
        normalized.description = normalized.description || '';
        normalized.createdAt = normalized.createdAt || '';
        normalized.id = normalized.id || '';
        normalized.priority = normalized.priority || '';
        normalized.sla = normalized.sla || '';
        normalized.service = normalized.service || '';
        normalized.tags = normalized.tags || '';
        normalized._raw = row;
        normalized._searchBlob = [normalized.id, normalized.author, normalized.title, normalized.description, normalized.service, normalized.tags]
            .filter(Boolean)
            .join(' \n ')
            .toLowerCase();
        return normalized;
    }

    function getRecords() {
        return state.records;
    }

    function getSettings() {
        return state.settings;
    }

    function updateSetting(group, key, value) {
        if (!state.settings[group]) state.settings[group] = {};
        state.settings[group][key] = value;
        saveSettings();
        document.dispatchEvent(new CustomEvent('app:settings-update', { detail: { group, key, value } }));
    }

    function replaceGroup(group, value) {
        state.settings[group] = value;
        saveSettings();
        document.dispatchEvent(new CustomEvent('app:settings-update', { detail: { group, value } }));
    }

    function mountSettings(container, descriptors, group) {
        container.innerHTML = '';
        descriptors.forEach((desc) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'setting';
            const label = document.createElement('label');
            label.textContent = desc.label;
            let control;
            if (desc.type === 'textarea') {
                control = document.createElement('textarea');
                control.value = getSettingValue(group, desc.key) ?? desc.defaultValue ?? '';
            } else {
                control = document.createElement('input');
                control.type = desc.type || 'text';
                control.value = getSettingValue(group, desc.key) ?? desc.defaultValue ?? '';
                if (desc.step) control.step = String(desc.step);
                if (desc.min !== undefined) control.min = String(desc.min);
                if (desc.max !== undefined) control.max = String(desc.max);
            }
            control.addEventListener('change', (event) => {
                let newValue = event.target.value;
                if (desc.type === 'number') {
                    newValue = Number(newValue);
                }
                updateSetting(group, desc.key, newValue);
            });
            wrapper.appendChild(label);
            wrapper.appendChild(control);
            container.appendChild(wrapper);
        });
    }

    function getSettingValue(group, key) {
        return state.settings?.[group]?.[key];
    }

    window.AppCore = {
        init,
        getRecords,
        getSettings,
        updateSetting,
        replaceGroup,
        mountSettings,
        getSettingValue
    };

    document.addEventListener('DOMContentLoaded', init);
})();
