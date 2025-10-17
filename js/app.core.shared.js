(function (global) {
    var HEADER_KEY_MAP = {
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

    function scoreDecodedText(text) {
        if (!text) return -Infinity;
        var cyrCount = 0;
        var replaceCount = 0;
        var highLatinCount = 0;
        for (var i = 0; i < text.length; i += 1) {
            var code = text.charCodeAt(i);
            if ((code >= 0x0410 && code <= 0x044f) || code === 0x0401 || code === 0x0451) {
                cyrCount += 1;
                continue;
            }
            if (code === 0xfffd) {
                replaceCount += 1;
                continue;
            }
            if (code >= 0x00c0 && code <= 0x00ff) {
                highLatinCount += 1;
            }
        }
        return cyrCount * 2 - replaceCount * 5 - highLatinCount;
    }

    function extractSample(text, maxRows) {
        var inQuotes = false;
        var rows = 0;
        for (var i = 0; i < text.length; i += 1) {
            var char = text[i];
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
        var counts = new Map();
        lengths.forEach(function (length) {
            counts.set(length, (counts.get(length) || 0) + 1);
        });
        var modeLength = 0;
        var modeCount = 0;
        counts.forEach(function (count, length) {
            if (count > modeCount) {
                modeLength = length;
                modeCount = count;
            }
        });
        var consistency = lengths.length ? modeCount / lengths.length : 0;
        return { modeLength: modeLength, consistency: consistency };
    }

    function parseCsv(text, options) {
        var opts = options || {};
        var delimiter = opts.delimiter != null ? opts.delimiter : ',';
        var skipEmptyLines = Boolean(opts.skipEmptyLines);
        var header = Boolean(opts.header);
        var rows = [];
        var delimiterLength = delimiter.length;
        var field = '';
        var row = [];
        var inQuotes = false;

        function pushField() {
            row.push(field);
            field = '';
        }

        function pushRow() {
            var isEmpty = row.every(function (value) {
                var str = value == null ? '' : String(value);
                return str.trim().length === 0;
            });
            if (!(skipEmptyLines && isEmpty)) {
                rows.push(row.slice());
            }
            row = [];
        }

        for (var i = 0; i < text.length; i += 1) {
            var char = text[i];
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

        var headers = rows[0].map(function (item) {
            return item == null ? '' : String(item).trim();
        });
        var dataRows = rows.slice(1).map(function (columns) {
            var entry = {};
            headers.forEach(function (key, index) {
                var value = columns[index] != null ? columns[index] : '';
                entry[key] = typeof value === 'string' ? value.trim() : value;
            });
            return entry;
        });

        return { data: dataRows, meta: { fields: headers } };
    }

    function detectDelimiter(text) {
        var candidates = [';', ',', '\t', '|'];
        var sample = extractSample(text, 250);
        var best = candidates[0];
        var bestScore = -Infinity;
        for (var i = 0; i < candidates.length; i += 1) {
            var delimiter = candidates[i];
            var parsed = parseCsv(sample, { delimiter: delimiter, header: false, skipEmptyLines: true });
            if (!parsed.data || !parsed.data.length) continue;
            var lengths = parsed.data
                .map(function (row) {
                    return Array.isArray(row) ? row.length : Object.keys(row || {}).length;
                })
                .filter(function (length) { return length > 1; });
            if (!lengths.length) continue;
            var stats = getLengthStats(lengths);
            var score = stats.consistency * 1000 + stats.modeLength;
            if (score > bestScore) {
                bestScore = score;
                best = delimiter;
            }
        }
        return best;
    }

    function normalizeHeaderKey(value) {
        if (value == null) return '';
        var text = String(value);
        var result = '';
        var lastSpace = false;
        for (var i = 0; i < text.length; i += 1) {
            var code = text.charCodeAt(i);
            if (code === 0xfeff) {
                continue;
            }
            var ch = text[i];
            if (ch === '\u00A0') {
                ch = ' ';
            }
            if (ch === 'ё') {
                ch = 'е';
            } else if (ch === 'Ё') {
                ch = 'Е';
            }
            var lower = ch.toLowerCase();
            var lowerCode = lower.charCodeAt(0);
            var isLatin = lowerCode >= 97 && lowerCode <= 122;
            var isDigit = lowerCode >= 48 && lowerCode <= 57;
            var isCyr = lowerCode >= 1072 && lowerCode <= 1103;
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
        if (HEADER_KEY_MAP[canonical]) {
            return HEADER_KEY_MAP[canonical];
        }
        if (canonical.indexOf('автор') !== -1 || canonical.indexOf('инициатор') !== -1) {
            return 'author';
        }
        if (canonical.indexOf('название') !== -1 || canonical.indexOf('тема') !== -1 || canonical.indexOf('шаблон') !== -1) {
            return 'title';
        }
        if (canonical.indexOf('описание') !== -1 || canonical.indexOf('комментарий') !== -1) {
            return 'description';
        }
        if (canonical.indexOf('статус') !== -1) {
            return 'status';
        }
        if (canonical.indexOf('приоритет') !== -1) {
            return 'priority';
        }
        if (canonical.indexOf('sla') !== -1 || canonical.indexOf('slm') !== -1) {
            return 'sla';
        }
        if (canonical.indexOf('норматив') !== -1 || canonical.indexOf('дедлайн') !== -1 || canonical.indexOf('срок') !== -1) {
            return 'dueAt';
        }
        if (canonical.indexOf('создан') !== -1 || canonical.indexOf('дата открытия') !== -1 || canonical.indexOf('зарегистр') !== -1) {
            return 'createdAt';
        }
        if (canonical.indexOf('контакт') !== -1 || canonical.indexOf('ответственный') !== -1) {
            return 'contact';
        }
        if (canonical.indexOf('пользователь') !== -1 || canonical.indexOf('заявитель') !== -1 || canonical.indexOf('податель') !== -1) {
            return 'requester';
        }
        if (canonical.indexOf('тег') !== -1 || canonical.indexOf('метка') !== -1) {
            return 'tags';
        }
        if (canonical.indexOf('сервис') !== -1 || canonical.indexOf('услуга') !== -1) {
            return 'service';
        }
        return '';
    }

    function buildSearchBlob(record) {
        return [
            record.id,
            record.author,
            record.contact,
            record.requester,
            record.title,
            record.description,
            record.service,
            record.tags
        ]
            .filter(Boolean)
            .join(' \n ')
            .toLowerCase();
    }

    function normalizeRow(row, columns) {
        var normalized = {};
        var seenKeys = {};
        for (var i = 0; i < columns.length; i += 1) {
            var column = columns[i];
            var canonical = normalizeHeaderKey(column);
            if (!canonical) continue;
            var key = mapCanonicalHeader(canonical);
            if (!key || seenKeys[key]) continue;
            seenKeys[key] = true;
            var rawValue = row[column];
            var cleaned = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
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
        normalized._raw = row;
        normalized._searchBlob = buildSearchBlob(normalized);
        return normalized;
    }

    var api = {
        HEADER_KEY_MAP: HEADER_KEY_MAP,
        scoreDecodedText: scoreDecodedText,
        extractSample: extractSample,
        getLengthStats: getLengthStats,
        parseCsv: parseCsv,
        detectDelimiter: detectDelimiter,
        normalizeHeaderKey: normalizeHeaderKey,
        mapCanonicalHeader: mapCanonicalHeader,
        normalizeRow: normalizeRow
    };

    global.AppCoreShared = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
