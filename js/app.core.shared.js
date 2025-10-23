(function (global) {
    var PapaParser = null;
    if (global && global.Papa) {
        PapaParser = global.Papa;
    } else if (typeof require === 'function') {
        try {
            PapaParser = require('./vendor/papaparse.min.js');
        } catch (errPrimary) {
            try {
                PapaParser = require('../js/vendor/papaparse.min.js');
            } catch (errSecondary) {
                PapaParser = null;
            }
        }
    }

    var HEADER_KEY_MAP = {
        'id': 'id',
        'номер обращения': 'id',
        'номер': 'id',
        'ticket id': 'id',
        'author': 'author',
        'автор': 'author',
        'автор обращения': 'author',
        'автор заявки': 'author',
        'инициатор': 'author',
        'заявитель': 'author',
        'contact': 'contact',
        'контактное лицо': 'contact',
        'контакт': 'contact',
        'requester': 'requester',
        'пользователь': 'requester',
        'инициатор обращения': 'requester',
        'название': 'title',
        'тема': 'title',
        'title': 'title',
        'subject': 'title',
        'template': 'title',
        'шаблон': 'title',
        'описание': 'description',
        'description': 'description',
        'description details': 'description',
        'статус': 'status',
        'status': 'status',
        'priority': 'priority',
        'приоритет': 'priority',
        'sla индикатор': 'sla',
        'slm индикатор': 'sla',
        'sla': 'sla',
        'slm': 'sla',
        'нормативный срок': 'dueAt',
        'дедлайн': 'dueAt',
        'срок': 'dueAt',
        'created': 'createdAt',
        'created at': 'createdAt',
        'дата создания': 'createdAt',
        'создано': 'createdAt',
        'service': 'service',
        'сервис': 'service',
        'tags': 'tags',
        'теги': 'tags',
        'тэги': 'tags'
    };

    function scoreDecodedText(text) {
        if (!text) return -Infinity;
        var score = 0;
        for (var i = 0; i < text.length; i += 1) {
            var code = text.charCodeAt(i);
            if ((code >= 0x0410 && code <= 0x044f) || code === 0x0401 || code === 0x0451) {
                score += 2;
            } else if (code === 0xfffd) {
                score -= 5;
            } else if (code >= 0x00c0 && code <= 0x00ff) {
                score -= 1;
            }
        }
        return score;
    }

    function extractSample(text, maxRows) {
        if (!text) return '';
        var limit = typeof maxRows === 'number' && maxRows > 0 ? maxRows : 50;
        var inQuotes = false;
        var rows = 0;
        for (var i = 0; i < text.length; i += 1) {
            var ch = text.charAt(i);
            if (ch === '"') {
                if (inQuotes && text.charAt(i + 1) === '"') {
                    i += 1;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
                rows += 1;
                if (rows >= limit) {
                    return text.slice(0, i);
                }
                if (ch === '\r' && text.charAt(i + 1) === '\n') {
                    i += 1;
                }
            }
        }
        return text;
    }

    function getLengthStats(lengths) {
        var counts = {};
        for (var i = 0; i < lengths.length; i += 1) {
            var key = String(lengths[i]);
            counts[key] = (counts[key] || 0) + 1;
        }
        var mode = 0;
        var modeCount = 0;
        for (var value in counts) {
            if (counts[value] > modeCount) {
                mode = Number(value);
                modeCount = counts[value];
            }
        }
        var consistency = lengths.length ? modeCount / lengths.length : 0;
        return { modeLength: mode, consistency: consistency };
    }

    function detectDelimiter(text) {
        if (!text) return ';';
        var sample = extractSample(text, 200);
        var candidates = [';', '\t', ',', '|'];
        var scores = { ';': 0, '\t': 0, ',': 0, '|': 0 };
        var counts = { ';': 0, '\t': 0, ',': 0, '|': 0 };
        var inQuotes = false;
        var current = { ';': 0, '\t': 0, ',': 0, '|': 0 };
        for (var i = 0; i < sample.length; i += 1) {
            var ch = sample.charAt(i);
            if (ch === '"') {
                if (inQuotes && sample.charAt(i + 1) === '"') {
                    i += 1;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }
            if (!inQuotes) {
                if (ch === '\n' || ch === '\r') {
                    for (var j = 0; j < candidates.length; j += 1) {
                        var key = candidates[j];
                        if (current[key] > 0) {
                            scores[key] += current[key];
                            counts[key] += 1;
                            current[key] = 0;
                        }
                    }
                    if (ch === '\r' && sample.charAt(i + 1) === '\n') {
                        i += 1;
                    }
                    continue;
                }
                for (var k = 0; k < candidates.length; k += 1) {
                    var delimiter = candidates[k];
                    if (delimiter.length === 1) {
                        if (ch === delimiter) {
                            current[delimiter] += 1;
                            break;
                        }
                    } else {
                        if (sample.slice(i, i + delimiter.length) === delimiter) {
                            current[delimiter] += 1;
                            i += delimiter.length - 1;
                            break;
                        }
                    }
                }
            }
        }
        for (var m = 0; m < candidates.length; m += 1) {
            var option = candidates[m];
            if (current[option] > 0) {
                scores[option] += current[option];
                counts[option] += 1;
            }
        }
        var best = ';';
        var bestScore = -1;
        for (var n = 0; n < candidates.length; n += 1) {
            var candidate = candidates[n];
            if (!counts[candidate]) continue;
            var avg = scores[candidate] / counts[candidate];
            if (avg > bestScore) {
                bestScore = avg;
                best = candidate;
            }
        }
        return best;
    }

    function parseCsv(text, options) {
        var opts = options || {};
        var delimiter = opts.delimiter != null ? String(opts.delimiter) : ';';
        if (!delimiter) delimiter = ';';
        var header = opts.header !== false;
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
        var inQuotes = false;
        for (var index = 0; index < input.length; index += 1) {
            var char = input.charAt(index);
            if (char === '"') {
                if (inQuotes) {
                    if (input.charAt(index + 1) === '"') {
                        field += '"';
                        index += 1;
                    } else {
                        inQuotes = false;
                    }
                    continue;
                }
                if (!field.length) {
                    inQuotes = true;
                    continue;
                }
            }
            if (!inQuotes) {
                if (char === delimiter) {
                    row.push(field);
                    field = '';
                    continue;
                }
                if (char === '\r' || char === '\n') {
                    row.push(field);
                    field = '';
                    if (!skipEmptyLines || rowHasValue(row)) {
                        rows.push(row);
                    }
                    row = [];
                    if (char === '\r' && input.charAt(index + 1) === '\n') {
                        index += 1;
                    }
                    continue;
                }
            }
            field += char;
        }
        row.push(field);
        if (!skipEmptyLines || rowHasValue(row)) {
            rows.push(row);
        }
        if (!rows.length) {
            return { data: [], meta: { fields: header ? [] : null } };
        }
        if (!header) {
            return { data: rows, meta: { fields: null } };
        }
        var headers = [];
        var first = rows[0];
        for (var h = 0; h < first.length; h += 1) {
            headers.push(first[h] == null ? '' : String(first[h]).trim());
        }
        var data = [];
        for (var r = 1; r < rows.length; r += 1) {
            var source = rows[r];
            if (skipEmptyLines && !rowHasValue(source)) continue;
            var entry = {};
            for (var c = 0; c < headers.length; c += 1) {
                var name = headers[c];
                if (!name) continue;
                var value = source[c];
                entry[name] = value == null ? '' : String(value).trim();
            }
            data.push(entry);
        }
        return { data: data, meta: { fields: headers } };
    }

    function rowHasValue(row) {
        if (!row) return false;
        for (var i = 0; i < row.length; i += 1) {
            if (row[i] != null && String(row[i]).trim() !== '') {
                return true;
            }
        }
        return false;
    }

    function parseCsvWithPapa(text, delimiter) {
        if (!PapaParser) return null;
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
            if (!result || !result.meta) return null;
            return { data: result.data || [], meta: { fields: result.meta.fields || [] } };
        } catch (err) {
            return null;
        }
    }

    function normalizeHeaders(fields) {
        var normalized = [];
        var seen = {};
        for (var i = 0; i < fields.length; i += 1) {
            var value = fields[i] == null ? '' : String(fields[i]).trim();
            if (!value) {
                normalized.push('');
                continue;
            }
            var candidate = value;
            var counter = 1;
            while (seen[candidate]) {
                counter += 1;
                candidate = value + ' ' + counter;
            }
            seen[candidate] = true;
            normalized.push(candidate);
        }
        return normalized;
    }

    function buildFromArrayRows(rows) {
        if (!rows || !rows.length) {
            return { data: [], meta: { fields: [] } };
        }
        var headerRow = rows[0];
        var headerCells = Array.isArray(headerRow) ? headerRow : [headerRow];
        var headers = [];
        for (var i = 0; i < headerCells.length; i += 1) {
            headers.push(headerCells[i] == null ? '' : String(headerCells[i]).trim());
        }
        var data = [];
        for (var r = 1; r < rows.length; r += 1) {
            var source = rows[r];
            if (!Array.isArray(source)) {
                source = [source];
            }
            var entry = {};
            for (var c = 0; c < headers.length; c += 1) {
                var header = headers[c];
                if (!header) continue;
                var value = source[c];
                entry[header] = value == null ? '' : String(value).trim();
            }
            data.push(entry);
        }
        return { data: data, meta: { fields: headers } };
    }

    function prepareParsedResult(parsed) {
        var originalFields = parsed && parsed.meta && Array.isArray(parsed.meta.fields)
            ? parsed.meta.fields
            : [];
        var normalizedFields = normalizeHeaders(originalFields);
        var data = [];
        var rawData = parsed && Array.isArray(parsed.data) ? parsed.data : [];
        for (var i = 0; i < rawData.length; i += 1) {
            var row = rawData[i];
            var entry = {};
            for (var c = 0; c < normalizedFields.length; c += 1) {
                var header = normalizedFields[c];
                if (!header) continue;
                var sourceKey = originalFields[c];
                var value = null;
                if (row && typeof row === 'object' && !Array.isArray(row)) {
                    if (sourceKey && Object.prototype.hasOwnProperty.call(row, sourceKey)) {
                        value = row[sourceKey];
                    } else if (Object.prototype.hasOwnProperty.call(row, header)) {
                        value = row[header];
                    } else if (Object.prototype.hasOwnProperty.call(row, String(c))) {
                        value = row[String(c)];
                    }
                } else if (Array.isArray(row)) {
                    value = row[c];
                }
                entry[header] = value == null ? '' : String(value).trim();
            }
            data.push(entry);
        }
        return { data: data, meta: { fields: normalizedFields } };
    }

    function scoreParseResult(parsed) {
        if (!parsed || !parsed.meta) return -Infinity;
        var fields = parsed.meta.fields;
        if (!Array.isArray(fields) || !fields.length) return -Infinity;
        var data = Array.isArray(parsed.data) ? parsed.data : [];
        if (!data.length) return -Infinity;
        return fields.length * 1000 + data.length;
    }

    function autoParseCsv(text, options) {
        var input = text == null ? '' : String(text);
        if (!input) {
            return { data: [], meta: { fields: [] }, delimiter: ';' };
        }
        var delimiter = detectDelimiter(input);
        var candidates = [];
        var papaPrimary = parseCsvWithPapa(input, delimiter);
        if (papaPrimary) {
            candidates.push({ result: papaPrimary, delimiter: delimiter });
        }
        var manualPrimary = parseCsv(input, { delimiter: delimiter, header: true, skipEmptyLines: true });
        candidates.push({ result: manualPrimary, delimiter: delimiter });
        if (delimiter !== ';') {
            var papaSemicolon = parseCsvWithPapa(input, ';');
            if (papaSemicolon) {
                candidates.push({ result: papaSemicolon, delimiter: ';' });
            }
            var manualSemicolon = parseCsv(input, { delimiter: ';', header: true, skipEmptyLines: true });
            candidates.push({ result: manualSemicolon, delimiter: ';' });
        }
        var bestCandidate = null;
        var bestScore = -Infinity;
        for (var i = 0; i < candidates.length; i += 1) {
            var candidate = candidates[i];
            var score = scoreParseResult(candidate.result);
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }
        if (!bestCandidate || bestScore === -Infinity) {
            var fallback = parseCsv(input, { delimiter: delimiter, header: false, skipEmptyLines: true });
            if (fallback && Array.isArray(fallback.data) && fallback.data.length) {
                var rebuilt = buildFromArrayRows(fallback.data);
                var preparedFallback = prepareParsedResult(rebuilt);
                preparedFallback.delimiter = delimiter;
                return preparedFallback;
            }
            return { data: [], meta: { fields: [] }, delimiter: delimiter };
        }
        var prepared = prepareParsedResult(bestCandidate.result);
        if (!prepared.meta.fields.length) {
            var fallbackArrays = parseCsv(input, { delimiter: bestCandidate.delimiter, header: false, skipEmptyLines: true });
            if (fallbackArrays && Array.isArray(fallbackArrays.data) && fallbackArrays.data.length) {
                prepared = prepareParsedResult(buildFromArrayRows(fallbackArrays.data));
            }
        }
        prepared.delimiter = bestCandidate.delimiter;
        return prepared;
    }

    function normalizeHeaderKey(value) {
        if (value == null) return '';
        var text = String(value);
        var cleaned = '';
        for (var i = 0; i < text.length; i += 1) {
            var code = text.charCodeAt(i);
            if (code === 0xfeff) continue;
            var ch = text.charAt(i);
            if (ch === '\u00A0') ch = ' ';
            if (ch === 'ё') ch = 'е';
            if (ch === 'Ё') ch = 'Е';
            var lower = ch.toLowerCase();
            var lowerCode = lower.charCodeAt(0);
            var isDigit = lowerCode >= 48 && lowerCode <= 57;
            var isLatin = lowerCode >= 97 && lowerCode <= 122;
            var isCyr = lowerCode >= 1072 && lowerCode <= 1103;
            if (isDigit || isLatin || isCyr) {
                cleaned += lower;
            } else {
                cleaned += ' ';
            }
        }
        return cleaned.replace(/\s+/g, ' ').trim();
    }

    function mapCanonicalHeader(canonical) {
        if (!canonical) return '';
        if (HEADER_KEY_MAP[canonical]) return HEADER_KEY_MAP[canonical];
        if (canonical.indexOf('автор') !== -1 || canonical.indexOf('инициатор') !== -1) return 'author';
        if (canonical.indexOf('назв') !== -1 || canonical.indexOf('шаблон') !== -1 || canonical.indexOf('тема') !== -1) return 'title';
        if (canonical.indexOf('описан') !== -1 || canonical.indexOf('коммент') !== -1) return 'description';
        if (canonical.indexOf('статус') !== -1) return 'status';
        if (canonical.indexOf('приоритет') !== -1) return 'priority';
        if (canonical.indexOf('создан') !== -1 || canonical.indexOf('дата откр') !== -1) return 'createdAt';
        if (canonical.indexOf('sla') !== -1 || canonical.indexOf('slm') !== -1) return 'sla';
        if (canonical.indexOf('срок') !== -1 || canonical.indexOf('норматив') !== -1) return 'dueAt';
        if (canonical.indexOf('контакт') !== -1) return 'contact';
        if (canonical.indexOf('заявител') !== -1 || canonical.indexOf('requester') !== -1) return 'requester';
        if (canonical.indexOf('сервис') !== -1 || canonical.indexOf('услуга') !== -1) return 'service';
        if (canonical.indexOf('тег') !== -1 || canonical.indexOf('метк') !== -1) return 'tags';
        return '';
    }

    function buildSearchBlob(record) {
        var parts = [
            record.id,
            record.author,
            record.contact,
            record.requester,
            record.title,
            record.description,
            record.service,
            record.tags
        ];
        var filtered = [];
        for (var i = 0; i < parts.length; i += 1) {
            if (parts[i]) filtered.push(String(parts[i]));
        }
        return filtered.join(' \n ').toLowerCase();
    }

    function assignIfEmpty(target, key, value) {
        if (!target[key] && value) {
            target[key] = value;
        }
    }

    function normalizeRow(row, columns) {
        var normalized = {
            id: '',
            title: '',
            description: '',
            status: '',
            author: '',
            contact: '',
            requester: '',
            priority: '',
            sla: '',
            dueAt: '',
            createdAt: '',
            service: '',
            tags: ''
        };
        var headers = Array.isArray(columns) ? columns.slice() : [];
        if (!headers.length && row && typeof row === 'object' && !Array.isArray(row)) {
            headers = Object.keys(row);
        }
        var seen = {};
        for (var i = 0; i < headers.length; i += 1) {
            var headerName = headers[i];
            if (!headerName) continue;
            var canonical = normalizeHeaderKey(headerName);
            var mapped = mapCanonicalHeader(canonical);
            if (!mapped || seen[mapped]) continue;
            var value = '';
            if (row && typeof row === 'object' && !Array.isArray(row)) {
                if (Object.prototype.hasOwnProperty.call(row, headerName)) {
                    value = row[headerName];
                } else if (Object.prototype.hasOwnProperty.call(row, String(i))) {
                    value = row[String(i)];
                }
            } else if (Array.isArray(row)) {
                value = row[i];
            }
            normalized[mapped] = value == null ? '' : String(value).trim();
            seen[mapped] = true;
        }
        if (row && typeof row === 'object' && !Array.isArray(row)) {
            for (var key in row) {
                if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
                var canonicalKey = normalizeHeaderKey(key);
                var mappedKey = mapCanonicalHeader(canonicalKey);
                if (!mappedKey || seen[mappedKey]) continue;
                var cell = row[key];
                normalized[mappedKey] = cell == null ? '' : String(cell).trim();
                seen[mappedKey] = true;
            }
        }
        if (!normalized.author) {
            assignIfEmpty(normalized, 'author', normalized.requester);
            assignIfEmpty(normalized, 'author', normalized.contact);
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
