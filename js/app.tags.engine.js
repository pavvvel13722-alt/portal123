(function (global) {
    function TagEngineFactory() {
        const STEM_SUFFIXES = [
            'иями', 'ями', 'ами', 'ией', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые', 'ого', 'его', 'ому', 'ему',
            'ах', 'ях', 'ов', 'ев', 'ым', 'им', 'ам', 'ям', 'ую', 'юю', 'ешь', 'ишь', 'ать', 'ять', 'ить', 'еть', 'тся', 'ться',
            'лся', 'лась', 'лось', 'лись', 'ание', 'ение', 'овка', 'ировка', 'ирован', 'ированн', 'ированны'
        ];
        const TECH_TOKEN_MAP = {
            'врм': 'vrm',
            'vrm': 'vrm',
            'rdp': 'rdp',
            'mstsc': 'rdp',
            'криптопро': 'cryptopro',
            'cryptopro': 'cryptopro',
            'crypto': 'cryptopro',
            'vpn': 'vpn',
            'nla': 'nla',
            'credssp': 'nla',
            'удаленный': 'vrm',
            'удалённый': 'vrm',
            'удаленый': 'vrm',
            'удалёнка': 'vrm'
        };
        const MULTI_TOKEN_PATTERNS = [
            { sequence: ['crypto', 'pro'], replacement: 'cryptopro' },
            { sequence: ['крипто', 'про'], replacement: 'криптопро' },
            { sequence: ['удаленный', 'рабочий'], replacement: 'vrm' },
            { sequence: ['удалённый', 'рабочий'], replacement: 'vrm' }
        ];

        function extract(payload) {
            const safePayload = payload || {};
            const records = Array.isArray(safePayload.records) ? safePayload.records : [];
            const templateSelection = buildSelectionSet(safePayload.templates);
            const statusSelection = buildSelectionSet(safePayload.statuses);
            const options = prepareOptions(safePayload.params || {}, safePayload.settings || {});
            const templateMap = new Map();

            records.forEach((record) => {
                if (!record) return;
                const title = typeof record.title === 'string' ? record.title.trim() : '';
                const normalizedTitle = normalizeKey(title);
                if (templateSelection.size && !templateSelection.has(normalizedTitle)) {
                    return;
                }
                const status = typeof record.status === 'string' ? record.status.trim() : '';
                const normalizedStatus = normalizeKey(status);
                if (statusSelection.size && !statusSelection.has(normalizedStatus)) {
                    return;
                }
                let entry = templateMap.get(normalizedTitle);
                if (!entry) {
                    entry = {
                        name: title || '(без названия)',
                        normalized: normalizedTitle,
                        docs: [],
                        totalDocs: 0
                    };
                    templateMap.set(normalizedTitle, entry);
                }
                const text = typeof record.description === 'string' ? record.description : '';
                const prepared = prepareDocument(text, options);
                entry.totalDocs += 1;
                entry.docs.push({
                    tokens: prepared.tokens,
                    length: prepared.tokens.length
                });
            });

            const results = [];
            templateMap.forEach((entry) => {
                if (!entry.docs.length) {
                    results.push({
                        template: entry.name,
                        normalizedTemplate: entry.normalized,
                        documentCount: entry.totalDocs,
                        processedCount: 0,
                        tags: [],
                        phrases: []
                    });
                    return;
                }
                const preparedDocs = entry.docs.filter((doc) => doc.tokens.length);
                const corpusSize = preparedDocs.length;
                const phrases = collectPhrases(preparedDocs, options, corpusSize);
                const filtered = filterPhrases(phrases, options, corpusSize);
                const deduped = dedupePhrases(filtered, options.coverageThreshold);
                const sorted = deduped.sort((a, b) => {
                    if (b.score !== a.score) return b.score - a.score;
                    if (b.tf !== a.tf) return b.tf - a.tf;
                    if (b.df !== a.df) return b.df - a.df;
                    return a.phrase.localeCompare(b.phrase, 'ru');
                });
                const topTags = sorted.slice(0, options.topN).map((item) => ({
                    phrase: item.phrase,
                    score: item.score,
                    tf: item.tf
                }));
                results.push({
                    template: entry.name,
                    normalizedTemplate: entry.normalized,
                    documentCount: entry.totalDocs,
                    processedCount: corpusSize,
                    tags: topTags,
                    phrases: sorted
                });
            });

            return { templates: results };
        }

        function prepareOptions(params, settings) {
            const stopPhrases = parseStopPhrases(settings.stopPhrases);
            const stopTokens = buildTokenSet(settings.stopTokens);
            const domainTokens = buildTokenSet(settings.domainTokens, true);
            const minFrequency = ensureInteger(params.minFrequency, 3, 1);
            const minTokenLength = ensureInteger(params.minTokenLength, 2, 1);
            const topN = ensureInteger(params.topN, 25, 1);
            const ngramSizes = buildNgramSet(params.ngramSizes);
            const lenBoost1 = ensureNumber(settings.lenBoost1, 1);
            const lenBoost2 = ensureNumber(settings.lenBoost2, 1.25);
            const lenBoost3 = ensureNumber(settings.lenBoost3, 1.45);
            const domainBoost = ensureNumber(settings.domainBoost, 1.15);
            const coverageThreshold = clamp(Number(settings.coverageThreshold), 0, 1, 0.7);
            return {
                stopPhrases,
                stopTokens,
                domainTokens,
                minFrequency,
                minTokenLength,
                topN,
                ngramSizes,
                lenBoost: {
                    1: lenBoost1,
                    2: lenBoost2,
                    3: lenBoost3
                },
                domainBoost,
                coverageThreshold
            };
        }

        function prepareDocument(text, options) {
            if (!text) {
                return { tokens: [] };
            }
            const rawTokens = tokenize(text);
            if (!rawTokens.length) {
                return { tokens: [] };
            }
            const merged = mergeMultiTokens(rawTokens);
            const mapped = merged.map(mapToken);
            const stemmed = mapped.map(stemToken).filter(Boolean);
            const withoutPhrases = stripStopPhrases(stemmed, options.stopPhrases);
            const filtered = withoutPhrases.filter((token) => token.length >= options.minTokenLength);
            const withoutStops = filtered.filter((token) => !options.stopTokens.has(token));
            return { tokens: withoutStops };
        }

        function collectPhrases(docs, options, corpusSize) {
            const map = new Map();
            docs.forEach((doc, docIndex) => {
                const tokens = doc.tokens;
                if (!tokens.length) return;
                options.ngramSizes.forEach((gram) => {
                    if (tokens.length < gram) return;
                    for (let i = 0; i <= tokens.length - gram; i += 1) {
                        const slice = tokens.slice(i, i + gram);
                        const phraseKey = slice.join(' ');
                        let entry = map.get(phraseKey);
                        if (!entry) {
                            entry = {
                                phrase: phraseKey,
                                tokens: slice,
                                length: gram,
                                tf: 0,
                                dfDocs: new Set(),
                                occurrences: [],
                                hasDomain: slice.some((token) => options.domainTokens.has(token))
                            };
                            map.set(phraseKey, entry);
                        }
                        entry.tf += 1;
                        entry.dfDocs.add(docIndex);
                        entry.hasDomain = entry.hasDomain || slice.some((token) => options.domainTokens.has(token));
                        entry.occurrences.push({ docIndex, start: i, length: gram });
                    }
                });
            });
            const phrases = [];
            map.forEach((value) => {
                phrases.push({
                    phrase: value.phrase,
                    tokens: value.tokens,
                    length: value.length,
                    tf: value.tf,
                    df: value.dfDocs.size,
                    occurrences: value.occurrences,
                    hasDomain: value.hasDomain
                });
            });
            return phrases;
        }

        function filterPhrases(phrases, options, corpusSize) {
            return phrases
                .filter((item) => item.tf >= options.minFrequency)
                .map((item) => {
                    const boost = options.lenBoost[item.length] || 1;
                    const domainBoost = item.hasDomain ? options.domainBoost : 1;
                    const tfidf = item.tf * Math.log(1 + corpusSize / (1 + item.df));
                    return {
                        ...item,
                        tfidf,
                        score: tfidf * boost * domainBoost
                    };
                })
                .filter((item) => Number.isFinite(item.score) && item.score > 0);
        }

        function dedupePhrases(phrases, coverageThreshold) {
            if (!phrases.length) return [];
            const sorted = phrases.slice().sort((a, b) => {
                if (b.tokens.length !== a.tokens.length) return b.tokens.length - a.tokens.length;
                if (b.score !== a.score) return b.score - a.score;
                return a.phrase.localeCompare(b.phrase, 'ru');
            });
            const coverMap = new Map();
            const result = [];
            let currentLength = sorted[0].tokens.length;
            let pendingIntervals = [];

            const flushPending = () => {
                if (!pendingIntervals.length) return;
                pendingIntervals.forEach((item) => {
                    item.occurrences.forEach((occ) => {
                        const list = coverMap.get(occ.docIndex) || [];
                        list.push({ start: occ.start, end: occ.start + occ.length - 1 });
                        coverMap.set(occ.docIndex, list);
                    });
                });
                pendingIntervals = [];
            };

            sorted.forEach((item) => {
                if (item.tokens.length !== currentLength) {
                    flushPending();
                    currentLength = item.tokens.length;
                }
                const covered = countCovered(item, coverMap);
                const ratio = item.occurrences.length ? covered / item.occurrences.length : 0;
                if (ratio >= coverageThreshold && item.tokens.length > 1) {
                    return;
                }
                result.push(item);
                pendingIntervals.push(item);
            });

            flushPending();
            return result;
        }

        function countCovered(item, coverMap) {
            if (!item.occurrences.length) return 0;
            let covered = 0;
            item.occurrences.forEach((occ) => {
                const list = coverMap.get(occ.docIndex);
                if (!list || !list.length) return;
                for (let i = 0; i < list.length; i += 1) {
                    const interval = list[i];
                    if (occ.start >= interval.start && occ.start + occ.length - 1 <= interval.end) {
                        covered += 1;
                        return;
                    }
                }
            });
            return covered;
        }

        function tokenize(text) {
            const normalized = String(text || '')
                .toLowerCase()
                .replace(/ё/g, 'е')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&[a-z#0-9]+;/gi, ' ');
            const matches = normalized.match(/[\p{L}\d]+/gu);
            if (!matches) return [];
            return matches.map((token) => token.trim()).filter(Boolean);
        }

        function mergeMultiTokens(tokens) {
            if (!tokens.length) return tokens;
            const result = [];
            let index = 0;
            while (index < tokens.length) {
                let matched = false;
                for (let i = 0; i < MULTI_TOKEN_PATTERNS.length; i += 1) {
                    const pattern = MULTI_TOKEN_PATTERNS[i];
                    const seq = pattern.sequence;
                    if (index + seq.length > tokens.length) continue;
                    let ok = true;
                    for (let j = 0; j < seq.length; j += 1) {
                        if (tokens[index + j] !== seq[j]) {
                            ok = false;
                            break;
                        }
                    }
                    if (ok) {
                        result.push(pattern.replacement);
                        index += seq.length;
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    result.push(tokens[index]);
                    index += 1;
                }
            }
            return result;
        }

        function mapToken(token) {
            if (!token) return '';
            return TECH_TOKEN_MAP[token] || token;
        }

        function stemToken(token) {
            if (!token) return '';
            let result = token;
            if (result.length > 4 && (result.endsWith('ся') || result.endsWith('сь'))) {
                result = result.slice(0, -2);
            }
            for (let i = 0; i < STEM_SUFFIXES.length; i += 1) {
                const suffix = STEM_SUFFIXES[i];
                if (result.length - suffix.length >= 3 && result.endsWith(suffix)) {
                    result = result.slice(0, -suffix.length);
                    break;
                }
            }
            if (result.length > 6 && result.endsWith('ость')) {
                result = result.slice(0, -4);
            }
            if (result.length > 6 && result.endsWith('ение')) {
                result = result.slice(0, -4);
            }
            return result;
        }

        function stripStopPhrases(tokens, sequences) {
            if (!sequences.length || !tokens.length) return tokens;
            const result = [];
            let index = 0;
            while (index < tokens.length) {
                let matched = false;
                for (let i = 0; i < sequences.length; i += 1) {
                    const seq = sequences[i];
                    if (!seq.length) continue;
                    if (index + seq.length > tokens.length) continue;
                    let ok = true;
                    for (let j = 0; j < seq.length; j += 1) {
                        if (tokens[index + j] !== seq[j]) {
                            ok = false;
                            break;
                        }
                    }
                    if (ok) {
                        index += seq.length;
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    result.push(tokens[index]);
                    index += 1;
                }
            }
            return result;
        }

        function parseStopPhrases(value) {
            if (!value) return [];
            const candidates = String(value)
                .split(/\r?\n|;|\|/)
                .map((item) => item.trim())
                .filter(Boolean);
            const sequences = [];
            candidates.forEach((phrase) => {
                const tokens = mergeMultiTokens(tokenize(phrase))
                    .map(mapToken)
                    .map(stemToken)
                    .filter(Boolean);
                if (tokens.length) {
                    sequences.push(tokens);
                }
            });
            return sequences;
        }

        function buildTokenSet(value, applyDomain = false) {
            const tokens = mergeMultiTokens(tokenize(String(value || '')))
                .map(mapToken)
                .map(stemToken)
                .filter(Boolean);
            const set = new Set(tokens);
            if (applyDomain) {
                return set;
            }
            return set;
        }

        function buildNgramSet(value) {
            if (Array.isArray(value)) {
                const set = new Set();
                value.forEach((item) => {
                    const num = Number(item);
                    if (num >= 1 && num <= 5) {
                        set.add(Math.floor(num));
                    }
                });
                if (set.size) return set;
            }
            return new Set([1, 2, 3]);
        }

        function ensureInteger(value, fallback, min) {
            const num = Number(value);
            if (!Number.isFinite(num)) return fallback;
            const int = Math.floor(num);
            return int >= (min ?? 0) ? int : fallback;
        }

        function ensureNumber(value, fallback) {
            const num = Number(value);
            return Number.isFinite(num) ? num : fallback;
        }

        function clamp(value, min, max, fallback) {
            if (!Number.isFinite(value)) return fallback;
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        function normalizeKey(value) {
            return String(value || '')
                .trim()
                .toLowerCase()
                .replace(/ё/g, 'е');
        }

        function buildSelectionSet(values) {
            if (!values || !values.length) return new Set();
            return new Set(values.map(normalizeKey).filter(Boolean));
        }

        function serializeError(error) {
            if (!error) return { message: 'Unknown error' };
            return {
                message: error.message || String(error),
                stack: error.stack || null
            };
        }

        return {
            extract,
            serializeError
        };
    }

    global.TagEngineFactory = TagEngineFactory;
})(typeof window !== 'undefined' ? window : self);
