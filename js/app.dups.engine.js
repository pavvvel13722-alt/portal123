(function (global) {
    function DuplicateEngineFactory() {
        
                    const STEM_SUFFIXES = ['иями', 'ями', 'ами', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые', 'ого', 'его', 'ому', 'ему', 'ах', 'ях', 'ов', 'ев', 'ым', 'им', 'ам', 'ям', 'ую', 'юю', 'ешь', 'ишь', 'ать', 'ять', 'ить', 'еть', 'тся', 'ться', 'лся', 'лась', 'лось', 'лись'];
                    const TECH_TOKEN_MAP = {
                        'врм': 'vrm',
                        'vrm': 'vrm',
                        'rdp': 'rdp',
                        'mstsc': 'rdp',
                        'криптопро': 'cryptopro',
                        'cryptopro': 'cryptopro',
                        'crypto': 'cryptopro',
                        'nla': 'nla',
                        'credssp': 'nla'
                    };
                    const MULTI_TOKEN_PATTERNS = [
                        { sequence: ['crypto', 'pro'], replacement: 'cryptopro' }
                    ];
                    const SAFE_TOKEN_PATTERN = /^[a-zа-я0-9]+$/;
        
                    
        
                    function analyze(records, settings) {
                        const options = prepareOptions(settings);
                        const prepared = records.map((rec, index) => prepareRecord(rec, options, index)).filter(Boolean);
                        const groups = groupByAuthor(prepared);
                        const clusters = [];
        
                        groups.forEach((group) => {
                            if (!group.items || group.items.length < 2) {
                                return;
                            }
                            const components = buildComponents(group.items, options);
                            components.forEach((component) => {
                                if (component.length <= 1) return;
                                const cluster = buildCluster(component, options, group);
                                if (cluster) clusters.push(cluster);
                            });
                        });
        
                        clusters.sort((a, b) => b.members.length - a.members.length);
        
                        return {
                            clusters,
                            meta: {
                                smartThreshold: options.smartThreshold,
                                thresholds: {
                                    short: options.thresholdShort,
                                    medium: options.thresholdMedium,
                                    long: options.thresholdLong,
                                    base: options.baseThreshold
                                },
                                timeGuard: {
                                    enabled: options.timeGuardEnabled && options.timeGuardDays > 0,
                                    days: options.timeGuardDays
                                }
                            }
                        };
                    }
        
                    function prepareOptions(settings) {
                        const toNumber = (value, fallback) => {
                            const num = Number(value);
                            return Number.isFinite(num) ? num : fallback;
                        };
                        const clamp01 = (value) => Math.min(1, Math.max(0, value));
                        return {
                            smartThreshold: settings.smartThreshold !== false,
                            thresholdShort: clamp01(toNumber(settings.thresholdShort, 0.8)),
                            thresholdMedium: clamp01(toNumber(settings.thresholdMedium, 0.7)),
                            thresholdLong: clamp01(toNumber(settings.thresholdLong, 0.62)),
                            baseThreshold: clamp01(toNumber(settings.baseThreshold, 0.62)),
                            timeGuardEnabled: settings.timeGuardEnabled !== false,
                            timeGuardDays: Math.max(0, Math.floor(toNumber(settings.timeGuardDays, 14))),
                            stopPhrases: parseStopPhrases(settings.stopPhrases || settings.stopwords || '')
                        };
                    }
        
                    function parseStopPhrases(value) {
                        if (!value) return [];
                        const entries = splitStopEntries(String(value));
                        const seen = new Set();
                        const phrases = [];
                        entries.forEach((entry) => {
                            if (!entry) return;
                            const tokens = tokenize(entry);
                            if (!tokens.length) return;
                            const key = tokens.join(' ');
                            if (seen.has(key)) return;
                            seen.add(key);
                            phrases.push(tokens);
                        });
                        return phrases;
                    }
        
                    function prepareRecord(record, options, index) {
                        if (!record) return null;
                        const rawAuthor = record.author != null && String(record.author).trim() !== ''
                            ? String(record.author)
                            : (record.requester || '');
                        const authorKey = normalizeAuthor(rawAuthor);
                        const authorLabel = rawAuthor && String(rawAuthor).trim() !== ''
                            ? String(rawAuthor).trim()
                            : 'Автор не указан';
                        const description = typeof record.description === 'string' ? record.description : '';
                        const normalizedDesc = normalizeDescription(description, options.stopPhrases);
                        const trigramVector = buildTrigramVector(normalizedDesc.text);
                        const shingles = buildShingles(normalizedDesc.stemmedTokens, 3);
                        const createdTime = parseDate(record.createdAt);
                        return {
                            index,
                            id: record.id || '',
                            author: authorLabel,
                            authorKey,
                            priority: record.priority || '',
                            status: record.status || '',
                            sla: record.sla || '',
                            createdAt: record.createdAt || '',
                            dueAt: record.dueAt || '',
                            description,
                            tokenPairs: normalizedDesc.tokenPairs,
                            stemmedTokens: normalizedDesc.stemmedTokens,
                            tokenCount: normalizedDesc.tokenCount,
                            trigramVector,
                            shingles,
                            createdTime
                        };
                    }
        
                    function normalizeAuthor(value) {
                        return collapseWhitespace(toLowerNoYo(value));
                    }
        
                    function normalizeDescription(text, stopPhrases) {
                        const rawTokens = tokenize(text);
                        const filteredTokens = (stopPhrases && stopPhrases.length)
                            ? removeStopPhrases(rawTokens || [], stopPhrases)
                            : (rawTokens || []);
                        const tokens = filteredTokens.length ? mapTechnicalTokens(filteredTokens) : [];
                        const tokenPairs = tokens.map((token) => {
                            const surface = token;
                            const stem = stemToken(token);
                            return stem ? { surface, stem } : null;
                        }).filter(Boolean);
                        const stemmedTokens = tokenPairs.map((pair) => pair.stem);
                        return {
                            text: stemmedTokens.join(' '),
                            stemmedTokens,
                            tokenPairs,
                            tokenCount: stemmedTokens.length
                        };
                    }
        
                    function removeStopPhrases(tokens, stopPhrases) {
                        if (!tokens.length || !stopPhrases.length) return tokens;
                        const lookup = new Map();
                        stopPhrases.forEach((phraseTokens) => {
                            if (!Array.isArray(phraseTokens) || !phraseTokens.length) return;
                            const first = phraseTokens[0];
                            if (!lookup.has(first)) {
                                lookup.set(first, []);
                            }
                            lookup.get(first).push(phraseTokens);
                        });
                        lookup.forEach((list) => {
                            list.sort((a, b) => b.length - a.length);
                        });
                        const result = [];
                        let index = 0;
                        while (index < tokens.length) {
                            const token = tokens[index];
                            const candidates = lookup.get(token);
                            let matched = false;
                            if (candidates && candidates.length) {
                                for (let i = 0; i < candidates.length; i += 1) {
                                    const phrase = candidates[i];
                                    if (phrase.length > tokens.length - index) {
                                        continue;
                                    }
                                    let ok = true;
                                    for (let j = 1; j < phrase.length; j += 1) {
                                        if (tokens[index + j] !== phrase[j]) {
                                            ok = false;
                                            break;
                                        }
                                    }
                                    if (ok) {
                                        index += phrase.length;
                                        matched = true;
                                        break;
                                    }
                                }
                            }
                            if (!matched) {
                                result.push(token);
                                index += 1;
                            }
                        }
                        return result;
                    }
        
                    function mapTechnicalTokens(tokens) {
                        const mapped = [];
                        for (let i = 0; i < tokens.length; i += 1) {
                            const token = tokens[i];
                            if (!token) continue;
                            let replaced = false;
                            for (let j = 0; j < MULTI_TOKEN_PATTERNS.length; j += 1) {
                                const pattern = MULTI_TOKEN_PATTERNS[j];
                                let matches = true;
                                for (let k = 0; k < pattern.sequence.length; k += 1) {
                                    if (tokens[i + k] !== pattern.sequence[k]) {
                                        matches = false;
                                        break;
                                    }
                                }
                                if (matches) {
                                    mapped.push(pattern.replacement);
                                    i += pattern.sequence.length - 1;
                                    replaced = true;
                                    break;
                                }
                            }
                            if (replaced) continue;
                            const canonical = TECH_TOKEN_MAP[token] || token;
                            mapped.push(canonical);
                        }
                        return mapped;
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
        
                    function buildTrigramVector(text) {
                        const map = new Map();
                        if (!text || !text.length) return map;
                        const padded = '  ' + text + '  ';
                        for (let i = 0; i < padded.length - 2; i += 1) {
                            const trigram = padded.slice(i, i + 3);
                            map.set(trigram, (map.get(trigram) || 0) + 1);
                        }
                        return map;
                    }
        
                    function buildShingles(tokens, size) {
                        if (!tokens.length) return new Set();
                        const set = new Set(tokens);
                        if (tokens.length < size) {
                            return set;
                        }
                        for (let i = 0; i <= tokens.length - size; i += 1) {
                            set.add(tokens.slice(i, i + size).join(' '));
                        }
                        return set;
                    }
        
                    function parseDate(value) {
                        if (!value) return null;
                        if (typeof value === 'number') return value;
                        if (value instanceof Date) return value.getTime();
                        const trimmed = String(value).trim();
                        if (!trimmed) return null;
                        const normalized = trimmed.replace(/\./g, '-');
                        const iso = Date.parse(normalized.replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$2-$1'));
                        if (!Number.isNaN(iso)) return iso;
                        const parts = trimmed.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
                        if (parts) {
                            const day = Number(parts[1]);
                            const month = Number(parts[2]) - 1;
                            const year = Number(parts[3].length === 2 ? '20' + parts[3] : parts[3]);
                            const hours = Number(parts[4] || 0);
                            const minutes = Number(parts[5] || 0);
                            return Date.UTC(year, month, day, hours, minutes);
                        }
                        const fallback = Date.parse(trimmed);
                        return Number.isNaN(fallback) ? null : fallback;
                    }
        
                    function groupByAuthor(records) {
                        const map = new Map();
                        records.forEach((record) => {
                            const key = record.authorKey || 'не указан';
                            if (!map.has(key)) {
                                map.set(key, { key, label: record.author, items: [] });
                            }
                            map.get(key).items.push(record);
                        });
                        return map;
                    }
        
                    function buildComponents(records, options) {
                        if (records.length < 2) return [];
                        const dsu = createDisjointSet(records.length);
                        const guardMs = options.timeGuardEnabled ? options.timeGuardDays * 24 * 60 * 60 * 1000 : 0;
                        const ordered = records.map((record, idx) => ({ record, idx }))
                            .sort((a, b) => {
                                const timeA = a.record.createdTime != null ? a.record.createdTime : Number.POSITIVE_INFINITY;
                                const timeB = b.record.createdTime != null ? b.record.createdTime : Number.POSITIVE_INFINITY;
                                return timeA - timeB;
                            });
        
                        for (let i = 0; i < ordered.length; i += 1) {
                            const left = ordered[i];
                            for (let j = i + 1; j < ordered.length; j += 1) {
                                const right = ordered[j];
                                if (guardMs && left.record.createdTime != null && right.record.createdTime != null) {
                                    const diff = Math.abs(right.record.createdTime - left.record.createdTime);
                                    if (diff > guardMs) {
                                        if (right.record.createdTime - left.record.createdTime > guardMs) {
                                            break;
                                        }
                                        continue;
                                    }
                                }
                                const pair = computePairSimilarity(left.record, right.record, options);
                                if (pair.score >= pair.threshold) {
                                    dsu.union(left.idx, right.idx);
                                }
                            }
                        }
        
                        return extractComponents(records, dsu);
                    }
        
                    function computePairSimilarity(a, b, options) {
                        const t3 = cosineSimilarity(a.trigramVector, b.trigramVector);
                        const j3 = jaccardSimilarity(a.shingles, b.shingles);
                        const score = Math.max(0, Math.min(1, 0.6 * t3 + 0.4 * j3));
                        const minLen = Math.min(a.tokenCount, b.tokenCount);
                        let threshold = options.smartThreshold ? selectSmartThreshold(options, minLen) : options.baseThreshold;
                        if (!Number.isFinite(threshold)) threshold = options.baseThreshold;
                        if (minLen === 0) {
                            threshold = 1;
                        }
                        const sharedRatio = computeSharedRatio(a, b);
                        if (sharedRatio > 0.5 && threshold > options.baseThreshold) {
                            const adjust = Math.min(0.15, sharedRatio * 0.2);
                            const lowered = threshold - adjust;
                            threshold = lowered < options.baseThreshold ? options.baseThreshold : lowered;
                        }
                        return { score, t3, j3, threshold, sharedRatio };
                    }
        
                    function selectSmartThreshold(options, length) {
                        if (length < 8) return options.thresholdShort;
                        if (length < 20) return options.thresholdMedium;
                        return options.thresholdLong;
                    }
        
                    function extractComponents(records, dsu) {
                        const groups = new Map();
                        records.forEach((record, idx) => {
                            const root = dsu.find(idx);
                            if (!groups.has(root)) {
                                groups.set(root, []);
                            }
                            groups.get(root).push(record);
                        });
                        return Array.from(groups.values());
                    }
        
                    function buildCluster(records, options, group) {
                        const primary = selectPrimary(records);
                        const highlight = new Set();
                        const duplicates = [];
        
                        records.forEach((record) => {
                            if (record.index === primary.index) return;
                            const pair = computePairSimilarity(record, primary, options);
                            const sharedTokens = collectSharedTokens(record, primary);
                            sharedTokens.forEach((token) => highlight.add(token));
                            duplicates.push(formatDuplicate(record, pair, sharedTokens));
                        });
        
                        duplicates.sort((a, b) => {
                            const left = a.similarityValue != null ? a.similarityValue : 0;
                            const right = b.similarityValue != null ? b.similarityValue : 0;
                            return right - left;
                        });
        
                        const primaryTokens = highlight.size ? highlight : collectAllSurfaceTokens(primary);
                        const primaryMember = formatPrimary(primary, primaryTokens);
                        const members = [primaryMember].concat(duplicates);
        
                        return {
                            author: group.label || 'Автор не указан',
                            authorKey: group.key,
                            primary: primaryMember,
                            duplicates,
                            members
                        };
                    }
        
                    function selectPrimary(records) {
                        return records.slice().sort(function (a, b) {
                            const timeA = a.createdTime != null ? a.createdTime : Number.NEGATIVE_INFINITY;
                            const timeB = b.createdTime != null ? b.createdTime : Number.NEGATIVE_INFINITY;
                            if (timeA !== timeB) return timeB - timeA;
                            return b.index - a.index;
                        })[0];
                    }
        
                    function formatDuplicate(record, pair, sharedTokens) {
                        return {
                            id: record.id,
                            author: record.author,
                            priority: record.priority || '',
                            status: record.status || '',
                            sla: record.sla || '',
                            createdAt: record.createdAt || '',
                            dueAt: record.dueAt || '',
                            snippet: buildSnippet(record.description, sharedTokens),
                            similarity: Math.round(pair.score * 100) + '%',
                            similarityValue: pair.score,
                            similarityDetail: buildSimilarityDetail(pair),
                            thresholdUsed: pair.threshold,
                            isPrimary: false
                        };
                    }
        
                    function formatPrimary(record, highlightTokens) {
                        return {
                            id: record.id,
                            author: record.author,
                            priority: record.priority || '',
                            status: record.status || '',
                            sla: record.sla || '',
                            createdAt: record.createdAt || '',
                            dueAt: record.dueAt || '',
                            snippet: buildSnippet(record.description, highlightTokens),
                            similarity: null,
                            similarityValue: null,
                            similarityDetail: 'Опорная заявка',
                            thresholdUsed: null,
                            isPrimary: true
                        };
                    }
        
                    function collectSharedTokens(record, reference) {
                        const shared = new Set();
                        const referenceStems = new Set((reference.tokenPairs || []).map((pair) => pair.stem));
                        (record.tokenPairs || []).forEach((pair) => {
                            if (!pair) return;
                            if (referenceStems.has(pair.stem) && pair.surface) {
                                shared.add(pair.surface);
                            }
                        });
                        return shared;
                    }
        
                    function collectAllSurfaceTokens(record) {
                        const set = new Set();
                        (record.tokenPairs || []).forEach((pair) => {
                            if (pair && pair.surface && pair.surface.length > 2) {
                                set.add(pair.surface);
                            }
                        });
                        return set;
                    }
        
                    function buildSimilarityDetail(pair) {
                        const t = Math.round(pair.t3 * 100);
                        const j = Math.round(pair.j3 * 100);
                        const threshold = Math.round(pair.threshold * 100);
                        const ratioPart = pair.sharedRatio != null
                            ? ' - Пересечение ' + Math.round(pair.sharedRatio * 100) + '%'
                            : '';
                        return 'T3 ' + t + '% - J3 ' + j + '% - Порог ' + threshold + '%' + ratioPart;
                    }

                    function computeSharedRatio(a, b) {
                        if (!a || !b) return 0;
                        if (!a.tokenPairs || !b.tokenPairs) return 0;
                        if (!a.tokenPairs.length || !b.tokenPairs.length) return 0;
                        const stemsA = new Set();
                        for (let i = 0; i < a.tokenPairs.length; i += 1) {
                            const pair = a.tokenPairs[i];
                            if (pair && pair.stem) stemsA.add(pair.stem);
                        }
                        const stemsB = new Set();
                        for (let j = 0; j < b.tokenPairs.length; j += 1) {
                            const pairB = b.tokenPairs[j];
                            if (pairB && pairB.stem) stemsB.add(pairB.stem);
                        }
                        if (!stemsA.size || !stemsB.size) return 0;
                        let shared = 0;
                        stemsA.forEach((stem) => {
                            if (stemsB.has(stem)) shared += 1;
                        });
                        const minLen = Math.min(a.tokenCount || 0, b.tokenCount || 0);
                        if (!minLen) return 0;
                        return shared / minLen;
                    }
        
                    function buildSnippet(text, tokens) {
                        if (!text) return '<span class="record__meta">Описание отсутствует</span>';
                        const trimmed = collapseWhitespace(String(text || ''));
                        const short = trimmed.length > 280 ? trimmed.slice(0, 280) + '...' : trimmed;
                        const highlightTokens = Array.from(tokens || [])
                            .map((token) => {
                                if (!token) return '';
                                const normalized = toLowerNoYo(token).trim();
                                return normalized;
                            })
                            .filter((token) => token && token.length > 2 && SAFE_TOKEN_PATTERN.test(token));
                        if (!highlightTokens.length) {
                            return escapeHtml(short);
                        }
                        const lowerText = toLowerNoYo(short);
                        const ranges = [];
                        const seen = new Set();
                        for (let i = 0; i < highlightTokens.length; i += 1) {
                            const token = highlightTokens[i];
                            if (seen.has(token)) continue;
                            seen.add(token);
                            let position = 0;
                            while (position < lowerText.length) {
                                const found = lowerText.indexOf(token, position);
                                if (found === -1) break;
                                const before = found === 0 ? '' : lowerText[found - 1];
                                const afterIndex = found + token.length;
                                const after = afterIndex >= lowerText.length ? '' : lowerText[afterIndex];
                                if (!isWordChar(before) && !isWordChar(after)) {
                                    ranges.push([found, afterIndex]);
                                }
                                position = found + token.length;
                            }
                        }
                        if (!ranges.length) {
                            return escapeHtml(short);
                        }
                        ranges.sort((a, b) => a[0] - b[0]);
                        const merged = [];
                        for (let i = 0; i < ranges.length; i += 1) {
                            const [start, end] = ranges[i];
                            if (!merged.length || start > merged[merged.length - 1][1]) {
                                merged.push([start, end]);
                            } else {
                                merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
                            }
                        }
                        let result = '';
                        let cursor = 0;
                        for (let i = 0; i < merged.length; i += 1) {
                            const [start, end] = merged[i];
                            if (cursor < start) {
                                result += escapeHtml(short.slice(cursor, start));
                            }
                            result += '<mark>' + escapeHtml(short.slice(start, end)) + '</mark>';
                            cursor = end;
                        }
                        if (cursor < short.length) {
                            result += escapeHtml(short.slice(cursor));
                        }
                        return result;
                    }
        
                    function splitStopEntries(value) {
                        const entries = [];
                        let current = '';
                        for (let i = 0; i < value.length; i += 1) {
                            const char = value[i];
                            if (char === '\r') continue;
                            if (char === '\n' || char === ';' || char === ',') {
                                if (current) {
                                    entries.push(current);
                                    current = '';
                                }
                                continue;
                            }
                            current += char;
                        }
                        if (current) entries.push(current);
                        return entries;
                    }
        
                    function toLowerNoYo(value) {
                        if (value == null) return '';
                        return String(value).toLowerCase().split('ё').join('е');
                    }
        
                    function collapseWhitespace(value) {
                        let result = '';
                        let lastWasSpace = false;
                        for (let i = 0; i < value.length; i += 1) {
                            const char = value[i];
                            const isSpace = char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v' || char === '\u00A0';
                            if (isSpace) {
                                if (!lastWasSpace && result) {
                                    result += ' ';
                                }
                                lastWasSpace = true;
                            } else {
                                result += char;
                                lastWasSpace = false;
                            }
                        }
                        return result.trim();
                    }
        
                    function tokenize(text) {
                        const source = toLowerNoYo(text);
                        const tokens = [];
                        let token = '';
                        let inTag = false;
                        let inEntity = false;
                        for (let i = 0; i < source.length; i += 1) {
                            const char = source[i];
                            if (inTag) {
                                if (char === '>') {
                                    inTag = false;
                                }
                                continue;
                            }
                            if (char === '<') {
                                if (token) {
                                    tokens.push(token);
                                    token = '';
                                }
                                inTag = true;
                                continue;
                            }
                            if (inEntity) {
                                if (char === ';' || char === ' ' || char === '\t' || char === '\n' || char === '\r') {
                                    inEntity = false;
                                }
                                continue;
                            }
                            if (char === '&') {
                                if (token) {
                                    tokens.push(token);
                                    token = '';
                                }
                                inEntity = true;
                                continue;
                            }
                            const code = char.charCodeAt(0);
                            if (isTokenCharCode(code)) {
                                token += char;
                            } else {
                                if (token) {
                                    tokens.push(token);
                                    token = '';
                                }
                            }
                        }
                        if (token) tokens.push(token);
                        return tokens;
                    }
        
                    function isTokenCharCode(code) {
                        const isDigit = code >= 48 && code <= 57;
                        const isLatin = code >= 97 && code <= 122;
                        const isCyrillic = code >= 1072 && code <= 1103;
                        return isDigit || isLatin || isCyrillic;
                    }
        
                    function isWordChar(char) {
                        if (!char) return false;
                        const code = char.charCodeAt(0);
                        const isDigit = code >= 48 && code <= 57;
                        const isLatinLower = code >= 97 && code <= 122;
                        const isCyrillicLower = code >= 1072 && code <= 1103;
                        return isDigit || isLatinLower || isCyrillicLower;
                    }
        
                    function serializeError(error) {
                        if (!error) return { message: 'Неизвестная ошибка' };
                        if (typeof error === 'string') return { message: error };
                        return {
                            message: error.message || String(error),
                            stack: error.stack || null,
                            name: error.name || 'Error'
                        };
                    }
        
                    function cosineSimilarity(mapA, mapB) {
                        let dot = 0;
                        let normA = 0;
                        let normB = 0;
                        mapA.forEach((value) => {
                            normA += value * value;
                        });
                        mapB.forEach((value) => {
                            normB += value * value;
                        });
                        const smaller = mapA.size < mapB.size ? mapA : mapB;
                        const larger = smaller === mapA ? mapB : mapA;
                        smaller.forEach((value, key) => {
                            const other = larger.get(key);
                            if (other) {
                                dot += value * other;
                            }
                        });
                        if (!dot || !normA || !normB) return 0;
                        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
                    }
        
                    function jaccardSimilarity(setA, setB) {
                        if (!setA.size && !setB.size) return 0;
                        let intersection = 0;
                        setA.forEach((value) => {
                            if (setB.has(value)) intersection += 1;
                        });
                        const union = new Set();
                        setA.forEach((value) => union.add(value));
                        setB.forEach((value) => union.add(value));
                        if (!union.size) return 0;
                        return intersection / union.size;
                    }
        
                    function createDisjointSet(size) {
                        const parent = Array.from({ length: size }, (_, i) => i);
                        const rank = new Array(size).fill(0);
                        const find = (x) => {
                            if (parent[x] !== x) {
                                parent[x] = find(parent[x]);
                            }
                            return parent[x];
                        };
                        const union = (a, b) => {
                            const rootA = find(a);
                            const rootB = find(b);
                            if (rootA === rootB) return;
                            if (rank[rootA] < rank[rootB]) {
                                parent[rootA] = rootB;
                            } else if (rank[rootA] > rank[rootB]) {
                                parent[rootB] = rootA;
                            } else {
                                parent[rootB] = rootA;
                                rank[rootA] += 1;
                            }
                        };
                        return { find, union };
                    }
        
                    function escapeHtml(value) {
                        return String(value)
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;')
                            .replace(/'/g, '&#39;');
                    }
        
                

        return { analyze, serializeError };
    }

    global.DuplicateEngineFactory = DuplicateEngineFactory;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = DuplicateEngineFactory;
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {})));
