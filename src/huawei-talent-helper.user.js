// ==UserScript==
// @name         华为人才在线课程助手 (Huawei Talent Helper) - v1.3.4
// @namespace    http://tampermonkey.net/
// @version      1.3.4
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
        maxDelay: 4000
    };

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
            const applied = applyAiAnswers(questions, answer);
            if (applied > 0) {
                reportAiStatus(`已回填 ${applied} 道题的答案`, 'success');
                if (AI_CONFIG.autoSubmit) setTimeout(trySubmitAnswer, 1500);
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

    function applyAiAnswers(questions, modelAnswer) {
        let applied = 0;
        modelAnswer.answers.forEach(answer => {
            const question = questions.find(q => q.index === Number(answer.questionIndex));
            if (!question) return;
            const indexes = Array.isArray(answer.optionIndexes) ? answer.optionIndexes.map(Number) : [];
            // 过滤越界 / 非法索引，避免模型给出页面上根本不存在的选项号
            const validIndexes = indexes.filter(i => Number.isInteger(i) && i >= 0 && i < question.options.length);
            if (validIndexes.length === 0) {
                console.log(`[华为助手 AI] 第 ${question.index} 题：模型返回索引 ${JSON.stringify(indexes)} 超出 0~${question.options.length - 1}，跳过回填且不计入已答（避免空答被推进）`);
                return;
            }

            question.options.forEach((option, idx) => {
                const shouldSelect = validIndexes.includes(idx);
                const input = option.input;
                if (!input || input.disabled) return;

                if (question.type === 'multiple') {
                    if (input.checked !== shouldSelect) clickAnswerInput(input, option.clickTarget);
                } else if (shouldSelect && !input.checked) {
                    clickAnswerInput(input, option.clickTarget);
                }
            });

            // 关键修复：以「真实勾选状态」判定是否已作答，而不是「遍历过这道题」。
            // 旧逻辑无条件 applied++，当点击没生效（clickTarget 不对、控件被框架接管等）时，
            // 仍会触发自动提交把空白题翻过去 —— 这正是「没选答案就跳到下一题」的根因。
            const reallySelected = validIndexes.filter(i => question.options[i] && question.options[i].input && question.options[i].input.checked).length;
            if (reallySelected > 0) {
                applied++;
            } else {
                console.log(`[华为助手 AI] 第 ${question.index} 题：点选后没有任何选项处于选中态，判定回填失败，不推进（留待下一轮重试或人工处理）`);
            }
        });
        return applied;
    }

    function clickAnswerInput(input, clickTarget) {
        const label = input.id ? document.querySelector(`label[for="${cssEscape(input.id)}"]`) : input.closest('label');
        const target = clickTarget || label || input;
        target.click();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
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
        const btn = findQuizButtonByText(['下一节', '下一个', '下一章', '下一环节', '继续学习', '下一步', '继续']);
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
            await solveQuestionsWithAi('auto'); // 回填答案，开启自动提交时顺带推进到下一题
            return;
        }

        if (!AI_CONFIG.autoSubmit) return; // 仅回填、不导航

        const startBtn = findQuizStartButton();
        if (startBtn) {
            startBtn.click();
            reportAiStatus('已自动进入测验', 'info');
            return;
        }

        if (document.querySelector('.test-content')) {
            // 安全门：有活跃题目时「下一题/提交」点击后 4s 内禁止调用 finalizeQuiz，
            // 避免新题目 DOM 未渲染完成时 findQuizNextButton 误点下一题造成跳题。
            // 无活跃题目（答题卡阶段）跳过延迟，直接进入收尾。
            const hasActiveQuestion = !!document.querySelector('.test-content .option-list-item');
            if (hasActiveQuestion && Date.now() - lastTrySubmitTime < 4000) {
                reportAiStatus('等待题目加载...', 'info');
                return;
            }
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
            if (tryProceedToNextStage()) quizSubmittedAt = 0;
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

        let globalState = {
            title: "正在定位课程...",
            status: "等待同步...",
            progress: "00:00 / 00:00 (0%)",
            videoEnded: false
        };

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'HW_FRAME_REPORT') {
                const incoming = msg.data;
                let isAltered = false;

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

                if (globalState.videoEnded && CONFIG.autoNext && !jumpLock) {
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
                    <span id="hw-panel-title">华为助手 v1.3.4</span>
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
                    panelElement.querySelector('#hw-panel-title').innerText = '华为助手 v1.3.4';
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

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'HW_CONFIG_SYNC') {
                CONFIG.autoNext = msg.data.autoNext;
                CONFIG.playbackSpeed = msg.data.playbackSpeed;
            }

            if (msg.type === 'HW_COMMAND_JUMP') {
                doJumpV21();
            }
        });

        setInterval(function pureIframeScanner() {
            const video = document.querySelector('video');
            const activeNode = document.querySelector('[class*="current" i] .text, [class*="active" i] .text, .is-current .text, .is-active .text, .is-current, .is-active');

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
                    if (isTargetBlack && !shouldHoldForQuiz()) {
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
                const hitBlacklist = BLACKLIST_KEYWORDS.some(kw => rowText.includes(kw));
                if (hitBlacklist) {
                    console.log(`[助手 v2.1] 发现非视频盲区 [${rowText.split('\n')[0]}]，已自动执行跃迁避让。`);
                    targetIndex++;
                    continue;
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

        function formatTime(secs) {
            if (isNaN(secs) || secs === Infinity) return "00:00";
            const m = Math.floor(secs / 60).toString().padStart(2, '0');
            const s = Math.floor(secs % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        }
    }

    // 防挂机弹窗拦截清除
    setInterval(function handlePopups() {
        const dialogButtons = document.querySelectorAll('.el-dialog__wrapper button, .el-message-box__wrapper button, .dialog-footer button, button[class*="confirm" i]');
        dialogButtons.forEach(btn => {
            const text = btn.innerText || btn.textContent;
            if (text.includes('继续') || text.includes('确定') || text.includes('确认')) btn.click();
        });
    }, 3000);

})();
