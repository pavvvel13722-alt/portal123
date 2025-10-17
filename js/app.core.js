(function () {
    if (!window.escapeHtml || !window.escapeAttribute) {
        window.escapeHtml = function (v) {
            v = String(v == null ? '' : v);
            return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };
        window.escapeAttribute = function (v) {
            v = String(v == null ? '' : v);
            return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
        };
    }
    const STORAGE_KEY = 'vtb-portal-settings';
    const deepClone = typeof structuredClone === 'function' ? structuredClone : (value) => JSON.parse(JSON.stringify(value));
    const DEFAULTS = {
        duplicates: {
            smartThreshold: true,
            thresholdShort: 0.8,
            thresholdMedium: 0.7,
            thresholdLong: 0.62,
            baseThreshold: 0.62,
            timeGuardEnabled: true,
            timeGuardDays: 14,
            stopPhrases: 'добрый день\nздравствуйте\nспасибо\nс уважением\nпрошу помочь\nне работает\nесть ошибка',
            stopwords: ''
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
        },
        tags: {
            stopPhrases: 'добрый день\nздравствуйте\nспасибо\nс уважением\nпрошу помочь',
            stopTokens: 'ошибка\nпроблема\nсистема\nсообщает\nпросит\nнужно',
            domainTokens: 'vpn\nvrm\nrdp\nmstsc\nnla\ncredssp\nсертификат\ncrypto pro\nкриптопро\nудалённый\nудаленный\ngateway',
            lenBoost1: 1,
            lenBoost2: 1.25,
            lenBoost3: 1.45,
            domainBoost: 1.15,
            coverageThreshold: 0.7
        },
        ui: {
            theme: 'light'
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
            const base = deepClone(DEFAULTS);
            if (!raw) return upgradeSettings(base);
            const parsed = JSON.parse(raw);
            const merged = mergeDeep(base, parsed);
            return upgradeSettings(merged);
        } catch (err) {
            console.warn('Не удалось загрузить настройки', err);
            return upgradeSettings(deepClone(DEFAULTS));
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

    function upgradeSettings(settings) {
        if (!settings.duplicates) {
            settings.duplicates = deepClone(DEFAULTS.duplicates);
        }
        const dup = settings.duplicates;
        const ensureNumber = (value, fallback) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : fallback;
        };
        dup.smartThreshold = dup.smartThreshold !== undefined ? Boolean(dup.smartThreshold) : DEFAULTS.duplicates.smartThreshold;
        dup.thresholdShort = ensureNumber(dup.thresholdShort, DEFAULTS.duplicates.thresholdShort);
        dup.thresholdMedium = ensureNumber(dup.thresholdMedium, DEFAULTS.duplicates.thresholdMedium);
        dup.thresholdLong = ensureNumber(dup.thresholdLong, DEFAULTS.duplicates.thresholdLong);
        dup.baseThreshold = ensureNumber(
            dup.baseThreshold !== undefined ? dup.baseThreshold : dup.similarityThreshold,
            DEFAULTS.duplicates.baseThreshold
        );
        if (dup.stopPhrases == null || dup.stopPhrases === '') {
            dup.stopPhrases = typeof dup.stopwords === 'string' && dup.stopwords.trim()
                ? dup.stopwords
                : DEFAULTS.duplicates.stopPhrases;
        }
        dup.timeGuardEnabled = dup.timeGuardEnabled !== undefined ? Boolean(dup.timeGuardEnabled) : true;
        dup.timeGuardDays = ensureNumber(
            dup.timeGuardDays !== undefined ? dup.timeGuardDays : dup.dateWindow,
            DEFAULTS.duplicates.timeGuardDays
        );
        if (dup.timeGuardDays < 0) dup.timeGuardDays = 0;
        if (!settings.ui || typeof settings.ui !== 'object') {
            settings.ui = { ...DEFAULTS.ui };
        }
        const theme = String(settings.ui.theme || DEFAULTS.ui.theme).toLowerCase();
        settings.ui.theme = theme === 'dark' ? 'dark' : 'light';

        if (!settings.tags || typeof settings.tags !== 'object') {
            settings.tags = deepClone(DEFAULTS.tags);
        } else {
            const tagSettings = settings.tags;
            if (typeof tagSettings.stopPhrases !== 'string') {
                tagSettings.stopPhrases = DEFAULTS.tags.stopPhrases;
            }
            if (typeof tagSettings.stopTokens !== 'string') {
                tagSettings.stopTokens = DEFAULTS.tags.stopTokens;
            }
            if (typeof tagSettings.domainTokens !== 'string') {
                tagSettings.domainTokens = DEFAULTS.tags.domainTokens;
            }
            const ensureFloat = (value, fallback) => {
                const num = Number(value);
                return Number.isFinite(num) ? num : fallback;
            };
            tagSettings.lenBoost1 = ensureFloat(tagSettings.lenBoost1, DEFAULTS.tags.lenBoost1);
            tagSettings.lenBoost2 = ensureFloat(tagSettings.lenBoost2, DEFAULTS.tags.lenBoost2);
            tagSettings.lenBoost3 = ensureFloat(tagSettings.lenBoost3, DEFAULTS.tags.lenBoost3);
            tagSettings.domainBoost = ensureFloat(tagSettings.domainBoost, DEFAULTS.tags.domainBoost);
            tagSettings.coverageThreshold = ensureFloat(tagSettings.coverageThreshold, DEFAULTS.tags.coverageThreshold);
            if (tagSettings.coverageThreshold < 0) tagSettings.coverageThreshold = 0;
            if (tagSettings.coverageThreshold > 1) tagSettings.coverageThreshold = 1;
        }
        return settings;
    }

    function init() {
        setupTabs();
        setupFileUpload();
        setupThemeToggle();
        document.dispatchEvent(new CustomEvent('app:ready', { detail: { settings: state.settings } }));
    }

    function setupTabs() {
        const tabs = document.querySelectorAll('.tabs__tab');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                if (tab.classList.contains('tabs__tab--active')) return;
                tabs.forEach(function (el) {
                    el.classList.remove('tabs__tab--active');
                    el.setAttribute('aria-selected', 'false');
                });
                tab.classList.add('tabs__tab--active');
                tab.setAttribute('aria-selected', 'true');
                var target = tab.dataset.tab;
                document.querySelectorAll('.tab-panel').forEach(function (panel) {
                    panel.classList.toggle('tab-panel--active', panel.id === 'tab-' + target);
                });
            });
        });
    }

    function setupFileUpload() {
        const fileInput = document.getElementById('csv-file');
        const info = document.getElementById('upload-info');

        fileInput.addEventListener('change', async (event) => {
            const target = event.target || event.currentTarget;
            const files = target && target.files ? target.files : null;
            const file = files && files.length ? files[0] : null;
            if (!file) return;
            info.textContent = 'Загружается...';
            try {
                const text = await readFileAsText(file);
                const delimiter = detectDelimiter(text);
                const parsed = parseCsv(text, { delimiter, header: true, skipEmptyLines: true });
                const columns = parsed.meta.fields || [];
                const cleaned = (parsed.data || [])
                    .filter(Boolean)
                    .map((row) => normalizeRow(row, columns));
                state.records = cleaned;
                state.columns = columns;
                state.fileName = file.name;
                info.textContent = file.name + ' - ' + cleaned.length.toLocaleString('ru-RU') + ' записей';
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

    function setupThemeToggle() {
        const button = document.getElementById('theme-toggle');
        const initialTheme = state.settings && state.settings.ui && state.settings.ui.theme
            ? state.settings.ui.theme
            : DEFAULTS.ui.theme;
        applyTheme(initialTheme);
        if (!button) return;
        updateThemeButton(button, initialTheme);
        button.addEventListener('click', () => {
            const current = state.settings && state.settings.ui && state.settings.ui.theme === 'dark' ? 'dark' : 'light';
            const next = current === 'dark' ? 'light' : 'dark';
            state.settings.ui = state.settings.ui || {};
            state.settings.ui.theme = next;
            applyTheme(next);
            updateThemeButton(button, next);
            saveSettings();
            document.dispatchEvent(new CustomEvent('app:settings-update', { detail: { group: 'ui', key: 'theme', value: next } }));
        });
    }

    function applyTheme(theme) {
        const normalized = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.theme = normalized;
        document.body.classList.toggle('theme-dark', normalized === 'dark');
    }

    function updateThemeButton(button, theme) {
        const isDark = theme === 'dark';
        button.textContent = isDark ? '☀️ Светлая тема' : '🌙 Тёмная тема';
        button.setAttribute('aria-pressed', String(isDark));
    }

    function toggleButtons(enabled) {
        document.getElementById('btn-run-duplicates').disabled = !enabled;
        document.getElementById('btn-export-duplicates').disabled = !enabled;
        document.getElementById('btn-run-search').disabled = !enabled;
        document.getElementById('btn-export-search').disabled = !enabled;
        const tagButtons = [
            'btn-run-tags',
            'btn-export-tags-csv',
            'btn-export-tags-json'
        ];
        tagButtons.forEach((id) => {
            const node = document.getElementById(id);
            if (node) node.disabled = !enabled;
        });
    }

    async function readFileAsText(file) {
        const buffer = await file.arrayBuffer();
        const decoder = new TextDecoder('windows-1251');
        return decoder.decode(buffer);
    }

    function detectDelimiter(text) {
        const candidates = [';', ',', '\t', '|'];
        const sample = extractSample(text, 250);
        let best = candidates[0];
        let bestScore = -Infinity;

        for (const delimiter of candidates) {
            const parsed = parseCsv(sample, { delimiter, header: false, skipEmptyLines: true });
            if (!parsed.data || !parsed.data.length) continue;
            const lengths = parsed.data
                .map((row) => (Array.isArray(row) ? row.length : Object.keys(row || {}).length))
                .filter((length) => length > 1);
            if (!lengths.length) continue;
            const stats = getLengthStats(lengths);
            const score = stats.consistency * 1000 + stats.modeLength;
            if (score > bestScore) {
                bestScore = score;
                best = delimiter;
            }
        }

        return best;
    }

    function extractSample(text, maxRows) {
        let inQuotes = false;
        let rows = 0;
        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            if (char === '"') {
                if (inQuotes && text[i + 1] === '"') {
                    i += 1;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (!inQuotes && (char === '\n' || char === '\r')) {
                rows += 1;
                if (rows >= maxRows) {
                    return text.slice(0, i);
                }
                if (char === '\r' && text[i + 1] === '\n') {
                    i += 1;
                }
            }
        }
        return text;
    }

    function getLengthStats(lengths) {
        const counts = new Map();
        lengths.forEach((length) => {
            counts.set(length, (counts.get(length) || 0) + 1);
        });
        let modeLength = 0;
        let modeCount = 0;
        counts.forEach((count, length) => {
            if (count > modeCount) {
                modeLength = length;
                modeCount = count;
            }
        });
        const consistency = modeCount / lengths.length;
        return { modeLength, consistency };
    }

    function parseCsv(text, options) {
        const opts = options || {};
        const delimiter = opts.delimiter != null ? opts.delimiter : ',';
        const skipEmptyLines = Boolean(opts.skipEmptyLines);
        const header = Boolean(opts.header);
        const rows = [];
        const delimiterLength = delimiter.length;
        let field = '';
        let row = [];
        let inQuotes = false;

        const pushField = () => {
            row.push(field);
            field = '';
        };

        const pushRow = () => {
            const isEmpty = row.every((value) => {
                const str = value == null ? '' : String(value);
                return str.trim().length === 0;
            });
            if (!(skipEmptyLines && isEmpty)) {
                rows.push(row.slice());
            }
            row = [];
        };

        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            if (char === '"') {
                if (inQuotes && text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }

            if (!inQuotes) {
                if (
                    (delimiterLength === 1 && char === delimiter) ||
                    (delimiterLength > 1 && text.slice(i, i + delimiterLength) === delimiter)
                ) {
                    pushField();
                    if (delimiterLength > 1) {
                        i += delimiterLength - 1;
                    }
                    continue;
                }

                if (char === '\n' || char === '\r') {
                    pushField();
                    pushRow();
                    if (char === '\r' && text[i + 1] === '\n') {
                        i += 1;
                    }
                    continue;
                }
            }

            field += char;
        }

        pushField();
        pushRow();

        if (!rows.length) {
            return { data: [], meta: { fields: header ? [] : null } };
        }

        if (!header) {
            return { data: rows, meta: { fields: null } };
        }

        const headers = rows[0].map((item) => (item == null ? '' : String(item).trim()));
        const dataRows = rows.slice(1).map((columns) => {
            const entry = {};
            headers.forEach((key, index) => {
                const value = columns[index] != null ? columns[index] : '';
                entry[key] = typeof value === 'string' ? value.trim() : value;
            });
            return entry;
        });

        return { data: dataRows, meta: { fields: headers } };
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
            'Контактное лицо': 'contact',
            'Пользователь': 'requester',
            Сервис: 'service',
            Теги: 'tags',
            'Тэги': 'tags'
        };
        const normalized = {};
        for (const column of columns) {
            if (!Object.prototype.hasOwnProperty.call(mapping, column)) continue;
            const key = mapping[column];
            const rawValue = row[column];
            const cleaned = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
            normalized[key] = cleaned != null ? cleaned : '';
        }
        normalized.title = normalized.title || '';
        normalized.description = normalized.description || '';
        normalized.createdAt = normalized.createdAt || '';
        normalized.id = normalized.id || '';
        normalized.priority = normalized.priority || '';
        normalized.sla = normalized.sla || '';
        normalized.contact = normalized.contact || '';
        normalized.requester = normalized.requester || '';
        normalized.service = normalized.service || '';
        normalized.tags = normalized.tags || '';
        normalized._raw = row;
        normalized._searchBlob = [
            normalized.id,
            normalized.author,
            normalized.contact,
            normalized.requester,
            normalized.title,
            normalized.description,
            normalized.service,
            normalized.tags
        ]
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
            const controlId = group + '-' + desc.key;
            label.htmlFor = controlId;
            if (desc.type === 'textarea') {
                control = document.createElement('textarea');
                var storedText = getSettingValue(group, desc.key);
                var fallbackText = desc.defaultValue != null ? desc.defaultValue : '';
                control.value = storedText != null ? storedText : fallbackText;
            } else {
                control = document.createElement('input');
                control.type = desc.type || 'text';
                if (desc.type === 'checkbox') {
                    const value = getSettingValue(group, desc.key);
                    control.checked = value !== undefined ? Boolean(value) : Boolean(desc.defaultValue);
                } else {
                    var storedValue = getSettingValue(group, desc.key);
                    var fallbackValue = desc.defaultValue != null ? desc.defaultValue : '';
                    control.value = storedValue != null ? storedValue : fallbackValue;
                }
                if (desc.step) control.step = String(desc.step);
                if (desc.min !== undefined) control.min = String(desc.min);
                if (desc.max !== undefined) control.max = String(desc.max);
            }
            control.id = controlId;
            control.dataset.settingKey = desc.key;
            control.dataset.settingGroup = group;
            control.addEventListener('change', (event) => {
                let newValue;
                if (desc.type === 'checkbox') {
                    newValue = event.target.checked;
                } else {
                    newValue = event.target.value;
                    if (desc.type === 'number') {
                        newValue = Number(newValue);
                    }
                }
                updateSetting(group, desc.key, newValue);
            });
            wrapper.appendChild(label);
            wrapper.appendChild(control);
            container.appendChild(wrapper);
        });
    }

    function getSettingValue(group, key) {
        if (!state.settings) return undefined;
        const groupData = state.settings[group];
        if (!groupData) return undefined;
        return groupData[key];
    }

    window.AppCore = {
        init,
        getRecords,
        getSettings,
        updateSetting,
        replaceGroup,
        mountSettings,
        getSettingValue,
        applyTheme
    };

    document.addEventListener('DOMContentLoaded', init);
})();
