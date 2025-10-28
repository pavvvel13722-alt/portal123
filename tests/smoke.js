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
const CoreShared = require('../js/app.core.shared.js');

const csvPath = path.join(__dirname, '..', 'tickets_sample_100_same_author.csv');
const csvText = fs.readFileSync(csvPath, 'utf8');
const parsed = CoreShared.autoParseCsv(csvText);
const records = parsed.data.map(function (row) {
    return CoreShared.normalizeRow(row, parsed.meta.fields);
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

const malformedCsv = '\\uFEFFID;Название;Описание\n1;"Тест";"Первая строка без закрытия"\n2;"Вторая";"Запись"\n';
const parsedMalformed = CoreShared.autoParseCsv(malformedCsv);
if (!parsedMalformed.meta || !parsedMalformed.meta.fields || parsedMalformed.meta.fields.length < 3) {
    throw new Error('Malformed CSV headers collapsed');
}
if (parsedMalformed.data.length !== 2) {
    throw new Error('Malformed CSV row count mismatch');
}
const reconstructed = CoreShared.normalizeRow(parsedMalformed.data[0], parsedMalformed.meta.fields);
if (!reconstructed.title || reconstructed.title.indexOf('Тест') === -1) {
    throw new Error('Malformed CSV normalization failed to recover title');
}

const multilineCsv = '\uFEFFID;Описание\n1;"Первая строка"\n2;"Описание с переводом строки\nво второй строке"\n3;"Третья"\n';
const parsedMultiline = CoreShared.autoParseCsv(multilineCsv);
if (!parsedMultiline.meta || !parsedMultiline.meta.fields || parsedMultiline.meta.fields.length < 2) {
    throw new Error('Multiline CSV headers collapsed');
}
if (parsedMultiline.data.length !== 3) {
    throw new Error('Multiline CSV row count mismatch');
}
var secondRow = CoreShared.normalizeRow(parsedMultiline.data[1], parsedMultiline.meta.fields);
if (!secondRow.description || secondRow.description.indexOf('второй строке') === -1) {
    throw new Error('Multiline CSV description was truncated');
}

console.log('Duplicate clusters:', duplicateResult.clusters.length);
console.log('Template with tags:', nonEmptyTemplate.template, 'tags', nonEmptyTemplate.tags.length);
