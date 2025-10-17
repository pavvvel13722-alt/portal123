const fs = require('fs');
const path = require('path');

if (typeof global.self === 'undefined') {
    global.self = global;
}
if (typeof global.window === 'undefined') {
    global.window = global;
}

const createDuplicateEngine = require('../js/app.dups.engine.js');
const createTagEngine = require('../js/app.tags.engine.js');

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
    const pushField = function () {
        row.push(field);
        field = '';
    };
    const pushRow = function () {
        const isEmpty = row.every(function (value) {
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
            if ((delimiterLength === 1 && char === delimiter) || (delimiterLength > 1 && text.slice(i, i + delimiterLength) === delimiter)) {
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
    const headers = rows[0].map(function (item) {
        return item == null ? '' : String(item).trim();
    });
    const dataRows = rows.slice(1).map(function (columns) {
        const entry = {};
        headers.forEach(function (key, index) {
            const value = columns[index] != null ? columns[index] : '';
            entry[key] = typeof value === 'string' ? value.trim() : value;
        });
        return entry;
    });
    return { data: dataRows, meta: { fields: headers } };
}

const HEADER_KEY_MAP = {
    'id': 'id',
    'номер обращения': 'id',
    'автор': 'author',
    'автор обращения': 'author',
    'автор заявки': 'author',
    'инициатор': 'author',
    'название': 'title',
    'тема': 'title',
    'описание': 'description',
    'статус': 'status',
    'приоритет': 'priority',
    'создано': 'createdAt',
    'дата создания': 'createdAt',
    'нормативный срок': 'dueAt',
    'дедлайн': 'dueAt',
    'sla индикатор': 'sla',
    'slm индикатор': 'sla',
    'slm-индикатор': 'sla',
    'sla': 'sla',
    'slm': 'sla',
    'контактное лицо': 'contact',
    'контакт': 'contact',
    'пользователь': 'requester',
    'инициатор обращения': 'requester',
    'заявитель': 'requester',
    'сервис': 'service',
    'теги': 'tags',
    'тэги': 'tags'
};

function normalizeHeaderKey(value) {
    if (value == null) return '';
    let text = String(value);
    let result = '';
    let lastSpace = false;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 0xfeff) {
            continue;
        }
        let ch = text[i];
        if (ch === '\u00A0') {
            ch = ' ';
        }
        if (ch === 'ё') {
            ch = 'е';
        } else if (ch === 'Ё') {
            ch = 'Е';
        }
        const lower = ch.toLowerCase();
        const lowerCode = lower.charCodeAt(0);
        const isLatin = lowerCode >= 97 && lowerCode <= 122;
        const isDigit = lowerCode >= 48 && lowerCode <= 57;
        const isCyr = lowerCode >= 1072 && lowerCode <= 1103;
        if (isLatin || isDigit || isCyr) {
            result += lower;
            lastSpace = false;
        } else {
            if (!lastSpace && result.length) {
                result += ' ';
                lastSpace = true;
            }
        }
    }
    return result.trim().replace(/\s+/g, ' ');
}

function mapCanonicalHeader(canonical) {
    if (!canonical) return '';
    if (HEADER_KEY_MAP[canonical]) return HEADER_KEY_MAP[canonical];
    if (canonical.indexOf('автор') !== -1 || canonical.indexOf('инициатор') !== -1) return 'author';
    if (canonical.indexOf('название') !== -1 || canonical.indexOf('тема') !== -1 || canonical.indexOf('шаблон') !== -1) return 'title';
    if (canonical.indexOf('описание') !== -1 || canonical.indexOf('комментарий') !== -1) return 'description';
    if (canonical.indexOf('статус') !== -1) return 'status';
    if (canonical.indexOf('приоритет') !== -1) return 'priority';
    if (canonical.indexOf('sla') !== -1 || canonical.indexOf('slm') !== -1) return 'sla';
    if (canonical.indexOf('норматив') !== -1 || canonical.indexOf('дедлайн') !== -1 || canonical.indexOf('срок') !== -1) return 'dueAt';
    if (canonical.indexOf('создан') !== -1 || canonical.indexOf('дата открытия') !== -1 || canonical.indexOf('зарегистр') !== -1) return 'createdAt';
    if (canonical.indexOf('контакт') !== -1 || canonical.indexOf('ответственный') !== -1) return 'contact';
    if (canonical.indexOf('пользователь') !== -1 || canonical.indexOf('заявитель') !== -1 || canonical.indexOf('податель') !== -1) return 'requester';
    if (canonical.indexOf('тег') !== -1 || canonical.indexOf('метка') !== -1) return 'tags';
    if (canonical.indexOf('сервис') !== -1 || canonical.indexOf('услуга') !== -1) return 'service';
    return '';
}

function normalizeRow(row, columns) {
    const normalized = {};
    const seenKeys = {};
    for (let i = 0; i < columns.length; i += 1) {
        const column = columns[i];
        const canonical = normalizeHeaderKey(column);
        if (!canonical) continue;
        const key = mapCanonicalHeader(canonical);
        if (!key || seenKeys[key]) continue;
        seenKeys[key] = true;
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
    if (!normalized.author) {
        if (normalized.requester) {
            normalized.author = normalized.requester;
        } else if (normalized.contact) {
            normalized.author = normalized.contact;
        }
    }
    return normalized;
}

const csvPath = path.join(__dirname, '..', 'tickets_sample_100_same_author.csv');
const csvText = fs.readFileSync(csvPath, 'utf8');
const parsed = parseCsv(csvText, { delimiter: ';', header: true, skipEmptyLines: true });
const records = parsed.data.map(function (row) {
    return normalizeRow(row, parsed.meta.fields);
});

if (!records.length) {
    throw new Error('Sample CSV produced no records');
}

const duplicateRecords = records.map(function (record) {
    return {
        id: record.id,
        author: record.author,
        requester: record.requester,
        contact: record.contact,
        description: record.description,
        createdAt: record.createdAt,
        priority: record.priority,
        status: record.status,
        sla: record.sla,
        dueAt: record.dueAt
    };
});

const duplicateEngine = createDuplicateEngine();
const duplicateSettings = {
    smartThreshold: true,
    thresholdShort: 0.8,
    thresholdMedium: 0.7,
    thresholdLong: 0.62,
    baseThreshold: 0.62,
    timeGuardEnabled: true,
    timeGuardDays: 14,
    stopPhrases: ''
};
const duplicateResult = duplicateEngine.analyze(duplicateRecords, duplicateSettings);
if (!duplicateResult.clusters || !duplicateResult.clusters.length) {
    throw new Error('Duplicate analysis returned no clusters');
}

const tagEngine = createTagEngine();
const tagSettings = {
    stopPhrases: 'добрый день\nздравствуйте\nспасибо\nс уважением\nпрошу помочь',
    stopTokens: 'ошибка\nпроблема\nсистема\nсообщает\nпросит\nнужно',
    domainTokens: 'vpn\nvrm\nrdp\nmstsc\nnla\ncredssp\nсертификат\ncrypto pro\nкриптопро\nудалённый\nудаленный\ngateway',
    lenBoost1: 1,
    lenBoost2: 1.25,
    lenBoost3: 1.45,
    domainBoost: 1.15,
    coverageThreshold: 0.7
};
const tagPayload = {
    records: records.map(function (record) {
        return {
            title: record.title,
            status: record.status,
            description: record.description
        };
    }),
    templates: [],
    statuses: [],
    params: {
        minFrequency: 3,
        minTokenLength: 2,
        topN: 25,
        ngramSizes: [1, 2, 3]
    },
    settings: tagSettings
};
const tagResult = tagEngine.extract(tagPayload);
if (!tagResult || !tagResult.templates || !tagResult.templates.length) {
    throw new Error('Tag extraction returned no templates');
}
const nonEmptyTemplate = tagResult.templates.find(function (template) {
    return template.tags && template.tags.length;
});
if (!nonEmptyTemplate) {
    throw new Error('Tag extraction returned no tags');
}

console.log('Duplicate clusters:', duplicateResult.clusters.length);
console.log('Template with tags:', nonEmptyTemplate.template, 'tags', nonEmptyTemplate.tags.length);
