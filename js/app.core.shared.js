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

    function getPapaParser() {
        if (global.Papa && typeof global.Papa.parse === 'function') {
            return global.Papa;
        }
        if (typeof Papa !== 'undefined' && Papa && typeof Papa.parse === 'function') {
            return Papa;
        }
        if (typeof require === 'function') {
            try {
                var papaLocal = require('./vendor/papaparse.min.js');
                if (papaLocal && typeof papaLocal.parse === 'function') {
                    return papaLocal;
                }
            } catch (errLocal) {
                if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
                    console.warn('Не удалось загрузить papaparse.min.js из локального каталога', errLocal);
                }
            }
            try {
                var papaParent = require('../vendor/papaparse.min.js');
                if (papaParent && typeof papaParent.parse === 'function') {
                    return papaParent;
                }
            } catch (errParent) {
                if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
                    console.warn('Не удалось загрузить papaparse.min.js из родительского каталога', errParent);
                }
            }
        }
        return null;
    }

    function parseCsv(text, options) {
        var opts = options || {};
        var delimiter = opts.delimiter != null ? opts.delimiter : ',';
        var skipEmptyLines = Boolean(opts.skipEmptyLines);
        var header = Boolean(opts.header);
        var papa = getPapaParser();
        if (papa) {
            try {
                var result = papa.parse(text, {
                    delimiter: delimiter,
                    skipEmptyLines: skipEmptyLines,
                    header: header
                });
                if (result && result.data && result.data.length) {
                    if (!header) {
                        if (!Array.isArray(result.data[0])) {
                            var firstField = result.data[0];
                            if (firstField && typeof firstField === 'object') {
                                var soleKey = Object.keys(firstField)[0];
                                if (soleKey && typeof firstField[soleKey] === 'string' && firstField[soleKey].indexOf(delimiter) !== -1) {
                                    throw new Error('PapaParse produced unsplit rows');
                                }
                            }
                        }
                        return { data: result.data, meta: { fields: null } };
                    }
                    var fields = [];
                    if (result.meta && Array.isArray(result.meta.fields) && result.meta.fields.length) {
                        fields = result.meta.fields.slice();
                    } else {
                        var firstRow = result.data[0];
                        for (var prop in firstRow) {
                            if (Object.prototype.hasOwnProperty.call(firstRow, prop)) {
                                fields.push(prop);
                            }
                        }
                    }
                    if (fields.length <= 1) {
                        var arrayResult = papa.parse(text, {
                            delimiter: delimiter,
                            skipEmptyLines: skipEmptyLines,
                            header: false
                        });
                        if (arrayResult && Array.isArray(arrayResult.data) && arrayResult.data.length > 1 && Array.isArray(arrayResult.data[0])) {
                            var headerRow = arrayResult.data[0].map(function (cell) {
                                return cell == null ? '' : String(cell).trim();
                            });
                            var rebuiltRows = [];
                            for (var r = 1; r < arrayResult.data.length; r += 1) {
                                var rowArray = arrayResult.data[r];
                                if (!rowArray || !rowArray.length) continue;
                                var entry = {};
                                for (var c = 0; c < headerRow.length; c += 1) {
                                    var headerKey = headerRow[c];
                                    if (!headerKey) continue;
                                    var cellValue = rowArray[c];
                                    entry[headerKey] = typeof cellValue === 'string' ? cellValue.trim() : cellValue;
                                }
                                rebuiltRows.push(entry);
                            }
                            if (headerRow.length > 1 && rebuiltRows.length) {
                                return { data: rebuiltRows, meta: { fields: headerRow } };
                            }
                        }
                        throw new Error('PapaParse header collapsed into single column');
                    }
                    var normalizedRows = result.data.map(function (row) {
                        var entry = {};
                        for (var index = 0; index < fields.length; index += 1) {
                            var key = fields[index];
                            var value = row[key];
                            entry[key] = typeof value === 'string' ? value.trim() : value;
                        }
                        return entry;
                    });
                    return { data: normalizedRows, meta: { fields: fields } };
                }
            } catch (errPapa) {
                if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
                    console.warn('Papa.parse не смог обработать CSV, используется резервный парсер', errPapa);
                }
            }
        }
        return parseCsvManual(text, delimiter, header, skipEmptyLines);
    }

    function looksLikeRowStart(text, startIndex, delimiter, delimiterLength) {
        var index = startIndex;
        var limit = Math.min(text.length, index + 128);
        var sample = '';
        while (index < limit) {
            var ch = text.charAt(index);
            if (ch === '\r' || ch === '\n') {
                break;
            }
            sample += ch;
            index += 1;
        }
        if (!sample) {
            return false;
        }
        sample = sample.replace(/^[ \t]+/, '');
        if (!sample) {
            return false;
        }
        var delimiterIndex;
        if (delimiterLength === 1) {
            delimiterIndex = sample.indexOf(delimiter);
        } else {
            delimiterIndex = sample.indexOf(delimiter);
        }
        if (delimiterIndex === -1 || delimiterIndex > 64) {
            return false;
        }
        var prefix = sample.slice(0, delimiterIndex);
        if (!prefix) {
            return false;
        }
        if (!/^[0-9a-zA-Zа-яА-Я_ \-\[\]\(\)#\/]+$/.test(prefix)) {
            return false;
        }
        return true;
    }

    function shouldForceCloseQuote(text, position, delimiter, delimiterLength) {
        var index = position + 1;
        if (text.charAt(position) === '\r' && text.charAt(index) === '\n') {
            index += 1;
        }
        while (index < text.length) {
            var ch = text.charAt(index);
            if (ch !== ' ' && ch !== '\t') {
                break;
            }
            index += 1;
        }
        if (index >= text.length) {
            return true;
        }
        if (looksLikeRowStart(text, index, delimiter, delimiterLength)) {
            return true;
        }
        return false;
    }

    function parseCsvManual(text, delimiter, header, skipEmptyLines) {
        var rows = [];
        var delimiterLength = delimiter.length;
        var field = '';
        var fieldOnlyWhitespace = true;
        var row = [];
        var inQuotes = false;

        function pushField() {
            row.push(field);
            field = '';
            fieldOnlyWhitespace = true;
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

        for (var index = 0; index < text.length; index += 1) {
            var char = text[index];
            if (char === '"') {
                if (inQuotes) {
                    if (text[index + 1] === '"') {
                        field += '"';
                        fieldOnlyWhitespace = false;
                        index += 1;
                        continue;
                    }
                    var lookaheadIndex = index + 1;
                    while (lookaheadIndex < text.length) {
                        var lookaheadChar = text[lookaheadIndex];
                        if (lookaheadChar === ' ' || lookaheadChar === '\t') {
                            lookaheadIndex += 1;
                            continue;
                        }
                        break;
                    }
                    var nextChar = lookaheadIndex < text.length ? text[lookaheadIndex] : null;
                    var shouldClose = nextChar === null || nextChar === '\r' || nextChar === '\n';
                    if (!shouldClose) {
                        if (delimiterLength === 1) {
                            shouldClose = nextChar === delimiter;
                        } else if (
                            lookaheadIndex + delimiterLength <= text.length &&
                            text.slice(lookaheadIndex, lookaheadIndex + delimiterLength) === delimiter
                        ) {
                            shouldClose = true;
                        }
                    }
                    if (shouldClose) {
                        inQuotes = false;
                        continue;
                    }
                    field += '"';
                    fieldOnlyWhitespace = false;
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
                } else {
                    field += '"';
                    fieldOnlyWhitespace = false;
                }
                continue;
            }
            if ((char === '\n' || char === '\r') && inQuotes) {
                if (!shouldForceCloseQuote(text, index, delimiter, delimiterLength)) {
                    field += char;
                    fieldOnlyWhitespace = false;
                    continue;
                }
                inQuotes = false;
                pushField();
                pushRow();
                if (char === '\r' && text[index + 1] === '\n') {
                    index += 1;
                }
                continue;
            }
            if (!inQuotes) {
                if ((delimiterLength === 1 && char === delimiter) || (delimiterLength > 1 && text.slice(index, index + delimiterLength) === delimiter)) {
                    pushField();
                    if (delimiterLength > 1) {
                        index += delimiterLength - 1;
                    }
                    continue;
                }
                if (char === '\n' || char === '\r') {
                    pushField();
                    pushRow();
                    if (char === '\r' && text[index + 1] === '\n') {
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

        var expectedLength = rows[0] ? rows[0].length : 0;
        if (expectedLength > 1 && rows.length > 1) {
            var mismatch = 0;
            for (var r = 1; r < rows.length; r += 1) {
                if (rows[r].length !== expectedLength) {
                    mismatch += 1;
                }
            }
            var tolerance = Math.max(3, Math.floor(rows.length * 0.01));
            if (mismatch > tolerance) {
                return parseCsvLoose(text, delimiter, header, skipEmptyLines);
            }
        }

        if (!header) {
            return { data: rows, meta: { fields: null } };
        }

        var headers = rows[0].map(function (item) {
            return item == null ? '' : String(item).trim();
        });
        var dataRows = rows.slice(1).map(function (columns) {
            var entry = {};
            headers.forEach(function (key, idx) {
                var value = columns[idx] != null ? columns[idx] : '';
                entry[key] = typeof value === 'string' ? value.trim() : value;
            });
            return entry;
        });

        return { data: dataRows, meta: { fields: headers } };
    }

    function parseCsvLoose(text, delimiter, header, skipEmptyLines) {
        var normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = normalized.split('\n');
        var rows = [];
        var delimiterLength = delimiter.length;

        function splitLine(line) {
            var columns = [];
            if (delimiterLength === 0) {
                columns.push(line);
                return columns;
            }
            var start = 0;
            while (start <= line.length) {
                var index = line.indexOf(delimiter, start);
                if (index === -1) {
                    columns.push(line.slice(start));
                    break;
                }
                columns.push(line.slice(start, index));
                start = index + delimiterLength;
            }
            return columns;
        }

        function cleanCell(value) {
            if (value == null) return '';
            var text = String(value);
            if (text.length >= 2 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') {
                text = text.slice(1, text.length - 1).replace(/""/g, '"');
            }
            return text.trim();
        }

        for (var i = 0; i < lines.length; i += 1) {
            var line = lines[i];
            if (skipEmptyLines && (!line || line.trim() === '')) {
                continue;
            }
            var parts = splitLine(line);
            for (var p = 0; p < parts.length; p += 1) {
                parts[p] = cleanCell(parts[p]);
            }
            rows.push(parts);
        }

        if (!rows.length) {
            return { data: [], meta: { fields: header ? [] : null } };
        }

        if (!header) {
            return { data: rows, meta: { fields: null } };
        }

        var headers = rows[0].map(function (cell) { return cleanCell(cell); });
        var resultRows = [];
        for (var rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
            var rowParts = rows[rowIndex];
            if (!rowParts || (!rowParts.length && skipEmptyLines)) continue;
            var entry = {};
            for (var col = 0; col < headers.length; col += 1) {
                var key = headers[col];
                if (!key) continue;
                var cellValue = rowParts[col] != null ? rowParts[col] : '';
                entry[key] = typeof cellValue === 'string' ? cellValue.trim() : cellValue;
            }
            resultRows.push(entry);
        }

        return { data: resultRows, meta: { fields: headers } };
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
