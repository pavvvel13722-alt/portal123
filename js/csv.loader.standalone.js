(function (global) {
    var Shared = null;
    if (global && global.AppCoreShared) {
        Shared = global.AppCoreShared;
    } else if (typeof require === 'function') {
        try {
            Shared = require('./app.core.shared.js');
        } catch (err) {
            try {
                Shared = require('../js/app.core.shared.js');
            } catch (errNested) {
                Shared = null;
            }
        }
    }

    function ensureShared() {
        if (!Shared) {
            throw new Error('AppCoreShared is required for CsvLoaderStandalone');
        }
        return Shared;
    }

    function decodeBuffer(buffer) {
        var view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        if (view.length === 0) return '';
        var hasUtf8Bom = view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf;
        if (hasUtf8Bom) {
            try {
                var strictUtf8 = new TextDecoder('utf-8', { fatal: true });
                return strictUtf8.decode(view);
            } catch (errUtf8) {
                try {
                    var relaxedUtf8 = new TextDecoder('utf-8');
                    return relaxedUtf8.decode(view);
                } catch (errUtf8Relax) {
                    return '';
                }
            }
        }
        var candidates = [];
        var utf8Valid = false;
        try {
            var strictUtf8 = new TextDecoder('utf-8', { fatal: true });
            var utf8Text = strictUtf8.decode(view);
            utf8Valid = true;
            candidates.push({ encoding: 'utf-8', text: utf8Text, score: ensureShared().scoreDecodedText(utf8Text) + 500 });
        } catch (errStrict) {
            try {
                var relaxedUtf8 = new TextDecoder('utf-8');
                var relaxedText = relaxedUtf8.decode(view);
                candidates.push({ encoding: 'utf-8', text: relaxedText, score: ensureShared().scoreDecodedText(relaxedText) + 200 });
            } catch (errRelax) {
            }
        }
        try {
            var winDecoder = new TextDecoder('windows-1251');
            var winText = winDecoder.decode(view);
            var penalty = utf8Valid ? -10000 : -1000;
            candidates.push({ encoding: 'windows-1251', text: winText, score: ensureShared().scoreDecodedText(winText) + penalty });
        } catch (errWin) {
        }
        if (!candidates.length) return '';
        candidates.sort(function (a, b) {
            if (a.score === b.score) return 0;
            return a.score > b.score ? -1 : 1;
        });
        return candidates[0].text;
    }

    function parseText(text, options) {
        var shared = ensureShared();
        var parsed = shared.autoParseCsv(text, options);
        var columns = parsed && parsed.meta && Array.isArray(parsed.meta.fields) ? parsed.meta.fields : [];
        var rows = (parsed && parsed.data ? parsed.data : [])
            .filter(Boolean)
            .map(function (row) { return shared.normalizeRow(row, columns); });
        return { rows: rows, columns: columns, delimiter: parsed && parsed.delimiter ? parsed.delimiter : ';' };
    }

    function parseArrayBuffer(buffer, options) {
        var text = decodeBuffer(buffer);
        return parseText(text, options);
    }

    function parseFile(file, options) {
        return new Promise(function (resolve, reject) {
            if (!file || typeof FileReader === 'undefined') {
                reject(new Error('FileReader is not available in this environment'));
                return;
            }
            var reader = new FileReader();
            reader.onload = function (event) {
                try {
                    var result = parseArrayBuffer(event.target && event.target.result ? event.target.result : reader.result, options);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = function (err) {
                reject(err);
            };
            reader.readAsArrayBuffer(file);
        });
    }

    var api = {
        parseText: parseText,
        parseArrayBuffer: parseArrayBuffer,
        parseFile: parseFile,
        decodeBuffer: decodeBuffer
    };

    global.CsvLoaderStandalone = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
