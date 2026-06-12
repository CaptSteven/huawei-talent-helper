// ==UserScript==
// @name         华为人才在线课程助手 (Huawei Talent Helper) - v1.0 
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  【非视频节点爆破】专治“本章课件”、“随堂测验”导致的无视频挂机卡死问题。引入前置拦截过滤与黑洞逃逸机制。
// @author       Antigravity
// @match        *://e.huawei.com/cn/talent/*
// @match        *://*.huawei.com/*
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/Jhaplin/huawei-talent-helper/main/src/huawei-talent-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Jhaplin/huawei-talent-helper/main/src/huawei-talent-helper.user.js
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

        function initGlobalPanel() {
            panelElement = document.createElement('div');
            panelElement.id = 'hw-global-panel';
            panelElement.style.cssText = `
                position: fixed; top: 120px; right: 40px; z-index: 2147483647; 
                width: 260px; background: #ffffff; border: 1px solid #dcdfe6; 
                border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.18);
                font-family: system-ui, sans-serif; font-size: 12px; color: #303133; 
                padding: 12px; box-sizing: border-box; user-select: none;
                transition: width 0.15s ease;
            `;

            panelElement.innerHTML = `
                <div id="hw-drag-head" style="font-weight: bold; color: #ee0000; border-bottom: 1px solid #ebeef5; margin-bottom: 8px; padding-bottom: 6px; cursor: move; display: flex; justify-content: space-between; align-items: center;">
                    <span id="hw-panel-title">🧭 华为助手 v1.0</span>
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
                </div>
                <div id="hw-panel-mini" style="display: none; text-align: center; font-weight: bold; padding: 4px 0; color: #67c23a;">
                    <span id="lbl-mini-status">▶️</span>
                </div>
            `;

            document.body.appendChild(panelElement);

            panelElement.querySelector('#chk-auto').addEventListener('change', (e) => { CONFIG.autoNext = e.target.checked; broadcastConfig(); });
            panelElement.querySelector('#num-speed').addEventListener('input', (e) => {
                let val = parseFloat(e.target.value);
                if (!isNaN(val)) { CONFIG.playbackSpeed = val; broadcastConfig(); }
            });

            panelElement.querySelector('#btn-fold').addEventListener('click', function() {
                const body = panelElement.querySelector('#hw-panel-body');
                const mini = panelElement.querySelector('#hw-panel-mini');
                isCollapsed = !isCollapsed;

                if (isCollapsed) {
                    body.style.display = 'none';
                    mini.style.display = 'block';
                    this.innerText = '[+]';
                    panelElement.style.width = '140px';
                    panelElement.querySelector('#hw-panel-title').innerText = '🧭 助手';
                } else {
                    body.style.display = 'block';
                    mini.style.display = 'none';
                    this.innerText = '[-]';
                    panelElement.style.width = '260px';
                    panelElement.querySelector('#hw-panel-title').innerText = '🧭 华为助手 v2.1';
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
                    video.play().catch(() => {});
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
                    if (isTargetBlack) {
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
