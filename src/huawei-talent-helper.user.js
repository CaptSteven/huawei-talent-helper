// ==UserScript==
// @name         华为人才在线课程助手 (Huawei Talent Helper) - v1.3.13
// @namespace    http://tampermonkey.net/
// @version      1.3.13
// @description  【AI做题增强】支持自动连播、倍速、防挂机，并可调用 DeepSeek/Gemini/Qwen 官方 API 自动进入测验、逐题作答、检查未答、交卷并进入下一环节。
// @author       Antigravity
// @match        *://e.huawei.com/cn/talent/*
// @match        *://*.huawei.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.deepseek.com
// @connect      generativelanguage.googleapis.com
// @connect      dashscope.aliyuncs.com
// @connect      dashscope-intl.aliyuncs.com
// @connect      dashscope-us.aliyuncs.com
// @connect      cn-hongkong.dashscope.aliyuncs.com
// @connect      cn-hongkong.aliyuncs.com
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/CaptSteven/Huwei_Helper_Plug/main/src/huawei-talent-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/CaptSteven/Huwei_Helper_Plug/main/src/huawei-talent-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const IS_TOP = (window.top === window);

    // 用户核心配置
    const CONFIG = {
        autoNext: true,
        playbackSpeed: 1.0,
        minDelay: 2000,
        maxDelay: 4000,
        autoCourseware: false,   // 「自动刷课件」：开启后对课件/阅读 PPT 节点逐页翻到末页再推进；默认关，关闭时完全不影响原有连播
        coursewarePageDelay: 900 // 课件每页之间的停留间隔(ms)，给平台记录每页浏览的时间
    };

    // 课件 / 纯阅读类节点关键词（带翻页 PPT、无视频、无题目）。开启「自动刷课件」时翻页刷完，
    // 关闭时它们仍按 BLACKLIST_KEYWORDS 原逻辑被跳过。测验/考试/作业/练习不在此列。
    const COURSEWARE_KEYWORDS = ['课件', '文档', '资料', '阅读', '导读', '图文'];

    const STORAGE_KEY_AI = 'HW_TALENT_HELPER_AI_CONFIG';
    const AI_PROVIDERS = {
        deepseek: {
            label: 'DeepSeek 官方',
            type: 'openai',
            defaultModel: 'deepseek-v4-flash',
            defaultBaseUrl: 'https://api.deepseek.com'
        },
        gemini: {
            label: 'Gemini 官方',
            type: 'gemini',
            defaultModel: 'gemini-3.5-flash',
            defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta'
        },
        qwen: {
            label: 'Qwen 官方',
            type: 'openai',
            defaultModel: 'qwen-plus',
            defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        }
    };

    const DEFAULT_AI_CONFIG = {
        enabled: false,
        autoSolve: false,
        autoSubmit: false,
        provider: 'deepseek',
        apiKeys: { deepseek: '', gemini: '', qwen: '' },
        models: {
            deepseek: AI_PROVIDERS.deepseek.defaultModel,
            gemini: AI_PROVIDERS.gemini.defaultModel,
            qwen: AI_PROVIDERS.qwen.defaultModel
        },
        baseUrls: {
            deepseek: AI_PROVIDERS.deepseek.defaultBaseUrl,
            gemini: AI_PROVIDERS.gemini.defaultBaseUrl,
            qwen: AI_PROVIDERS.qwen.defaultBaseUrl
        }
    };

    let AI_CONFIG = loadAiConfig();
    let aiSolveLock = false;
    let lastAiQuestionSignature = '';
    let lastAiSolveTime = 0;
    let quizSubmittedAt = 0;
    let lastTrySubmitTime = 0; // 记录最近一次点击「下一题/提交」的时间，用于防止转场期 finalizeQuiz 误触发跳题
    let lastSolvedSignature = ''; // 已「确认作答成功（applied>0 校验通过）」的题目签名：只有它才允许推进
    let lastAdvancedSignature = ''; // 已经点过「下一题」推进的题目签名：保证每题最多推进一次，杜绝盲推进/双推进跳题

    function loadAiConfig() {
        let saved = null;
        try {
            if (typeof GM_getValue === 'function') saved = GM_getValue(STORAGE_KEY_AI, null);
        } catch (e) {}
        if (!saved) {
            try { saved = localStorage.getItem(STORAGE_KEY_AI); } catch (e) {}
        }
        try {
            const parsed = saved ? JSON.parse(saved) : {};
            return mergeAiConfig(parsed);
        } catch (e) {
            return mergeAiConfig({});
        }
    }

    function saveAiConfig(nextConfig) {
        AI_CONFIG = mergeAiConfig(nextConfig);
        const serialized = JSON.stringify(AI_CONFIG);
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_AI, serialized);
        } catch (e) {}
        try { localStorage.setItem(STORAGE_KEY_AI, serialized); } catch (e) {}
        return AI_CONFIG;
    }

    function mergeAiConfig(config) {
        return {
            ...DEFAULT_AI_CONFIG,
            ...config,
            apiKeys: { ...DEFAULT_AI_CONFIG.apiKeys, ...(config.apiKeys || {}) },
            models: { ...DEFAULT_AI_CONFIG.models, ...(config.models || {}) },
            baseUrls: { ...DEFAULT_AI_CONFIG.baseUrls, ...(config.baseUrls || {}) }
        };
    }

    function getActiveAiProvider() {
        const providerKey = AI_CONFIG.provider || 'deepseek';
        return AI_PROVIDERS[providerKey] || AI_PROVIDERS.deepseek;
    }

    function reportAiStatus(message, level = 'info') {
        const payload = { message, level, at: Date.now() };
        if (IS_TOP) updateAiStatus(payload);
        else {
            try { window.top.postMessage({ type: 'HW_AI_STATUS', data: payload }, '*'); } catch (e) {}
        }
        console.log(`[华为助手 AI] ${message}`);
    }

    function updateAiStatus(payload) {
        const statusEl = document.getElementById('lbl-ai-status');
        if (!statusEl || !payload) return;
        statusEl.innerText = payload.message || '-';
        const colorMap = { success: '#67c23a', error: '#f56c6c', warn: '#e6a23c', info: '#606266' };
        statusEl.style.color = colorMap[payload.level] || colorMap.info;
    }

    function requestAiSolveFromAllFrames() {
        const frames = Array.from(document.querySelectorAll('iframe'));
        if (hasQuestionCandidatesInCurrentDocument() || frames.length === 0) solveQuestionsWithAi('manual');
        frames.forEach(ifr => {
            try { ifr.contentWindow.postMessage({ type: 'HW_AI_SOLVE_REQUEST' }, '*'); } catch (e) {}
        });
        if (frames.length > 0) updateAiStatus({ message: '已向课程窗口发送识别请求', level: 'info' });
    }

    async function solveQuestionsWithAi(trigger = 'manual') {
        AI_CONFIG = loadAiConfig();
        if (!AI_CONFIG.enabled) {
            reportAiStatus('请先启用 AI 做题并保存配置', 'warn');
            return;
        }
        if (aiSolveLock) return;

        const questions = collectQuestionGroups();
        if (questions.length === 0) {
            if (trigger === 'manual') {
                const startTest = document.querySelector('.start-test');
                reportAiStatus(startTest && isVisibleElement(startTest) ? '请先点击“开始测验”进入题目页' : '没有在当前页面识别到题目', 'warn');
            }
            return;
        }

        const signature = buildQuestionSignature(questions);
        if (trigger === 'auto' && signature === lastAiQuestionSignature && Date.now() - lastAiSolveTime < 120000) return;

        aiSolveLock = true;
        lastAiQuestionSignature = signature;
        lastAiSolveTime = Date.now();

        try {
            reportAiStatus(`识别到 ${questions.length} 道题，正在请求模型...`, 'info');
            const answer = await askAiForAnswers(questions);
            const applied = await applyAiAnswers(questions, answer);
            if (applied > 0) {
                // 标记本题「已确认作答成功」。推进改由 runAutoAiCycle 在确认作答后统一执行（每题只推一次），
                // 不再在此处用盲目的 setTimeout 推进——那会与 5s 主循环 / finalizeQuiz 错位造成跳题。
                lastSolvedSignature = signature;
                reportAiStatus(`已回填 ${applied} 道题的答案`, 'success');
            } else {
                reportAiStatus('模型返回了结果，但没有匹配到可回填答案', 'warn');
            }
        } catch (err) {
            reportAiStatus(err && err.message ? err.message : 'AI 做题失败', 'error');
        } finally {
            aiSolveLock = false;
        }
    }

    function collectQuestionGroups() {
        const sxzQuestions = collectSxzQuizQuestions();
        if (sxzQuestions.length > 0) return sxzQuestions;

        const inputSelector = 'input[type="radio"], input[type="checkbox"]';
        const inputs = Array.from(document.querySelectorAll(inputSelector)).filter(isUsableChoiceInput);
        if (inputs.length === 0) return [];

        const containers = [];
        inputs.forEach(input => {
            const container = findQuestionContainer(input);
            if (container && !containers.includes(container)) containers.push(container);
        });

        return containers.map((container, index) => buildQuestionFromContainer(container, index)).filter(Boolean);
    }

    function collectSxzQuizQuestions() {
        const testContent = document.querySelector('.test-content');
        if (!testContent) return [];

        const main = testContent.querySelector('.right-main') || testContent;
        const optionItems = Array.from(main.querySelectorAll('.option-list-item')).filter(isVisibleElement);
        if (optionItems.length === 0) return [];

        const titleNode = main.querySelector('.subtitle .main-title, .main-title, [class*="question-title" i], [class*="stem" i]');
        const questionText = normalizeText(titleNode ? titleNode.innerText : '').replace(/^\d+[、.]\s*/, '');
        if (!questionText) return [];

        const typeNode = testContent.querySelector('.type-name') || testContent.querySelector('.ks-title');
        const typeText = normalizeText(typeNode ? typeNode.innerText : '');
        const options = optionItems.map((item, optionIndex) => {
            const input = item.querySelector('input[type="radio"], input[type="checkbox"]');
            const clickTarget = item.querySelector('.option-list') || item;
            const content = item.querySelector('.option-content, .option-content-wrapper, .content') || item;
            const text = getSxzOptionText(content, item) || `选项 ${optionIndex + 1}`;
            return {
                input,
                item,
                clickTarget,
                text: stripOptionPrefix(text),
                rawText: text
            };
        }).filter(option => option.input && option.text.length > 0);

        if (options.length === 0) return [];

        return [{
            index: 0,
            type: typeText.includes('多选') || options.some(option => option.input.type === 'checkbox') ? 'multiple' : 'single',
            text: questionText.slice(0, 800),
            options
        }];
    }

    function getSxzOptionText(contentNode, item) {
        const text = normalizeText(contentNode.innerText || contentNode.textContent);
        if (text) return text;
        return normalizeText(item.innerText);
    }

    function findQuestionContainer(input) {
        const preferred = input.closest([
            '[class*="question" i]',
            '[class*="subject" i]',
            '[class*="exam" i]',
            '[class*="quiz" i]',
            '[class*="test" i]',
            '.el-form-item',
            'li',
            'section',
            'article'
        ].join(','));
        const preferredCount = preferred ? preferred.querySelectorAll('input[type="radio"], input[type="checkbox"]').length : 0;
        if (preferred && preferredCount >= 2 && preferredCount <= 12) return preferred;

        let node = input.parentElement;
        for (let depth = 0; depth < 5 && node; depth++) {
            const count = node.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
            const text = normalizeText(node.innerText);
            if (count >= 2 && count <= 12 && text.length > 8) return node;
            node = node.parentElement;
        }
        return input.closest('div') || input.parentElement;
    }

    function buildQuestionFromContainer(container, index) {
        const inputs = Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(isUsableChoiceInput);
        if (inputs.length === 0) return null;

        const options = inputs.map((input, optionIndex) => {
            const text = getOptionText(input, container) || `选项 ${optionIndex + 1}`;
            return { input, text: stripOptionPrefix(text), rawText: text };
        }).filter(option => option.text.length > 0);
        if (options.length === 0) return null;

        const questionText = getQuestionText(container, options);
        if (!questionText || questionText.length < 2) return null;

        return {
            index,
            type: inputs.some(input => input.type === 'checkbox') ? 'multiple' : 'single',
            text: questionText,
            options
        };
    }

    function getQuestionText(container, options) {
        const optionTexts = options.map(option => option.rawText).filter(Boolean);
        let text = normalizeText(container.innerText);
        optionTexts.forEach(optionText => {
            const escaped = escapeRegExp(normalizeText(optionText));
            text = text.replace(new RegExp(escaped, 'g'), ' ');
        });
        text = normalizeText(text);

        const titleEl = Array.from(container.querySelectorAll([
            '[class*="title" i]',
            '[class*="question" i]',
            '[class*="subject" i]',
            '.stem',
            'h1',
            'h2',
            'h3',
            'p'
        ].join(','))).find(el => {
            const t = normalizeText(el.innerText);
            return t.length > 3 && !optionTexts.some(opt => normalizeText(opt) === t);
        });

        const titleText = titleEl ? normalizeText(titleEl.innerText) : '';
        return (titleText && titleText.length <= text.length ? titleText : text).slice(0, 800);
    }

    function getOptionText(input, container) {
        const id = input.getAttribute('id');
        const label = id ? container.querySelector(`label[for="${cssEscape(id)}"]`) : null;
        if (label && normalizeText(label.innerText)) return normalizeText(label.innerText);

        const labelParent = input.closest('label');
        if (labelParent && normalizeText(labelParent.innerText)) return normalizeText(labelParent.innerText);

        const optionNode = input.closest([
            '.option-list-item',
            '.option-list',
            '[class*="option" i]',
            '[class*="answer" i]',
            '.el-radio',
            '.el-checkbox',
            'li',
            'tr',
            'p',
            'div'
        ].join(','));
        if (!optionNode) return '';

        let text = normalizeText(optionNode.innerText);
        if (!text) {
            const nextText = input.nextSibling && input.nextSibling.textContent ? input.nextSibling.textContent : '';
            text = normalizeText(nextText);
        }
        return text;
    }

    function buildQuestionSignature(questions) {
        return questions.map(q => `${q.type}:${q.text}:${q.options.map(o => o.text).join('|')}`).join('\n---\n');
    }

    function hasQuestionCandidatesInCurrentDocument() {
        return !!document.querySelector('.test-content .option-list-item, input[type="radio"], input[type="checkbox"]');
    }

    async function askAiForAnswers(questions) {
        const providerKey = AI_CONFIG.provider || 'deepseek';
        const provider = getActiveAiProvider();
        const apiKey = (AI_CONFIG.apiKeys[providerKey] || '').trim();
        const model = (AI_CONFIG.models[providerKey] || provider.defaultModel).trim();
        const baseUrl = (AI_CONFIG.baseUrls[providerKey] || provider.defaultBaseUrl).replace(/\/$/, '');

        if (!apiKey) throw new Error(`请先填写 ${provider.label} API Key`);
        if (!model) throw new Error(`请先填写 ${provider.label} 模型名`);

        const prompt = buildAnswerPrompt(questions);
        const text = provider.type === 'gemini'
            ? await callGeminiApi(baseUrl, apiKey, model, prompt)
            : await callOpenAiCompatibleApi(baseUrl, apiKey, model, prompt);
        return parseJsonFromModelText(text);
    }

    function buildAnswerPrompt(questions) {
        const compact = questions.map(q => ({
            questionIndex: q.index,
            type: q.type,
            question: q.text,
            options: q.options.map((option, optionIndex) => ({ optionIndex, text: option.text }))
        }));

        return [
            '你是在线课程测验答题助手。请根据题干和选项选择最可能正确的答案。',
            '严格只返回 JSON，不要解释，不要使用 Markdown。',
            '返回格式：{"answers":[{"questionIndex":0,"optionIndexes":[0],"confidence":0.8}]}',
            '单选题 optionIndexes 只放一个索引；多选题可以放多个索引。不确定时选择最可能的答案。',
            JSON.stringify(compact, null, 2)
        ].join('\n');
    }

    function callOpenAiCompatibleApi(baseUrl, apiKey, model, prompt) {
        return gmRequestJson({
            method: 'POST',
            url: `${baseUrl}/chat/completions`,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            data: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: '你只输出可解析 JSON。' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                stream: false
            })
        }).then(json => {
            const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
            if (!content) throw new Error('模型没有返回答案内容');
            return content;
        });
    }

    function callGeminiApi(baseUrl, apiKey, model, prompt) {
        return gmRequestJson({
            method: 'POST',
            url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            data: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1 }
            })
        }).then(json => {
            const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
            const content = Array.isArray(parts) ? parts.map(part => part.text || '').join('') : '';
            if (!content) throw new Error('Gemini 没有返回答案内容');
            return content;
        });
    }

    function gmRequestJson(options) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('当前油猴环境不支持 GM_xmlhttpRequest，请确认脚本授权已生效'));
                return;
            }

            GM_xmlhttpRequest({
                ...options,
                timeout: 60000,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`API 请求失败：HTTP ${response.status}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        reject(new Error('API 返回内容不是合法 JSON'));
                    }
                },
                ontimeout: () => reject(new Error('API 请求超时')),
                onerror: () => reject(new Error('API 请求失败，请检查网络、Key 或 @connect 权限'))
            });
        });
    }

    function parseJsonFromModelText(text) {
        const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) throw new Error('模型返回内容中没有 JSON');
        const json = JSON.parse(cleaned.slice(start, end + 1));
        if (!json || !Array.isArray(json.answers)) throw new Error('模型 JSON 缺少 answers 数组');
        return json;
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 判断某个选项当前是否处于「已选中」态。sxz 测验是 Vue 托管的，点击后 native input.checked
    // 会延迟到响应式 tick 之后才更新，因此除了读 input.checked，还兜底检查选项容器的选中态 class /
    // aria-checked，避免「明明点中了却被判定回填失败」。
    function isChoiceSelected(option) {
        const input = option && option.input;
        if (input && input.checked) return true;
        const nodes = [
            option && option.item,
            option && option.clickTarget,
            input && input.closest('.option-list-item, .el-radio, .el-checkbox')
        ];
        return nodes.some(node => {
            if (!node) return false;
            if (node.getAttribute && node.getAttribute('aria-checked') === 'true') return true;
            // 只认明确的「选中态」class，不收裸 active/selected：后者常被 hover/focus/ripple 常驻，
            // 在 input.checked 仍为 false 时会误判「已选中」，导致单选跳过点击却判成功、多选误点错项。
            return /(^|[\s_-])(is-checked|is-selected|is-active|checked|chosen)([\s_-]|$)/i.test(node.className || '');
        });
    }

    // 对单道题执行一次点选（按目标索引选中、并取消多选题里多余的勾选）。
    // forceInput=true 时直接点原生 input，用于第一轮 clickTarget 点击没生效后的补点。
    function selectQuestionOptions(question, validIndexes, forceInput) {
        question.options.forEach((option, idx) => {
            const shouldSelect = validIndexes.includes(idx);
            const input = option.input;
            if (!input || input.disabled) return;
            if (question.type === 'multiple') {
                if (isChoiceSelected(option) !== shouldSelect) clickAnswerInput(input, option.clickTarget, forceInput);
            } else if (shouldSelect && !isChoiceSelected(option)) {
                clickAnswerInput(input, option.clickTarget, forceInput);
            }
        });
    }

    async function applyAiAnswers(questions, modelAnswer) {
        // 先把模型答案归一成有效的作答目标，过滤越界 / 非法索引（避免点击页面上根本不存在的选项号）
        const targets = [];
        modelAnswer.answers.forEach(answer => {
            const question = questions.find(q => q.index === Number(answer.questionIndex));
            if (!question) return;
            const indexes = Array.isArray(answer.optionIndexes) ? answer.optionIndexes.map(Number) : [];
            const validIndexes = indexes.filter(i => Number.isInteger(i) && i >= 0 && i < question.options.length);
            if (validIndexes.length === 0) {
                console.log(`[华为助手 AI] 第 ${question.index} 题：模型返回索引 ${JSON.stringify(indexes)} 超出 0~${question.options.length - 1}，跳过回填且不计入已答（避免空答被推进）`);
                return;
            }
            targets.push({ question, validIndexes });
        });
        if (targets.length === 0) return 0;

        // 第一轮点选
        targets.forEach(({ question, validIndexes }) => selectQuestionOptions(question, validIndexes));

        // 等 Vue 响应式更新 / 选项组件就绪后验收；凡是没选中的，直接点原生 input 补一轮。
        // 这一步专治「测验前几题组件还没挂载好、点击没生效」导致的回填竞态。
        await delay(400);
        targets.forEach(({ question, validIndexes }) => {
            const allOk = validIndexes.every(i => isChoiceSelected(question.options[i]));
            if (!allOk) selectQuestionOptions(question, validIndexes, true);
        });
        await delay(300);

        // 用最终真实选中态统一验收单选 / 多选，只有确实选上才计入已答并允许推进。
        let applied = 0;
        targets.forEach(({ question, validIndexes }) => {
            // 只在「可点选」的目标里验收：selectQuestionOptions 对 disabled 选项直接跳过不点，
            // 若把禁用目标也算进多选的应选总数，会出现 selectedCount 永远 < 应选数 → 永不推进、每 120s 重试卡死。
            const selectable = validIndexes.filter(i => {
                const inp = question.options[i] && question.options[i].input;
                return inp && !inp.disabled;
            });
            const selectedCount = selectable.filter(i => isChoiceSelected(question.options[i])).length;
            const ok = question.type === 'multiple'
                ? (selectable.length > 0 && selectedCount === selectable.length)
                : selectedCount > 0;
            if (ok) {
                applied++;
            } else {
                console.log(`[华为助手 AI] 第 ${question.index} 题：两轮点选后仍未选中（验收失败），不推进（留待下一轮重试或人工处理）`);
            }
        });
        return applied;
    }

    function clickAnswerInput(input, clickTarget, forceInput) {
        // 只点一次：多选 checkbox 双击会相互抵消。第一轮点可视 clickTarget/label；
        // forceInput=true 的补点轮直接点原生 input，专治第一轮 clickTarget 点击没被组件接住的情况。
        const label = input.id ? document.querySelector(`label[for="${cssEscape(input.id)}"]`) : input.closest('label');
        const target = forceInput ? input : (clickTarget || label || input);
        try { target.click(); } catch (e) {}
        // 仅当直接点了原生 input 时才补发 input/change：点可视 clickTarget(普通 div)/label 时，
        // 此刻 input.checked 往往还是旧值(false)，强行 dispatch(change) 会带着 false 把刚被组件点亮的 Vue model 复位。
        // 点 label 会原生转发到 input 自行触发事件；点 div 由框架自身 @click 处理，都无需我们补发。
        if (target === input) {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function trySubmitAnswer() {
        lastTrySubmitTime = Date.now();
        const sxzNextBtn = Array.from(document.querySelectorAll('.test-content .subject-btn'))
            .filter(isVisibleElement)
            .find(el => /下一题|下一步|提交|完成/.test(normalizeText(el.innerText)));
        if (sxzNextBtn) {
            sxzNextBtn.click();
            reportAiStatus('已尝试自动进入下一题/提交', 'success');
            return;
        }

        const sxzSubmitBtn = Array.from(document.querySelectorAll('.test-content .submit-btn'))
            .filter(isVisibleElement)
            .find(el => /交卷|提交|完成/.test(normalizeText(el.innerText)));
        if (sxzSubmitBtn) {
            sxzSubmitBtn.click();
            // 登记交卷时间：交卷确认弹窗由 handlePopups 点「确定」，随后成绩页靠 quizSubmittedAt 触发
            // tryProceedToNextStage 进入下一讲，并在 90s 内抑制「开始测验」防止重进测验死循环。
            quizSubmittedAt = Date.now();
            reportAiStatus('已尝试自动交卷/提交', 'success');
            return;
        }

        const buttonTexts = ['下一题', '下一步', '保存', '提交', '交卷', '确定', '确认'];
        const buttons = Array.from(document.querySelectorAll('button, .el-button, [role="button"], input[type="button"], input[type="submit"]')).filter(isVisibleElement);
        const btn = buttons.find(el => {
            const text = normalizeText(el.innerText || el.value || el.getAttribute('aria-label') || '');
            return buttonTexts.some(keyword => text.includes(keyword));
        });
        if (btn) {
            btn.click();
            reportAiStatus('已尝试自动提交/进入下一题', 'success');
        }
    }

    // ===== AI 自动答题全流程驱动 =====
    // 在「启用 + 自动识别 + 自动提交」全开时，串联：进入测验 → 逐题作答 → 检查未答 → 交卷 → 进入下一环节。

    // 找到「开始测验 / 继续答题」入口按钮。
    function findQuizStartButton() {
        const direct = document.querySelector('.start-test');
        if (direct && isVisibleElement(direct)) return direct;
        return findQuizButtonByText(['开始测验', '开始答题', '开始考试', '继续测验', '继续答题', '进入测验', '立即测验', '马上测验']);
    }

    // 找到最终「交卷」按钮（区别于逐题的「下一题/提交」）。
    function findQuizSubmitButton() {
        const sxz = Array.from(document.querySelectorAll('.test-content .submit-btn, .submit-btn'))
            .filter(isVisibleElement)
            .find(el => /交卷|提交试卷|提交答卷|完成测验/.test(normalizeText(el.innerText)));
        if (sxz) return sxz;
        return findQuizButtonByText(['交卷', '提交试卷', '提交答卷', '完成测验']);
    }

    // 找到逐题推进按钮（下一题 / 提交本题）。
    function findQuizNextButton() {
        return Array.from(document.querySelectorAll('.test-content .subject-btn'))
            .filter(isVisibleElement)
            .find(el => /下一题|下一步|提交|完成|确定/.test(normalizeText(el.innerText))) || null;
    }

    // 进入下一个学习环节（答题结束后的结果页）。
    function tryProceedToNextStage() {
        // 优先点 sxz 学习页底部真实的「下一讲」控件（经真机确认：.switch-btn 内 .next，文案为「下一讲」）。
        // 这是测验交卷后进入下一节最可靠的入口；之前只找「下一节/下一章」等文案，命中不了「下一讲」，
        // 导致交卷后停在成绩页无法前进、90s 后又自动重进测验造成「反复重测」死循环。
        const switchNext = document.querySelector('.switch-btn .next, .outer_footer .next');
        if (switchNext && isVisibleElement(switchNext) && !/disabled|disable/i.test(switchNext.className || '')) {
            switchNext.click();
            reportAiStatus('正在进入下一讲', 'info');
            return true;
        }
        const btn = findQuizButtonByText(['下一讲', '下一节', '下一个', '下一章', '下一环节', '继续学习', '下一步', '继续']);
        if (btn) {
            btn.click();
            reportAiStatus('正在进入下一环节', 'info');
            return true;
        }
        return false;
    }

    // 按文本关键词在按钮类元素中查找（限制文本长度，避免误命中大容器）。
    function findQuizButtonByText(keywords) {
        const candidates = Array.from(document.querySelectorAll(
            'button, .el-button, [role="button"], input[type="button"], input[type="submit"], a, .subject-btn, .submit-btn, .start-test, [class*="btn" i]'
        )).filter(isVisibleElement);
        return candidates.find(el => {
            const text = normalizeText(el.innerText || el.value || el.getAttribute('aria-label') || '');
            if (!text || text.length > 12) return false;
            return keywords.some(kw => text.includes(kw));
        }) || null;
    }

    // 答题卡中明确标记为「未作答」的题目（仅在能正向识别未答标记时返回，避免死循环）。
    function findUnansweredCardItem() {
        const items = Array.from(document.querySelectorAll(
            '[class*="answer-card" i] [class*="item" i], [class*="answer-sheet" i] [class*="item" i], [class*="card-item" i], [class*="question-no" i], [class*="ques-no" i]'
        )).filter(isVisibleElement);
        if (items.length === 0) return null;
        return items.find(it => /un-?answer|no-?answer|undone|not-?done|wait|empty|gray|grey/i.test(it.className || '')) || null;
    }

    // 当前是否正处于「正在答题」的测验流程中（用于抑制盲区逃逸，避免半途跳走）。
    function shouldHoldForQuiz() {
        if (!AI_CONFIG.enabled || !AI_CONFIG.autoSolve) return false;
        if (quizSubmittedAt && Date.now() - quizSubmittedAt < 60000) return false; // 已交卷，放行让其进入下一环节
        if (document.querySelector('.test-content, .start-test')) return true;
        // 答题卡阶段：.test-content 可能已消失，但「交卷」按钮仍可见时同样 hold，防止提前逃逸
        return !!findQuizSubmitButton();
    }

    // 完成答题后的收尾：检查未答 → 交卷 → 进入下一环节。
    function finalizeQuiz() {
        const unanswered = findUnansweredCardItem();
        if (unanswered) {
            unanswered.click();
            reportAiStatus('发现未作答题目，正在返回作答', 'warn');
            return;
        }

        const submitBtn = findQuizSubmitButton();
        if (submitBtn) {
            submitBtn.click();
            quizSubmittedAt = Date.now();
            reportAiStatus('全部作答完成，已自动交卷', 'success');
            return; // 交卷确认弹窗由 handlePopups 自动点「确定」
        }

        const nextBtn = findQuizNextButton();
        if (nextBtn) {
            nextBtn.click();
            return;
        }

        if (quizSubmittedAt && tryProceedToNextStage()) quizSubmittedAt = 0;
    }

    // 自动答题主循环（每 5 秒）：逐题作答；空闲时进入测验 / 收尾交卷 / 进入下一环节。
    async function runAutoAiCycle() {
        AI_CONFIG = loadAiConfig();
        if (!AI_CONFIG.enabled || !AI_CONFIG.autoSolve) return;
        if (aiSolveLock) return;

        const questions = collectQuestionGroups();
        if (questions.length > 0) {
            const sig = buildQuestionSignature(questions);
            const dbgTitle = (questions[0] && questions[0].text || '').slice(0, 24);
            // 守卫①：本题刚刚点过「下一题」推进，但 DOM 还没换到下一题（过渡空窗，sig 没变）→ 本轮什么都不做，
            // 等下一题真正渲染出来(sig 变化)再处理。杜绝转场期对同一道题反复触发动作。
            if (sig === lastAdvancedSignature) {
                console.log(`[华为助手 AI][cycle] 已推进过、等待换题: ${dbgTitle}`);
                return;
            }
            // 本题尚未确认作答成功 → 先作答（回填+校验），本轮不推进。
            if (sig !== lastSolvedSignature) {
                console.log(`[华为助手 AI][cycle] 作答: ${dbgTitle} (lastSolved=${lastSolvedSignature.slice(0,16)})`);
                await solveQuestionsWithAi('auto');
            }
            // 仅当本题确已作答成功(lastSolvedSignature 命中) → 推进一次。
            // 「确认作答后才推进」是防跳题的核心：杜绝还没作答就点下一题。
            if (AI_CONFIG.autoSubmit && lastSolvedSignature === sig) {
                // 守卫②（关键）：作答期间(AI 网络延迟/Vue 重渲染)屏上题目可能已经变了。
                // 推进前重新读一次当前屏题，若已不是刚作答的这道题，绝不点「下一题」——
                // 否则会对刚渲染出来、还没作答的下一题点掉，造成「隔一题被自动跳过」。
                const liveSig = buildQuestionSignature(collectQuestionGroups());
                if (liveSig !== sig) {
                    console.log(`[华为助手 AI][cycle] 推进前发现已换题，放弃本次推进(防跳题): ${dbgTitle}`);
                    return;
                }
                lastAdvancedSignature = sig;
                console.log(`[华为助手 AI][cycle] 推进(下一题/交卷): ${dbgTitle}`);
                trySubmitAnswer();
            }
            return;
        }

        if (!AI_CONFIG.autoSubmit) return; // 仅回填、不导航

        // 刚交卷的 90s 内不再点击「开始测验」，防止在成绩页或重新进入入口时死循环重测
        const recentlySubmitted = quizSubmittedAt && Date.now() - quizSubmittedAt < 90000;
        if (!recentlySubmitted) {
            const startBtn = findQuizStartButton();
            if (startBtn) {
                startBtn.click();
                // 标记一次「刚发生导航」：进入测验后首题 DOM 往往要等若干毫秒才渲染，
                // 这期间 collectQuestionGroups 取不到题，下面 4s 空窗保护可避免 finalizeQuiz 误把首题跳过。
                lastTrySubmitTime = Date.now();
                reportAiStatus('已自动进入测验', 'info');
                return;
            }
        }

        if (document.querySelector('.test-content')) {
            // 关键防跳题：只要页面上还有可作答选项（题目在屏），就绝不调用 finalizeQuiz 去点「下一题」。
            // 走到这里说明 collectQuestionGroups 此刻没取到题，但选项还在 = 题目正在渲染或本轮解析失败，
            // 应等下一轮重新识别作答，而不是把这道还没作答的题直接点掉（这正是「题目被自动跳过」的根因）。
            if (document.querySelector('.test-content .option-list-item')) {
                reportAiStatus('题目加载中，等待识别作答...', 'info');
                return;
            }
            // 没有可作答选项了，但刚点过「下一题/提交」：仍处于题目间过渡空窗，给下一题渲染留时间，
            // 否则会在空窗里点到下一题按钮，把紧随其后渲染出来的题跳过。
            if (Date.now() - lastTrySubmitTime < 4000) {
                reportAiStatus('等待下一题加载...', 'info');
                return;
            }
            // 确实没有可作答选项（答题卡 / 末尾收尾阶段）才进入收尾：检查未答 → 交卷 → 进入下一环节。
            finalizeQuiz();
            return;
        }

        // 答题卡阶段：.test-content 已不存在，但「交卷」按钮可见时直接交卷
        const pendingSubmit = findQuizSubmitButton();
        if (pendingSubmit) {
            pendingSubmit.click();
            quizSubmittedAt = Date.now();
            reportAiStatus('全部作答完成，已自动交卷', 'success');
            return;
        }

        if (quizSubmittedAt && Date.now() - quizSubmittedAt < 120000) {
            if (tryProceedToNextStage()) {
                quizSubmittedAt = 0;
                // 已进入下一讲，清空本测验的作答/推进签名，避免残留影响下一处测验的判定
                lastSolvedSignature = '';
                lastAdvancedSignature = '';
            }
        }
    }

    function isVisibleElement(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    function isUsableChoiceInput(input) {
        if (!input || input.disabled || input.closest('#hw-global-panel')) return false;
        if (isVisibleElement(input)) return true;
        const visualOption = input.closest('label, .el-radio, .el-checkbox, [class*="option" i], [class*="answer" i], li');
        return isVisibleElement(visualOption);
    }

    function normalizeText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function stripOptionPrefix(text) {
        return normalizeText(text).replace(/^[A-Ha-h][.、:：\s]+/, '').replace(/^选项\s*\d+[.、:：\s]*/, '');
    }

    function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function cssEscape(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/["\\]/g, '\\$&');
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'HW_AI_SOLVE_REQUEST') solveQuestionsWithAi('manual');
        if (msg.type === 'HW_AI_CONFIG_CHANGED') AI_CONFIG = loadAiConfig();
        if (IS_TOP && msg.type === 'HW_AI_STATUS') updateAiStatus(msg.data);
    });

    setInterval(() => { runAutoAiCycle(); }, 5000);

    // ==========================================
    // 架构 A：顶层窗口（中央大脑状态融合）
    // ==========================================
    if (IS_TOP) {
        let panelElement = null;
        let isCollapsed = false;
        let countdownValue = 0;
        let countdownTimer = null;
        let jumpLock = false;
        let quizHoldTimer = null; // 课程 iframe 做题时抑制逃逸倒计时

        let globalState = {
            title: "正在定位课程...",
            status: "等待同步...",
            progress: "00:00 / 00:00 (0%)",
            videoEnded: false,
            quizHoldActive: false  // 任意子 iframe 正在做题时为 true
        };

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'HW_FRAME_REPORT') {
                const incoming = msg.data;
                let isAltered = false;

                // 课程 iframe 正在做题：刷新 hold 并取消已启动的逃逸倒计时
                if (incoming.holdForQuiz) {
                    globalState.quizHoldActive = true;
                    clearTimeout(quizHoldTimer);
                    quizHoldTimer = setTimeout(() => { globalState.quizHoldActive = false; }, 3000);
                    if (countdownTimer && countdownValue > 0) {
                        clearInterval(countdownTimer);
                        countdownTimer = null;
                        countdownValue = 0;
                        jumpLock = false;
                        globalState.videoEnded = false;
                        updatePanelUI();
                    }
                }

                if (incoming.hasCatalog && incoming.title && globalState.title !== incoming.title) {
                    globalState.title = incoming.title;
                    isAltered = true;
                }

                if (incoming.hasVideo) {
                    const newProgress = `${incoming.cur} / ${incoming.dur} (${incoming.pct}%)`;
                    let newStatus = incoming.isEscape ? "⚠️ 检测到非视频盲区，准备逃逸..." : "正在播放";
                    if (incoming.ended && !incoming.isEscape) newStatus = "本节已完成";
                    else if (incoming.playBlocked) newStatus = "⚠️ 自动播放被拦截，请点击视频";
                    else if (incoming.paused && !incoming.isEscape) newStatus = "已暂停";

                    if (globalState.progress !== newProgress || globalState.status !== newStatus || globalState.videoEnded !== incoming.ended) {
                        globalState.progress = newProgress;
                        globalState.status = newStatus;
                        globalState.videoEnded = incoming.ended;
                        isAltered = true;
                    }
                }

                if (isAltered) updatePanelUI();

                // quizHoldActive 时不启动逃逸倒计时，等 hold 过期后自然触发
                if (globalState.videoEnded && CONFIG.autoNext && !jumpLock && !globalState.quizHoldActive) {
                    jumpLock = true;
                    startCentralCountdown();
                }

                if (event.source) {
                    event.source.postMessage({ type: 'HW_CONFIG_SYNC', data: CONFIG }, '*');
                }
            }
        });

        const checkExist = setInterval(() => {
            if (document.body && !document.getElementById('hw-global-panel')) {
                initGlobalPanel();
                clearInterval(checkExist);
            }
        }, 1000);

        // 给 iframe 注入 autoplay 权限，解决跨域 iframe 自动播放被浏览器拦截的问题
        (function patchIframeAutoplay() {
            const addAutoplay = (el) => {
                if (el.nodeName !== 'IFRAME') return;
                const cur = el.getAttribute('allow') || '';
                if (!cur.includes('autoplay')) {
                    el.setAttribute('allow', cur ? cur + '; autoplay' : 'autoplay');
                }
            };
            document.querySelectorAll('iframe').forEach(addAutoplay);
            new MutationObserver(mutations => {
                for (const m of mutations) {
                    m.addedNodes.forEach(node => {
                        if (node.nodeName === 'IFRAME') { addAutoplay(node); return; }
                        if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(addAutoplay);
                    });
                }
            }).observe(document.documentElement, { childList: true, subtree: true });
        })();

        function initGlobalPanel() {
            panelElement = document.createElement('div');
            panelElement.id = 'hw-global-panel';
            panelElement.style.cssText = `
                position: fixed; top: 120px; right: 40px; z-index: 2147483647; 
                width: 320px; background: #ffffff; border: 1px solid #dcdfe6;
                border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.18);
                font-family: system-ui, sans-serif; font-size: 12px; color: #303133; 
                padding: 12px; box-sizing: border-box; user-select: none;
                transition: width 0.15s ease;
            `;

            panelElement.innerHTML = `
                <div id="hw-drag-head" style="font-weight: bold; color: #ee0000; border-bottom: 1px solid #ebeef5; margin-bottom: 8px; padding-bottom: 6px; cursor: move; display: flex; justify-content: space-between; align-items: center;">
                    <span id="hw-panel-title">华为助手 v1.3.13</span>
                    <span id="btn-fold" style="cursor: pointer; font-family: monospace; font-size: 14px; font-weight: bold; color: #909399; padding: 0 6px; background: #f4f4f5; border-radius: 3px;">[-]</span>
                </div>
                <div id="hw-panel-body">
                    <div style="background: #f8f9fa; border-radius: 6px; padding: 8px; margin-bottom: 8px; border: 1px solid #f2f6fc;">
                        <div style="margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            <b style="color: #606266;">当前课时:</b> <span id="lbl-title">-</span>
                        </div>
                        <div style="margin-bottom: 5px; display: flex; justify-content: space-between;">
                            <span><b style="color: #606266;">状态:</b> <span id="lbl-status">-</span></span>
                        </div>
                        <div>
                            <b style="color: #606266;">进度:</b> <span id="lbl-progress" style="font-family: monospace;">00:00 / 00:00</span>
                        </div>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <label style="cursor: pointer; display: flex; align-items: center;">
                            <input type="checkbox" id="chk-auto" ${CONFIG.autoNext ? 'checked' : ''} style="margin: 0 4px 0 0; cursor: pointer;"> 自动连播
                        </label>
                        <div style="display: flex; align-items: center;">
                            <span>倍速:</span>
                            <input type="number" id="num-speed" value="${CONFIG.playbackSpeed}" step="0.5" min="0.5" max="4.0" style="width: 45px; margin-left: 4px; padding: 1px 3px; border: 1px solid #dcdfe6; border-radius: 4px; text-align: center;">
                        </div>
                    </div>
                    <div style="margin-top: 6px;">
                        <label style="cursor: pointer; display: flex; align-items: center;">
                            <input type="checkbox" id="chk-courseware" ${CONFIG.autoCourseware ? 'checked' : ''} style="margin: 0 4px 0 0; cursor: pointer;"> 自动刷课件<span style="color:#909399; margin-left:4px;">(PPT 翻到末页再进下一节)</span>
                        </label>
                    </div>
                    <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #ebeef5;">
                        <div style="font-weight: bold; color: #606266; margin-bottom: 6px;">AI 做题</div>
                        <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 6px; flex-wrap: wrap;">
                            <label style="cursor: pointer; display: flex; align-items: center;">
                                <input type="checkbox" id="chk-ai-enabled" ${AI_CONFIG.enabled ? 'checked' : ''} style="margin: 0 4px 0 0;"> 启用
                            </label>
                            <label style="cursor: pointer; display: flex; align-items: center;">
                                <input type="checkbox" id="chk-ai-auto" ${AI_CONFIG.autoSolve ? 'checked' : ''} style="margin: 0 4px 0 0;"> 自动识别
                            </label>
                            <label style="cursor: pointer; display: flex; align-items: center;">
                                <input type="checkbox" id="chk-ai-submit" ${AI_CONFIG.autoSubmit ? 'checked' : ''} style="margin: 0 4px 0 0;"> 自动提交
                            </label>
                        </div>
                        <div style="display: grid; grid-template-columns: 72px 1fr; gap: 5px 6px; align-items: center;">
                            <span style="color: #606266;">模型源</span>
                            <select id="sel-ai-provider" style="width: 100%; border: 1px solid #dcdfe6; border-radius: 4px; padding: 2px 4px;">
                                ${Object.keys(AI_PROVIDERS).map(key => `<option value="${key}" ${AI_CONFIG.provider === key ? 'selected' : ''}>${AI_PROVIDERS[key].label}</option>`).join('')}
                            </select>
                            <span style="color: #606266;">模型名</span>
                            <input type="text" id="txt-ai-model" style="width: 100%; min-width: 0; border: 1px solid #dcdfe6; border-radius: 4px; padding: 2px 4px; box-sizing: border-box;">
                            <span style="color: #606266;">API Key</span>
                            <input type="password" id="txt-ai-key" autocomplete="off" placeholder="仅保存在本地" style="width: 100%; min-width: 0; border: 1px solid #dcdfe6; border-radius: 4px; padding: 2px 4px; box-sizing: border-box;">
                        </div>
                        <div style="display: flex; gap: 6px; margin-top: 7px;">
                            <button id="btn-ai-save" type="button" style="flex: 1; border: 1px solid #dcdfe6; border-radius: 4px; background: #f4f4f5; color: #606266; cursor: pointer; padding: 4px 0;">保存</button>
                            <button id="btn-ai-solve" type="button" style="flex: 1; border: 1px solid #ee0000; border-radius: 4px; background: #ee0000; color: #fff; cursor: pointer; padding: 4px 0;">识别做题</button>
                        </div>
                        <div id="lbl-ai-status" style="margin-top: 6px; color: #909399; line-height: 1.4;">${AI_CONFIG.enabled ? 'AI 已启用' : 'AI 未启用'}</div>
                    </div>
                </div>
                <div id="hw-panel-mini" style="display: none; text-align: center; font-weight: bold; padding: 4px 0; color: #67c23a;">
                    <span id="lbl-mini-status">播放中</span>
                </div>
            `;

            document.body.appendChild(panelElement);

            panelElement.querySelector('#chk-auto').addEventListener('change', (e) => { CONFIG.autoNext = e.target.checked; broadcastConfig(); });
            panelElement.querySelector('#chk-courseware').addEventListener('change', (e) => { CONFIG.autoCourseware = e.target.checked; broadcastConfig(); });
            panelElement.querySelector('#num-speed').addEventListener('input', (e) => {
                let val = parseFloat(e.target.value);
                if (!isNaN(val)) { CONFIG.playbackSpeed = val; broadcastConfig(); }
            });
            bindAiPanelControls();

            panelElement.querySelector('#btn-fold').addEventListener('click', function() {
                const body = panelElement.querySelector('#hw-panel-body');
                const mini = panelElement.querySelector('#hw-panel-mini');
                isCollapsed = !isCollapsed;

                if (isCollapsed) {
                    body.style.display = 'none';
                    mini.style.display = 'block';
                    this.innerText = '[+]';
                    panelElement.style.width = '140px';
                    panelElement.querySelector('#hw-panel-title').innerText = '助手';
                } else {
                    body.style.display = 'block';
                    mini.style.display = 'none';
                    this.innerText = '[-]';
                    panelElement.style.width = '320px';
                    panelElement.querySelector('#hw-panel-title').innerText = '华为助手 v1.3.13';
                }
                updatePanelUI();
            });

            (function setupFullScreenDrag() {
                const head = panelElement.querySelector('#hw-drag-head');
                let moving = false; let diffX = 0, diffY = 0;
                head.addEventListener('mousedown', (e) => {
                    moving = true;
                    diffX = e.clientX - panelElement.offsetLeft;
                    diffY = e.clientY - panelElement.offsetTop;
                    e.preventDefault();
                });
                document.addEventListener('mousemove', (e) => {
                    if (!moving) return;
                    let tx = e.clientX - diffX; let ty = e.clientY - diffY;
                    tx = Math.max(0, Math.min(window.innerWidth - panelElement.offsetWidth, tx));
                    ty = Math.max(0, Math.min(window.innerHeight - panelElement.offsetHeight, ty));
                    panelElement.style.left = tx + 'px'; panelElement.style.top = ty + 'px';
                    panelElement.style.right = 'auto';
                });
                document.addEventListener('mouseup', () => { moving = false; });
            })();

            updatePanelUI();
        }

        function bindAiPanelControls() {
            const providerSelect = panelElement.querySelector('#sel-ai-provider');
            const modelInput = panelElement.querySelector('#txt-ai-model');
            const keyInput = panelElement.querySelector('#txt-ai-key');
            const enabledInput = panelElement.querySelector('#chk-ai-enabled');
            const autoInput = panelElement.querySelector('#chk-ai-auto');
            const submitInput = panelElement.querySelector('#chk-ai-submit');

            const fillProviderFields = () => {
                AI_CONFIG = loadAiConfig();
                const provider = providerSelect.value;
                const providerMeta = AI_PROVIDERS[provider] || AI_PROVIDERS.deepseek;
                modelInput.value = AI_CONFIG.models[provider] || providerMeta.defaultModel;
                keyInput.value = AI_CONFIG.apiKeys[provider] || '';
            };

            const persist = () => {
                const provider = providerSelect.value;
                AI_CONFIG = saveAiConfig({
                    ...loadAiConfig(),
                    enabled: enabledInput.checked,
                    autoSolve: autoInput.checked,
                    autoSubmit: submitInput.checked,
                    provider,
                    apiKeys: { ...AI_CONFIG.apiKeys, [provider]: keyInput.value.trim() },
                    models: { ...AI_CONFIG.models, [provider]: modelInput.value.trim() || AI_PROVIDERS[provider].defaultModel }
                });
                updateAiStatus({ message: 'AI 配置已保存', level: 'success' });
                document.querySelectorAll('iframe').forEach(ifr => {
                    try { ifr.contentWindow.postMessage({ type: 'HW_AI_CONFIG_CHANGED' }, '*'); } catch (e) {}
                });
            };

            providerSelect.addEventListener('change', fillProviderFields);
            panelElement.querySelector('#btn-ai-save').addEventListener('click', persist);
            panelElement.querySelector('#btn-ai-solve').addEventListener('click', () => {
                persist();
                requestAiSolveFromAllFrames();
            });
            fillProviderFields();
        }

        function startCentralCountdown() {
            const ms = Math.floor(Math.random() * (CONFIG.maxDelay - CONFIG.minDelay) + CONFIG.minDelay);
            countdownValue = Math.round(ms / 1000);
            updatePanelUI();

            if (countdownTimer) clearInterval(countdownTimer);
            countdownTimer = setInterval(() => {
                countdownValue--;
                updatePanelUI();

                if (countdownValue <= 0) {
                    clearInterval(countdownTimer);
                    document.querySelectorAll('iframe').forEach(ifr => {
                        try { ifr.contentWindow.postMessage({ type: 'HW_COMMAND_JUMP' }, '*'); } catch(e){}
                    });

                    setTimeout(() => {
                        jumpLock = false;
                        globalState.videoEnded = false;
                    }, 5000);
                }
            }, 1000);
        }

        function updatePanelUI() {
            if (!panelElement) return;
            panelElement.querySelector('#lbl-title').innerText = globalState.title;
            panelElement.querySelector('#lbl-progress').innerText = globalState.progress;
            const statusEl = panelElement.querySelector('#lbl-status');
            
            if (countdownValue > 0) {
                statusEl.innerText = `⏱️ ${countdownValue}s 后跳转`;
                statusEl.style.color = "#f56c6c";
            } else {
                statusEl.innerText = globalState.status;
                if (globalState.status.includes('播放')) statusEl.style.color = "#67c23a";
                else if (globalState.status.includes('逃逸') || globalState.status.includes('完成')) statusEl.style.color = "#f56c6c";
                else statusEl.style.color = "#e6a23c";
            }
        }

        function broadcastConfig() {
            document.querySelectorAll('iframe').forEach(ifr => {
                try { ifr.contentWindow.postMessage({ type: 'HW_CONFIG_SYNC', data: CONFIG }, '*'); } catch(e){}
            });
        }
    }

    // ==========================================
    // 架构 B：子框架环境（时序自适应导航执行引擎）
    // ==========================================
    if (!IS_TOP) {
        // 全局敏感黑名单特征词
        const BLACKLIST_KEYWORDS = ['课件', '测验', '考试', '作业', '练习', '文档', '资料'];
        // 测验类节点：开启 AI 自动识别时不跳过、落到该节点交给 runAutoAiCycle 自动开始测验并答题
        const QUIZ_KEYWORDS = ['测验', '考试'];

        // 课件翻页状态：coursewareFlipping 防重入（一次只翻一遍），coursewareFlipDone 翻到末页后置 true 放行逃逸推进。
        // lastCoursewareTitle 记录上一次处理的课件标题：目录树与 PPT 内容可能不在同一 iframe（各 frame 变量独立），
        // 且 SPA 切课不重载 iframe，仅靠 doJumpV21 重置不可靠，故以「激活节点标题变化」为准重置翻页状态，跨节点/跨 frame 都稳。
        let coursewareFlipping = false;
        let coursewareFlipDone = false;
        let lastCoursewareTitle = '';
        // 测验节点「按住逃逸」起始时刻：开启 AI 自动识别后落到测验节点即按住，交给 AI 流程；
        // 带兜底超时，防止测验 UI 始终加载不出来 / AI 一直失败时永久卡在该节点。
        let lastQuizTitle = '';
        let quizHoldStartedAt = 0;

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'HW_CONFIG_SYNC') {
                CONFIG.autoNext = msg.data.autoNext;
                CONFIG.playbackSpeed = msg.data.playbackSpeed;
                if (typeof msg.data.autoCourseware === 'boolean') CONFIG.autoCourseware = msg.data.autoCourseware;
                if (typeof msg.data.coursewarePageDelay === 'number') CONFIG.coursewarePageDelay = msg.data.coursewarePageDelay;
                // 继续向本帧的子 iframe 下发：站点是 3 层嵌套(顶层→.sxz-iframe→#edmPage 课件帧)，
                // 顶层 broadcastConfig 只到直接子帧，靠这一步逐级把配置（含 autoCourseware）下沉到最深的 PPT 帧。
                document.querySelectorAll('iframe').forEach(ifr => {
                    try { ifr.contentWindow.postMessage({ type: 'HW_CONFIG_SYNC', data: CONFIG }, '*'); } catch (e) {}
                });
            }

            // 子帧 #edmPage 报告 PPT 已翻到末页：本帧（课件节点所在的目录帧 L2）放行逃逸推进
            if (msg.type === 'HW_COURSEWARE_DONE') {
                coursewareFlipDone = true;
            }

            if (msg.type === 'HW_COMMAND_JUMP') {
                doJumpV21();
            }
        });

        setInterval(function pureIframeScanner() {
            const video = document.querySelector('video');
            const activeNode = document.querySelector('[class*="current" i] .text, [class*="active" i] .text, .is-current .text, .is-active .text, .is-current, .is-active');

            // 如果此 iframe 正在做题（有 .test-content），主动告知顶层抑制逃逸倒计时
            // 解决：目录 iframe 发出 isEscape 时，顶层不知道课程 iframe 正在做题
            if (shouldHoldForQuiz()) {
                window.top.postMessage({ type: 'HW_FRAME_REPORT', data: { holdForQuiz: true } }, '*');
            }

            // 【PPT 课件帧】#edmPage（最深一层）：有翻页页脚 .footer-left、无 video。优先于目录逻辑判定，
            // 以免该帧里零散的 .active 元素被误当目录节点。这一帧负责真正逐页翻 PPT，翻完发 HW_COURSEWARE_DONE 通知父帧(L2)推进。
            if (!video && document.querySelector('.footer-left')) {
                // 借顶层 report→reply 机制拿到最新 CONFIG（含 autoCourseware）——该帧本不上报，否则收不到配置
                window.top.postMessage({ type: 'HW_FRAME_REPORT', data: { isPptFrame: true } }, '*');
                if (CONFIG.autoCourseware && !coursewareFlipDone) runCoursewareFlip();
                return;
            }

            if (!video && !activeNode) return;

            let packet = { hasVideo: false, hasCatalog: false, isEscape: false };

            if (video) {
                if (video.playbackRate !== CONFIG.playbackSpeed) video.playbackRate = CONFIG.playbackSpeed;
                if (video.paused && !video.ended && !video.seeking && video.readyState >= 2) {
                    video.play().catch(e => {
                        if (e && e.name === 'NotAllowedError') {
                            packet.playBlocked = true;
                        }
                    });
                }

                packet.hasVideo = true;
                packet.ended = video.ended;
                packet.paused = video.paused;
                packet.cur = formatTime(video.currentTime);
                packet.dur = formatTime(video.duration);
                packet.pct = video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0;
            }

            if (activeNode) {
                packet.hasCatalog = true;
                const nodeTitle = activeNode.getAttribute('title') || activeNode.innerText.trim().split('\n')[0];
                packet.title = nodeTitle;

                // 【防御机制二：黑洞触底逃逸】
                // 如果当前页面激活了非视频节点且页面中找不到 video 标签，强行伪装已结束状态触发弹飞
                if (!video) {
                    const isTargetBlack = BLACKLIST_KEYWORDS.some(kw => nodeTitle.includes(kw));
                    const aiAuto = !!(AI_CONFIG && AI_CONFIG.enabled && AI_CONFIG.autoSolve);
                    // 课件分流：开启「自动刷课件」且当前节点是课件/阅读类（命中 COURSEWARE_KEYWORDS），
                    // 不直接逃逸，先把 PPT 逐页翻到末页（runCoursewareFlip），翻完才允许伪装 ended 推进。
                    const isCourseware = CONFIG.autoCourseware && COURSEWARE_KEYWORDS.some(kw => nodeTitle.includes(kw));
                    // 测验分流：开启 AI 自动识别时，测验/考试节点按住逃逸，交给 runAutoAiCycle 自动做题（覆盖刚落到节点、
                    // .test-content 还没加载出来的空窗期；活跃答题期间 shouldHoldForQuiz 另有保护）。带 5 分钟兜底超时防永久卡死。
                    const isQuizNode = aiAuto && QUIZ_KEYWORDS.some(kw => nodeTitle.includes(kw));
                    // 切到新的课件节点（标题变化）即重置完成标记：等子帧 #edmPage 重新把新 PPT 翻完再推进
                    if (isCourseware && nodeTitle !== lastCoursewareTitle) {
                        lastCoursewareTitle = nodeTitle;
                        coursewareFlipDone = false;
                    }
                    // 落到新的测验节点（标题变化）即记录按住起始时刻
                    if (isQuizNode && nodeTitle !== lastQuizTitle) {
                        lastQuizTitle = nodeTitle;
                        quizHoldStartedAt = Date.now();
                    }
                    // 课件分流：开启自动刷课件时「按住逃逸」，直到子帧 #edmPage 把 PPT 翻到末页(发来 HW_COURSEWARE_DONE
                    // 令 coursewareFlipDone=true)，此后落到下方 isTargetBlack 分支伪装 ended 推进。关闭时课件仍走原逃逸（沿用旧「跳过」）。
                    if (isCourseware && !coursewareFlipDone) {
                        // 按住不逃逸，等待子帧翻页完成
                    } else if (isQuizNode && (Date.now() - quizHoldStartedAt < 5 * 60 * 1000)) {
                        // 按住不逃逸，交给 AI 做题流程（开始测验→逐题作答→交卷→点「下一节」自动推进）
                    } else if (isTargetBlack && !shouldHoldForQuiz()) {
                        packet.hasVideo = true;
                        packet.ended = true;
                        packet.isEscape = true;
                        packet.cur = "00:00";
                        packet.dur = "00:00";
                        packet.pct = 100;
                    }
                }
            }

            window.top.postMessage({ type: 'HW_FRAME_REPORT', data: packet }, '*');
        }, 500);

        // 【核心控制算法 v2.1】
        function doJumpV21() {
            const treeContainer = document.querySelector('.catalog-tree, .el-tree, [class*="catalog" i][class*="tree" i], [class*="course-chapter" i]');
            if (!treeContainer) { fallbackNextButton(); return; }

            // 收集行组件
            let allRows = Array.from(treeContainer.querySelectorAll('.el-tree-node__content, .tree-node-content, [class*="node-content" i], [class*="item-content" i], [class*="chapter-item" i]'));
            if (allRows.length === 0) {
                const textNodes = treeContainer.querySelectorAll('.text, .tree-node-text, [class*="text" i], [class*="title" i]');
                allRows = Array.from(textNodes).map(t => t.closest('div') || t.parentElement).filter(Boolean);
            }
            allRows = allRows.filter((el, idx, self) => self.indexOf(el) === idx && el.innerText.trim().length > 0);
            if (allRows.length === 0) { fallbackNextButton(); return; }

            // 寻找当前定位
            const activeEl = treeContainer.querySelector('.is-current, .is-active, .active, .current, [class*="current" i], [class*="active" i]');
            if (!activeEl) { fallbackNextButton(); return; }

            let currentIndex = allRows.findIndex(row => row === activeEl || row.contains(activeEl) || activeEl.contains(row));
            if (currentIndex === -1) {
                const activeText = activeEl.innerText.trim().split('\n')[0];
                currentIndex = allRows.findIndex(row => row.innerText.trim().includes(activeText));
            }
            if (currentIndex === -1) { fallbackNextButton(); return; }

            // 顺序迭代寻路状态机
            let targetIndex = currentIndex + 1;
            while (targetIndex < allRows.length) {
                const nextRow = allRows[targetIndex];
                const rowText = nextRow.innerText.trim();

                // 【防御机制一：前置特征拦截】
                // 检查下一行文本是否命中非视频黑名单，若命中则直接跳过此节点继续向下检索
                // 例外一：开启「自动刷课件」时，课件/阅读类节点（命中 COURSEWARE_KEYWORDS）不跳过，落到课件由 scanner 触发翻页。
                // 例外二：开启 AI 自动识别时，测验/考试节点（命中 QUIZ_KEYWORDS）不跳过，落到测验由 runAutoAiCycle 自动做题。
                const isCoursewareRow = CONFIG.autoCourseware && COURSEWARE_KEYWORDS.some(kw => rowText.includes(kw));
                const aiAuto = !!(AI_CONFIG && AI_CONFIG.enabled && AI_CONFIG.autoSolve);
                const isQuizRow = aiAuto && QUIZ_KEYWORDS.some(kw => rowText.includes(kw));
                const hitBlacklist = !isCoursewareRow && !isQuizRow && BLACKLIST_KEYWORDS.some(kw => rowText.includes(kw));
                if (hitBlacklist) {
                    console.log(`[助手 v2.1] 发现非视频盲区 [${rowText.split('\n')[0]}]，已自动执行跃迁避让。`);
                    targetIndex++;
                    continue;
                }
                if (isCoursewareRow) {
                    console.log(`[助手 v2.1] 命中课件节点 [${rowText.split('\n')[0]}]，自动刷课件已开启，切入并逐页翻阅。`);
                    coursewareFlipDone = false; // 进入新课件，重置翻页完成标记
                    clickTreeRow(nextRow, false);
                    return;
                }
                if (isQuizRow) {
                    console.log(`[助手 v2.1] 命中测验节点 [${rowText.split('\n')[0]}]，AI 自动识别已开启，切入交给自动做题流程。`);
                    clickTreeRow(nextRow, false);
                    return;
                }

                const nodeStatus = getRowVueOrDomStatus(nextRow);

                if (nodeStatus.isFolder) {
                    if (!nodeStatus.isExpanded) {
                        console.log(`[助手 v2.1] 发现折叠父目录 ${rowText}，正在精准执行通道展开...`);
                        clickTreeRow(nextRow, true);
                        return; 
                    } else {
                        targetIndex++;
                        continue;
                    }
                } else {
                    console.log(`[助手 v2.1] 路径已扫清，正在切入目标视频课时: ${rowText}`);
                    clickTreeRow(nextRow, false);
                    return;
                }
            }

            fallbackNextButton();
        }

        function getRowVueOrDomStatus(row) {
            let currentEl = row;
            for (let i = 0; i < 3 && currentEl; i++) {
                if (currentEl.__vue__) {
                    const v = currentEl.__vue__;
                    if (v.node) return { isFolder: !v.node.isLeaf, isExpanded: v.node.expanded };
                    if (v.item) return { isFolder: !!(v.item.children && v.item.children.length) || !!v.item.isFolder, isExpanded: !!v.item.expanded };
                }
                currentEl = currentEl.parentElement;
            }
            const treeNode = row.closest('.tree-node, .el-tree-node, [class*="node" i]');
            if (treeNode) {
                const isExpanded = treeNode.classList.contains('is-expanded') || treeNode.classList.contains('expanded') || treeNode.getAttribute('aria-expanded') === 'true';
                const isLeaf = treeNode.classList.contains('is-leaf') || !!treeNode.querySelector('.is-leaf') || treeNode.getAttribute('aria-is-leaf') === 'true';
                const hasChildren = !!treeNode.querySelector('.tree-node-children, .el-tree-node__children, [class*="children" i]');
                const hasArrow = !!treeNode.querySelector('[class*="arrow" i], [class*="caret" i], [class*="expand" i]');
                return { isFolder: !isLeaf && (hasChildren || hasArrow), isExpanded: isExpanded };
            }
            const html = row.innerHTML;
            return { isFolder: html.includes('arrow') || html.includes('caret') || html.includes('chevron'), isExpanded: html.includes('down') || html.includes('expanded') };
        }

        function clickTreeRow(row, isFolder) {
            if (isFolder) {
                const arrowIcon = row.querySelector('[class*="arrow" i], [class*="caret" i], [class*="expand" i], .el-tree-node__expand-icon');
                if (arrowIcon && arrowIcon.offsetParent) { arrowIcon.click(); return; }
            }
            row.click();
        }

        function fallbackNextButton() {
            const selectors = ['.next-btn', '.course-next-item', '.kltCourse-btn-next', 'button[title*="下一节"]', '[class*="next" i]'];
            for (let s of selectors) {
                let btn = document.querySelector(s);
                if (btn && btn.offsetParent) { btn.click(); break; }
            }
        }

        // 【自动刷课件：edm PPT 逐页翻页例程】
        // 由 scanner 在「PPT 课件帧」(#edmPage，含 .footer-left 翻页页脚的最深一层 iframe) 内调用。
        // 真实结构（实测 talent.shixizhi.huawei.com 的 edm3client）：.footer-left 内顺序为
        //   [img.footer-icon 首页, img.footer-icon 上一页, span 页码"43 / 43", img.footer-icon 下一页, img.footer-icon 尾页]，
        // 翻页图标是纯 <img>（无文字/aria），到边界时该图标加 id="preventPoint" 且 cursor:not-allowed。
        // 逐页点「下一页」直至触底（图标禁用 或 当前页>=总页），间隔 CONFIG.coursewarePageDelay，setTimeout 递进不阻塞；
        // 翻完置 coursewareFlipDone=true 并 postMessage(HW_COURSEWARE_DONE) 通知父帧(L2 目录帧)放行推进。
        function runCoursewareFlip() {
            if (coursewareFlipping || coursewareFlipDone) return; // 防重入：同一 PPT 只翻一遍
            coursewareFlipping = true;

            const startedAt = Date.now();
            const MAX_PAGES = 300;          // 安全上限：最多翻 300 页
            const MAX_TOTAL_MS = 10 * 60 * 1000; // 总超时：10 分钟兜底，避免死循环
            let flipped = 0;
            let stalls = 0;                 // 连续点击后页码未变化的次数（防卡死）

            // 读取 edm 页脚页码 .footer-left > span，文本如 "43  /   43"（空格不规则，先压缩空白再按 / 拆）。
            // 返回 { cur, total } 或 null。
            function readPageNum() {
                const footer = document.querySelector('.footer-left');
                const span = footer && footer.querySelector('span');
                if (!span) return null;
                const m = (span.textContent || '').replace(/\s+/g, '').match(/^(\d+)\/(\d+)$/);
                if (!m) return null;
                return { cur: parseInt(m[1], 10), total: parseInt(m[2], 10) };
            }

            // 探测「下一页」图标：edm 结构里它是页码 span 之后的第一个 .footer-icon。
            // 到末页时该图标 id="preventPoint" 或 cursor:not-allowed，视为禁用（已到末页）。
            // 兜底：若非 edm 结构，再按文本「下一页」/ class next/right/arrow 启发式找。
            function findNextPageBtn() {
                const footer = document.querySelector('.footer-left');
                if (footer) {
                    const span = footer.querySelector('span');
                    const icon = span && span.nextElementSibling;
                    if (icon && icon.classList && icon.classList.contains('footer-icon')) {
                        let cursor = '';
                        try { cursor = getComputedStyle(icon).cursor || ''; } catch (e) {}
                        const disabled = icon.id === 'preventPoint' || /not-allowed/i.test(cursor);
                        return disabled ? { atEnd: true, el: null } : { atEnd: false, el: icon };
                    }
                }
                const candidates = Array.from(document.querySelectorAll(
                    'button, a, [role="button"], [class*="next" i], [class*="right" i], [class*="arrow" i]'
                ));
                const TEXT_KW = ['下一页', '下一张', '下页', '后一页'];
                for (const el of candidates) {
                    if (!el.offsetParent) continue;
                    const disabled = el.disabled === true
                        || el.getAttribute('disabled') !== null
                        || el.getAttribute('aria-disabled') === 'true'
                        || /disabled/i.test(el.className || '');
                    const text = (el.innerText || el.textContent || '').replace(/\s+/g, '');
                    const cls = (el.className && el.className.toString ? el.className.toString() : '') || '';
                    if (!TEXT_KW.some(kw => text.includes(kw)) && !/next|right|arrow/i.test(cls)) continue;
                    if (disabled) return { atEnd: true, el: null };
                    return { atEnd: false, el };
                }
                return null;
            }

            // edm 翻页图标是 better-scroll 组件，只认完整指针/鼠标事件序列，裸 .click() 翻不动（实测无反应）。
            // 派发 pointerdown→mousedown→pointerup→mouseup→click（带坐标，PointerEvent 不可用时退回 MouseEvent）。
            function realClick(el) {
                const d = el.ownerDocument, w = d.defaultView, r = el.getBoundingClientRect();
                const o = {
                    bubbles: true, cancelable: true, view: w,
                    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
                    button: 0, pointerId: 1, pointerType: 'mouse'
                };
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
                    const Ctor = (t[0] === 'p' && w.PointerEvent) ? w.PointerEvent : w.MouseEvent;
                    try { el.dispatchEvent(new Ctor(t, o)); } catch (e) {}
                });
            }

            function finish(reason) {
                coursewareFlipping = false;
                coursewareFlipDone = true;
                console.log(`[助手 v2.1] 课件翻页完成（${reason}），共翻 ${flipped} 页。`);
                // 通知父帧(L2 目录帧)：该 PPT 已翻到末页，可放行逃逸推进到下一节
                try { window.parent.postMessage({ type: 'HW_COURSEWARE_DONE' }, '*'); } catch (e) {}
            }

            function step() {
                if (flipped >= MAX_PAGES || (Date.now() - startedAt) > MAX_TOTAL_MS) { finish('达到安全上限'); return; }

                const before = readPageNum();
                // 末页判据一：页码当前页>=总页
                if (before && before.total > 0 && before.cur >= before.total) { finish('页码触底'); return; }

                const next = findNextPageBtn();
                // 末页判据二：找不到翻页控件 或 翻页图标已禁用
                if (!next || next.atEnd) { finish('已无可点的下一页'); return; }

                realClick(next.el); // 完整指针事件序列翻页（裸 .click() 对 better-scroll 无效）
                flipped++;

                // 异步重渲染：延迟后校验页码是否前进，连续 3 次没动就判末页停手（防图标点不动时死循环）
                setTimeout(() => {
                    const after = readPageNum();
                    if (before && after && after.cur === before.cur) {
                        if (++stalls >= 3) { finish('页码连续未前进'); return; }
                    } else {
                        stalls = 0;
                    }
                    step();
                }, CONFIG.coursewarePageDelay); // 按配置间隔翻下一页，给平台记录每页浏览时长
            }

            // 首轮延迟一拍再开始，等 PPT 渲染完成
            setTimeout(step, CONFIG.coursewarePageDelay);
        }

        function formatTime(secs) {
            if (isNaN(secs) || secs === Infinity) return "00:00";
            const m = Math.floor(secs / 60).toString().padStart(2, '0');
            const s = Math.floor(secs % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        }
    }

    // 防挂机弹窗拦截清除
    setInterval(function handlePopups() {
        const CONFIRM_KEYWORDS = ['继续', '确定', '确认'];
        const matchConfirm = (btn) => {
            if (!btn.offsetParent) return false;
            const text = (btn.innerText || btn.textContent || '').replace(/\s+/g, '');
            return CONFIRM_KEYWORDS.some(kw => text.includes(kw));
        };

        // 第一层：常见弹窗容器选择器（Element UI / sxz 各类弹窗）
        const dialogButtons = document.querySelectorAll(
            '.el-dialog__wrapper button, .el-message-box__wrapper button, ' +
            '.dialog-footer button, button[class*="confirm" i], ' +
            '[class*="dialog" i] button, [class*="modal" i] button, ' +
            '[class*="popup" i] button, [class*="alert" i] button, ' +
            '[class*="msgbox" i] button, [class*="tip" i] button'
        );
        dialogButtons.forEach(btn => { if (matchConfirm(btn)) btn.click(); });

        // 第二层兜底：遮罩层存在时在全局搜索确认按钮，覆盖任意自定义弹窗类名
        const hasOverlay = document.querySelector(
            '[class*="overlay" i]:not([style*="display: none"]), ' +
            '[class*="backdrop" i]:not([style*="display: none"]), ' +
            '[class*="mask" i]:not([style*="display: none"])'
        );
        if (hasOverlay && hasOverlay.offsetParent) {
            Array.from(document.querySelectorAll('button')).forEach(btn => {
                if (matchConfirm(btn)) btn.click();
            });
        }
    }, 3000);

})();
