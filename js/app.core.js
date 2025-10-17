(function () {
    if (window.escapeHtml && window.escapeAttribute) return;
    window.escapeHtml = function (v) {
        v = String(v == null ? '' : v);
        return v.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };
    window.escapeAttribute = function (v) {
        v = String(v == null ? '' : v);
        return v.replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/'/g, '&#39;');
    };
})();

(function () {
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

    const Shared = window.AppCoreShared;
    if (!Shared) {
        throw new Error('AppCoreShared is not available');
    }

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
                const delimiter = Shared.detectDelimiter(text);
                const parsed = Shared.parseCsv(text, { delimiter: delimiter, header: true, skipEmptyLines: true });
                const columns = parsed.meta.fields || [];
                const cleaned = (parsed.data || [])
                    .filter(Boolean)
                    .map(function (row) { return Shared.normalizeRow(row, columns); });
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
        button.textContent = isDark ? 'Светлая тема' : 'Тёмная тема';
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
        return decodeBuffer(buffer);
    }

    function decodeBuffer(buffer) {
        const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const candidates = [];
        let utf8WasValid = false;
        try {
            const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
            const text = strictUtf8.decode(view);
            utf8WasValid = true;
            candidates.push({ encoding: 'utf-8', text, score: Shared.scoreDecodedText(text) + 500 });
        } catch (err) {
            try {
                const relaxedUtf8 = new TextDecoder('utf-8');
                const text = relaxedUtf8.decode(view);
                candidates.push({ encoding: 'utf-8', text, score: Shared.scoreDecodedText(text) });
            } catch (errorUtf8) {
                console.warn('Не удалось декодировать как UTF-8', errorUtf8);
            }
        }
        try {
            const winDecoder = new TextDecoder('windows-1251');
            const winText = winDecoder.decode(view);
            const bonus = utf8WasValid ? -500 : 0;
            candidates.push({ encoding: 'windows-1251', text: winText, score: Shared.scoreDecodedText(winText) + bonus });
        } catch (err) {
            console.warn('Не удалось декодировать как Windows-1251', err);
        }
        if (!candidates.length) {
            return '';
        }
        candidates.sort(function (a, b) {
            if (a.score === b.score) return 0;
            return a.score > b.score ? -1 : 1;
        });
        return candidates[0].text;
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
