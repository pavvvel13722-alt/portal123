(function (global) {
    var PapaParser = null;
    if (global && global.Papa) {
        PapaParser = global.Papa;
    } else if (typeof require === 'function') {
        try {
            PapaParser = require('./vendor/papaparse.min.js');
        } catch (err) {
            try {
                PapaParser = require('../js/vendor/papaparse.min.js');
            } catch (errNested) {
                PapaParser = null;
            }
        }
    }

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
        var delimiter = opts.delimiter != null ? String(opts.delimiter) : ',';
        if (!delimiter) {
            delimiter = ',';
        }
        var header = Boolean(opts.header);
        var skipEmptyLines = Boolean(opts.skipEmptyLines);

        var input = text == null ? '' : String(text);
        if (!input) {
            return { data: [], meta: { fields: header ? [] : null } };
        }
        if (input.charCodeAt(0) === 0xfeff) {
            input = input.slice(1);
        }

        var rows = [];
        var row = [];
        var field = '';
        var fieldOnlyWhitespace = true;
        var inQuotes = false;
        var delimiterLength = delimiter.length;
        if (delimiterLength === 0) {
            delimiterLength = 1;
            delimiter = ',';
        }

        function rowHasContent(columns) {
            for (var i = 0; i < columns.length; i += 1) {
                var value = columns[i];
                if (value != null && String(value).trim() !== '') {
                    return true;
                }
            }
            return false;
        }

        function pushField() {
            row.push(field);
            field = '';
            fieldOnlyWhitespace = true;
        }

        function pushRow() {
            if (skipEmptyLines && !rowHasContent(row)) {
                row = [];
                return;
            }
            rows.push(row.slice());
            row = [];
        }

        for (var index = 0; index < input.length; index += 1) {
            var char = input.charAt(index);
            if (char === '"') {
                if (inQuotes) {
                    if (input.charAt(index + 1) === '"') {
                        field += '"';
                        fieldOnlyWhitespace = false;
                        index += 1;
                        continue;
                    }
                    inQuotes = false;
                    continue;
                }
                if (field.length === 0) {
                    inQuotes = true;
                    continue;
                }
                if (fieldOnlyWhitespace) {
                    field = '';
                    fieldOnlyWhitespace = true;
                    inQuotes = true;
                    continue;
                }
            }
            if (!inQuotes) {
                if ((delimiterLength === 1 && char === delimiter) ||
                    (delimiterLength > 1 && input.slice(index, index + delimiterLength) === delimiter)) {
                    pushField();
                    if (delimiterLength > 1) {
                        index += delimiterLength - 1;
                    }
                    continue;
                }
                if (char === '\r' || char === '\n') {
                    pushField();
                    pushRow();
                    if (char === '\r' && input.charAt(index + 1) === '\n') {
                        index += 1;
                    }
                    continue;
                }
            }
            field += char;
            if (char !== ' ' && char !== '\t') {
                fieldOnlyWhitespace = false;
            }
        }
        pushField();
        pushRow();

        if (!rows.length) {
            return { data: [], meta: { fields: header ? [] : null } };
        }

        if (!header) {
            return { data: rows, meta: { fields: null } };
        }

        var headers = rows[0].map(function (cell) {
            return cell == null ? '' : String(cell).trim();
        });
        var dataRows = [];
        for (var r = 1; r < rows.length; r += 1) {
            var source = rows[r];
            if (skipEmptyLines && (!source || !rowHasContent(source))) {
                continue;
            }
            var entry = {};
            for (var c = 0; c < headers.length; c += 1) {
                var key = headers[c];
                if (!key) {
                    continue;
                }
                var value = source && source[c] != null ? source[c] : '';
                entry[key] = typeof value === 'string' ? value.trim() : value;
            }
            dataRows.push(entry);
        }

        return { data: dataRows, meta: { fields: headers } };
    }

    function scoreParseResult(parsed, delimiter) {
        if (!parsed) return -Infinity;
        var fields = parsed.meta && Array.isArray(parsed.meta.fields) ? parsed.meta.fields : [];
        var data = Array.isArray(parsed.data) ? parsed.data : [];
        var fieldCount = fields.length;
        var lengths = [];
        for (var i = 0; i < data.length; i += 1) {
            var row = data[i];
            if (row && typeof row === 'object') {
                lengths.push(Object.keys(row).length);
            }
        }
        var stats = getLengthStats(lengths);
        var collapsedHeader = false;
        if (fieldCount <= 1 && fields.length) {
            var headerText = String(fields[0] == null ? '' : fields[0]);
            for (var j = 0; j < headerText.length; j += 1) {
                var ch = headerText.charAt(j);
                if (ch === ';' || ch === ',' || ch === '\t' || ch === '|') {
                    collapsedHeader = true;
                    break;
                }
            }
        }
        var consistent = stats.consistency || 0;
        var score = 0;
        if (fieldCount > 1) {
            score += fieldCount * 1000;
        }
        score += data.length;
        score += consistent * 100;
        if (collapsedHeader) {
            score -= 5000;
        }
        if (delimiter === ';') {
            score += 25;
        }
        return score;
    }

    function parseCsvWithPapa(text, delimiter) {
        if (!PapaParser) return null;
        if (!text) {
            return { data: [], meta: { fields: [] } };
        }
        try {
            var result = PapaParser.parse(text, {
                delimiter: delimiter,
                header: true,
                skipEmptyLines: 'greedy',
                transformHeader: function (header) {
                    if (header == null) return '';
                    return String(header).trim();
                }
            });
            if (!result || !result.meta) {
                return null;
            }
            var fields = Array.isArray(result.meta.fields) ? result.meta.fields : [];
            var data = Array.isArray(result.data) ? result.data : [];
            return { data: data, meta: { fields: fields } };
        } catch (err) {
            return null;
        }
    }

    function autoParseCsv(text, options) {
        var input = text == null ? '' : String(text);
        if (!input) {
            return { data: [], meta: { fields: [] }, delimiter: ';' };
        }
        var opts = options || {};
        var delimiterList = Array.isArray(opts.delimiters) && opts.delimiters.length
            ? opts.delimiters.slice()
            : [';', '\t', ',', '|'];
        var best = null;
        var bestScore = -Infinity;

        function considerResult(parsed, delimiter) {
            if (!parsed) return;
            var score = scoreParseResult(parsed, delimiter);
            if (score > bestScore) {
                bestScore = score;
                best = {
                    data: parsed.data || [],
                    meta: parsed.meta || { fields: [] },
                    delimiter: delimiter
                };
            }
        }

        for (var i = 0; i < delimiterList.length; i += 1) {
            var delimiter = delimiterList[i];
            var manual = null;
            try {
                manual = parseCsv(input, { delimiter: delimiter, header: true, skipEmptyLines: true });
            } catch (errManual) {
                manual = null;
            }
            considerResult(manual, delimiter);
            var papa = parseCsvWithPapa(input, delimiter);
            considerResult(papa, delimiter);
        }

        if (!best) {
            best = { data: [], meta: { fields: [] }, delimiter: delimiterList[0] };
        } else if (best.meta && Array.isArray(best.meta.fields) && best.meta.fields.length <= 1) {
            var fallback = parseCsvWithPapa(input, ';');
            if (fallback && fallback.meta && Array.isArray(fallback.meta.fields) && fallback.meta.fields.length > 1) {
                best = {
                    data: fallback.data || [],
                    meta: fallback.meta || { fields: [] },
                    delimiter: ';'
                };
            }
        }
        return best;
    }

    function detectDelimiter(text) {
        if (!text) {
            return ';';
        }
        var candidates = [';', ',', '\t', '|'];
        var sample = extractSample(text, 400);
        var totals = {};
        var rowCounts = {};
        var current = {};
        var i;
        for (i = 0; i < candidates.length; i += 1) {
            var delimiter = candidates[i];
            totals[delimiter] = 0;
            rowCounts[delimiter] = 0;
            current[delimiter] = 0;
        }
        var inQuotes = false;
        var length = sample.length;
        for (var index = 0; index < length; index += 1) {
            var char = sample.charAt(index);
            if (char === '"') {
                if (inQuotes && sample.charAt(index + 1) === '"') {
                    index += 1;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }
            if (!inQuotes) {
                if (char === '\r' || char === '\n') {
                    for (i = 0; i < candidates.length; i += 1) {
                        var delimiterKey = candidates[i];
                        if (current[delimiterKey] > 0) {
                            totals[delimiterKey] += current[delimiterKey];
                            rowCounts[delimiterKey] += 1;
                        }
                        current[delimiterKey] = 0;
                    }
                    if (char === '\r' && sample.charAt(index + 1) === '\n') {
                        index += 1;
                    }
                    continue;
                }
                for (i = 0; i < candidates.length; i += 1) {
                    var candidate = candidates[i];
                    var candidateLength = candidate.length;
                    if (candidateLength === 1) {
                        if (char === candidate) {
                            current[candidate] += 1;
                            break;
                        }
                    } else {
                        if (sample.slice(index, index + candidateLength) === candidate) {
                            current[candidate] += 1;
                            index += candidateLength - 1;
                            break;
                        }
                    }
                }
            }
        }
        for (i = 0; i < candidates.length; i += 1) {
            var lastDelimiter = candidates[i];
            if (current[lastDelimiter] > 0) {
                totals[lastDelimiter] += current[lastDelimiter];
                rowCounts[lastDelimiter] += 1;
            }
        }
        var best = candidates[0];
        var bestScore = -1;
        for (i = 0; i < candidates.length; i += 1) {
            var option = candidates[i];
            var total = totals[option];
            var rows = rowCounts[option];
            if (!total || !rows) {
                continue;
            }
            var score = total / rows;
            if (score > bestScore) {
                bestScore = score;
                best = option;
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
        autoParseCsv: autoParseCsv,
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
