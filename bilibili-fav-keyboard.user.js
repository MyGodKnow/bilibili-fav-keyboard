// ==UserScript==
// @name         B站收藏夹键盘操作
// @namespace    https://github.com/MyGodKnow/bilibili-fav-keyboard
// @version      1.0.0
// @description  按 E 呼出收藏弹窗后，用 ↑/↓ 选择收藏夹、空格 加入/移除、回车 保存
// @author       MyGodKnow
// @homepageURL  https://github.com/MyGodKnow/bilibili-fav-keyboard
// @supportURL   https://github.com/MyGodKnow/bilibili-fav-keyboard/issues
// @downloadURL  https://raw.githubusercontent.com/MyGodKnow/bilibili-fav-keyboard/main/bilibili-fav-keyboard.user.js
// @updateURL    https://raw.githubusercontent.com/MyGodKnow/bilibili-fav-keyboard/main/bilibili-fav-keyboard.user.js
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/cheese/play/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ============================== 配置 ============================== */

    // 详细日志（默认关）。识别失败时控制台一定会有诊断输出，不受这里影响
    const DEBUG = false;

    // 精确选择器：B 站改版后如果诊断日志里给出了新的 class，加到最前面即可
    const DIALOG_SELECTORS = [
        '.collection-m-box',
        '.bili-fav-dialog',
        '.fav-dialog',
        '.collect-dialog'
    ];
    const ITEM_SELECTORS = [
        '.collection-m-item',
        '[class*="fav-item"]',
        '[class*="collect-item"]',
        '[class*="folder-item"]'
    ];
    const CHECK_SELECTOR = 'input[type="checkbox"], [role="checkbox"], [class*="checkbox"], [class*="check-box"]';

    const CONFIRM_TEXTS = ['确定', '确认', '保存'];
    const CREATE_ROW_RE = /新建|创建|添加收藏夹|管理收藏夹/;

    /* ============================== 状态 ============================== */

    let dialog = null;
    let items = [];
    let cursor = 0;
    let highlighted = null;
    let liveTimer = 0;
    let hintEl = null;
    let hintTimer = 0;
    let suppressUntil = 0;  // 刚保存/关闭后的静默期，期间不再自动接管，避免残留弹窗吞掉方向键
    let snapTimer = 0;      // 滚动期间临时关掉下划线过渡
    let scan = null;        // 一次"按 E 之后的探测"
    let lastOpenCheck = 0;  // 弹窗存在性检查的节流时间戳

    const log = (...a) => DEBUG && console.log('[收藏夹键盘]', ...a);

    /* ============================ 基础工具 ============================ */

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        // 连同祖先一起判断：弹窗关闭后常常只改 opacity/visibility，DOM 并没有移除，
        // 这样残留的隐藏弹窗就会在下次按方向键时被当成"开着"，把方向键吞掉。
        if (el.checkVisibility) {
            return el.checkVisibility({
                opacityProperty: true, visibilityProperty: true,
                checkOpacity: true, checkVisibilityCSS: true // 兼容旧参数名
            });
        }
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    }

    function isTypingTarget(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName.toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
    }

    function textOf(el) {
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 找到"包含某段文字"的文本节点所在的元素（比遍历元素 + textContent 快得多）
    function elementWithText(str) {
        if (!document.body) return null;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
            if (n.nodeValue && n.nodeValue.indexOf(str) !== -1) {
                const el = n.parentElement;
                if (el && isVisible(el)) return el;
            }
        }
        return null;
    }

    /* ======================= 弹窗 / 列表行的识别 ======================= */

    // 核心启发式：在一个节点里找"一列高度接近的兄弟行"，这就是收藏夹列表
    function findUniformList(root) {
        let best = null;
        const nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
        for (const el of nodes) {
            if (el.children.length < 2) continue;
            const kids = Array.prototype.filter.call(el.children, isVisible);
            if (kids.length < 2) continue;
            const hs = kids.map((k) => k.getBoundingClientRect().height);
            if (hs.some((h) => h < 20 || h > 130)) continue;
            const w0 = kids[0].getBoundingClientRect().width;
            if (w0 < 80) continue;
            const avg = hs.reduce((a, b) => a + b, 0) / hs.length;
            const dev = Math.max.apply(null, hs.map((h) => Math.abs(h - avg)));
            const score = kids.length - dev / 8; // 行数多、高度齐 → 得分高
            if (!best || score > best.score) best = { rows: kids, score: score };
        }
        return best;
    }

    // 在已知弹窗根节点里取行：精确选择器 → 均匀行 → 复选框反推
    function collectItems(root) {
        for (const sel of ITEM_SELECTORS) {
            const list = Array.prototype.filter.call(root.querySelectorAll(sel), isVisible);
            if (list.length) return filterRows(list);
        }
        const uniform = findUniformList(root);
        if (uniform && uniform.rows.length) return filterRows(uniform.rows);

        const set = new Set();
        Array.prototype.forEach.call(root.querySelectorAll(CHECK_SELECTOR), (c) => {
            if (!isVisible(c)) return;
            let cur = c;
            while (cur && cur !== root) {
                const r = cur.getBoundingClientRect();
                if (r.height >= 24 && r.width >= 80 && textOf(cur).length <= 80) { set.add(cur); break; }
                cur = cur.parentElement;
            }
        });
        return filterRows(Array.from(set));
    }

    // 有的版本里"行"其实是包着多个满宽行的外层节点，这时要拆开
    function expandRow(row) {
        const pr = row.getBoundingClientRect();
        const kids = Array.prototype.filter.call(row.children, (k) => {
            if (!isVisible(k)) return false;
            const r = k.getBoundingClientRect();
            return r.height >= 20 && r.height <= 130 && r.width >= pr.width * 0.85;
        });
        if (kids.length >= 2) {
            const sum = kids.reduce((a, k) => a + k.getBoundingClientRect().height, 0);
            if (sum <= pr.height * 1.25) return kids;
        }
        return [row];
    }

    // 只有一层、且几乎同尺寸的子节点时，往下钻到真正的行
    function refineRow(row) {
        let cur = row;
        for (let i = 0; i < 3; i++) {
            const kids = Array.prototype.filter.call(cur.children, isVisible);
            if (kids.length !== 1) break;
            const pr = cur.getBoundingClientRect();
            const kr = kids[0].getBoundingClientRect();
            if (kr.height >= pr.height * 0.8 && kr.width >= pr.width * 0.85) cur = kids[0];
            else break;
        }
        return cur;
    }

    function normalizeRows(rows) {
        const out = [];
        const seen = new Set();
        rows.forEach((r) => {
            expandRow(r).forEach((x) => {
                const row = refineRow(x);
                if (row && !seen.has(row)) { seen.add(row); out.push(row); }
            });
        });
        return out;
    }

    function filterRows(rows) {
        return normalizeRows(rows).filter((r) => isVisible(r) && !CREATE_ROW_RE.test(textOf(r)));
    }

    function findDialog() {
        for (const sel of DIALOG_SELECTORS) {
            const el = Array.prototype.find.call(document.querySelectorAll(sel), isVisible);
            if (el) return el;
        }
        return null;
    }

    /* ========================= 按 E 之后的探测 ========================= */

    function beginScan() {
        if (scan) return;
        const target = document.body || document.documentElement;
        if (!target) return;

        const added = new Set();
        const changed = new Set();
        const cap = 400;

        const obs = new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type === 'childList') {
                    Array.prototype.forEach.call(m.addedNodes, (n) => {
                        if (n.nodeType === 1 && added.size < cap) added.add(n);
                    });
                } else if (m.target && m.target.nodeType === 1 && changed.size < cap) {
                    changed.add(m.target);
                }
            }
        });
        obs.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });

        const started = Date.now();
        const timer = setInterval(() => {
            const hit = detectFromScan(added, changed);
            if (hit) { endScan(); attach(hit.root, hit.rows); return; }
            if (Date.now() - started > 2500) { endScan(); dumpDiagnostics(added, changed); }
        }, 100);

        scan = { obs: obs, timer: timer, added: added, changed: changed };
    }

    function endScan() {
        if (!scan) return;
        scan.obs.disconnect();
        clearInterval(scan.timer);
        scan = null;
    }

    function detectFromScan(added, changed) {
        // 1) 已知选择器
        const known = findDialog();
        if (known) {
            const rows = collectItems(known);
            if (rows.length) { log('命中已知选择器'); return { root: known, rows: rows }; }
        }

        // 2) 新增 / 变化的节点里找"高度一致的列表"，且该区域必须带"收藏"字样
        const cands = [];
        added.forEach((n) => { if (isVisible(n)) cands.push(n); });
        changed.forEach((n) => { if (isVisible(n)) cands.push(n); });
        cands.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
        });

        let best = null;
        for (const c of cands.slice(0, 30)) {
            if (!/收藏/.test(textOf(c))) continue;
            const u = findUniformList(c);
            if (!u) continue;
            const rows = filterRows(u.rows);
            if (!rows.length) continue;
            const score = rows.length;
            if (!best || score > best.score) best = { root: c, rows: rows, score: score };
        }
        if (best) { log('命中新增节点探测', best.rows.length, '行'); return best; }

        // 3) 以"新建收藏夹"文字为锚点反推列表
        const anchor = elementWithText('新建收藏夹');
        if (anchor && anchor.parentElement) {
            const list = anchor.parentElement;
            if (list.children.length >= 2) {
                const u = findUniformList(list);
                if (u) {
                    const rows = filterRows(u.rows);
                    if (rows.length) { log('命中"新建收藏夹"锚点'); return { root: list, rows: rows }; }
                }
            }
        }
        return null;
    }

    /* ============================ 提示与高亮 ============================ */

    function injectStyle() {
        if (document.getElementById('bili-fav-kbd-style')) return;
        const style = document.createElement('style');
        style.id = 'bili-fav-kbd-style';
        style.textContent = [
            /* 选中行下方的蓝色下划线：脚本自己绘制，所以永远和内容对齐 */
            '#bili-fav-kbd-bar{position:fixed;left:0;top:0;width:0;height:3px;border-radius:2px;',
            'pointer-events:none;z-index:2147483647;opacity:0;',
            'background:linear-gradient(90deg,#00aeec 0%,#3ad6ff 60%,#8feaff 100%);',
            'box-shadow:0 0 8px rgba(0,174,236,.5);',
            'transition:opacity .16s ease,left .2s cubic-bezier(.22,.9,.25,1),',
            'top .15s cubic-bezier(.22,.9,.25,1),width .2s cubic-bezier(.22,.9,.25,1);}',
            '#bili-fav-kbd-bar.on{opacity:1;}',
            /* 滚动时不做过渡，否则下划线会"追不上"列表而飘到卡片外面 */
            '#bili-fav-kbd-bar.snap{transition:none;}',
            /* 加入：脉冲放大并亮一下；移除：变灰 */
            '@keyframes biliFavOn{0%{transform:scaleY(1);box-shadow:0 0 8px rgba(0,174,236,.5);}',
            '45%{transform:scaleY(2.2);box-shadow:0 0 16px rgba(58,214,255,.9);}',
            '100%{transform:scaleY(1);box-shadow:0 0 8px rgba(0,174,236,.5);}}',
            '#bili-fav-kbd-bar.hit-on{animation:biliFavOn .4s ease-out;}',
            '@keyframes biliFavOff{0%{filter:none;opacity:1;}55%{filter:grayscale(1);opacity:.5;}',
            '100%{filter:grayscale(1);opacity:1;}}',
            '#bili-fav-kbd-bar.hit-off{animation:biliFavOff .4s ease-out;}',

            /* 底部操作提示：毛玻璃胶囊 + 序号 + 收藏夹名字 + 键帽 */
            '.bili-fav-kbd-tip{position:fixed;left:50%;bottom:30px;z-index:2147483647;',
            'display:flex;align-items:center;gap:12px;max-width:78vw;padding:8px 16px;border-radius:999px;',
            'background:rgba(22,24,29,.82);border:1px solid rgba(255,255,255,.1);',
            'box-shadow:0 10px 30px rgba(0,0,0,.38);backdrop-filter:blur(14px) saturate(1.4);',
            'color:#eaf3f8;font:500 12px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
            'pointer-events:none;white-space:nowrap;opacity:0;transform:translateX(-50%) translateY(8px);',
            'transition:opacity .22s ease,transform .3s cubic-bezier(.22,.9,.25,1);}',
            '.bili-fav-kbd-tip.on{opacity:1;transform:translateX(-50%) translateY(0);}',
            '.bili-fav-kbd-tip.plain{gap:0;background:rgba(60,20,24,.88);',
            'border-color:rgba(255,120,120,.32);color:#ffd9d9;}',
            '.bili-fav-kbd-tip .no{font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;color:#8feaff;',
            'background:rgba(0,174,236,.16);border:1px solid rgba(0,174,236,.35);padding:4px 8px;',
            'border-radius:999px;letter-spacing:.5px;}',
            '.bili-fav-kbd-tip .nm{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
            'color:#fff;font-weight:600;font-size:13px;}',
            '.bili-fav-kbd-tip .nm.swap{animation:biliFavSwap .26s ease-out;}',
            '@keyframes biliFavSwap{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}',
            '.bili-fav-kbd-tip .sep{width:1px;height:16px;background:rgba(255,255,255,.14);}',
            '.bili-fav-kbd-tip .hk{display:flex;align-items:center;gap:5px;color:#9fb0bb;font-size:11px;}',
            '.bili-fav-kbd-tip kbd{display:inline-block;min-width:14px;text-align:center;padding:2px 5px 3px;',
            'border-radius:5px;font:600 11px/1 -apple-system,"Microsoft YaHei",sans-serif;color:#e8f7ff;',
            'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);',
            'border-bottom-width:2px;}'
        ].join('');
        (document.head || document.documentElement).appendChild(style);
    }

    // 接管成功时的操作提示：序号 + 当前收藏夹名 + 键帽
    function showKeyHint() {
        setHint(
            '<b class="no">1/1</b><span class="nm"></span><span class="sep"></span>' +
            '<span class="hk"><kbd>↑</kbd><kbd>↓</kbd>选择　<kbd>空格</kbd>加入/移除　' +
            '<kbd>回车</kbd>保存　<kbd>Esc</kbd>关闭</span>',
            0, false
        );
        updateHint();
    }

    // 纯文本提示（识别失败时用）
    function showHint(text, ms) {
        setHint(text, ms, true);
    }

    function setHint(content, ms, plain) {
        injectStyle();
        clearTimeout(hintTimer);
        if (!hintEl) {
            hintEl = document.createElement('div');
            hintEl.className = 'bili-fav-kbd-tip';
        }
        hintEl.classList.toggle('plain', !!plain);
        if (plain) hintEl.textContent = content;
        else hintEl.innerHTML = content; // 内容是自己写死的固定文案
        if (!hintEl.isConnected && document.body) document.body.appendChild(hintEl);
        requestAnimationFrame(() => { if (hintEl) hintEl.classList.add('on'); });
        hintTimer = ms ? setTimeout(() => { if (hintEl) hintEl.remove(); }, ms) : 0;
    }

    // 行的文字里去掉 [私密] 和结尾的数量，剩下的就是收藏夹名
    function rowName(row) {
        if (!row) return '';
        return textOf(row)
            .replace(/[\[【（(]?\s*(私密|公开)\s*[\]】）)]?/g, '')
            .replace(/(\d+\s*\/\s*\d+|\d+)\s*$/, '')
            .trim();
    }

    function updateHint() {
        if (!hintEl || hintEl.classList.contains('plain')) return;
        const no = hintEl.querySelector('.no');
        const nm = hintEl.querySelector('.nm');
        if (no) no.textContent = items.length ? (cursor + 1) + '/' + items.length : '0/0';
        if (nm) {
            const name = rowName(items[cursor]);
            if (nm.textContent !== name) {
                nm.textContent = name;
                nm.classList.remove('swap');
                void nm.offsetWidth; // 重启动画
                nm.classList.add('swap');
            }
        }
    }

    function hideHint() {
        if (hintEl) {
            hintEl.classList.remove('on');
            if (hintEl.isConnected) hintEl.remove();
        }
    }

    /* ---------------------------- 蓝色下划线 ---------------------------- */

    let barEl = null;

    function ensureBar() {
        injectStyle();
        if (!barEl) {
            barEl = document.createElement('div');
            barEl.id = 'bili-fav-kbd-bar';
        }
        if (!barEl.isConnected && document.body) document.body.appendChild(barEl);
        return barEl;
    }

    // 行的"可视内容"范围（勾选框 + 文字），比行元素本身更可靠
    function contentRect(row) {
        const parts = [];
        const box = row.querySelector(CHECK_SELECTOR);
        if (box && isVisible(box)) parts.push(box.getBoundingClientRect());
        Array.prototype.forEach.call(row.querySelectorAll('*'), (el) => {
            if (el.children.length || !isVisible(el) || !textOf(el)) return;
            parts.push(el.getBoundingClientRect());
        });
        if (!parts.length) return row.getBoundingClientRect();
        let left = Infinity, right = -Infinity, bottom = -Infinity;
        parts.forEach((p) => {
            if (p.left < left) left = p.left;
            if (p.right > right) right = p.right;
            if (p.bottom > bottom) bottom = p.bottom;
        });
        return { left: left, right: right, bottom: bottom, width: right - left };
    }

    function placeBar(row) {
        const bar = ensureBar();
        if (!row || !row.isConnected || !isVisible(row)) { bar.classList.remove('on'); return; }
        const r = contentRect(row);
        if (!r || r.width < 4) { bar.classList.remove('on'); return; }
        const top = r.bottom + 4;
        // 下划线是 fixed 定位，不会被弹窗的 overflow 裁掉；
        // 行滚出可视区域时它会画到卡片外面，所以这里自己判断一次并收起。
        const clip = visibleClip(row);
        if (clip && (top + 3 > clip.bottom - 2 || r.bottom < clip.top + 2)) {
            bar.classList.remove('on');
            return;
        }
        bar.style.top = top + 'px';
        bar.style.left = r.left + 'px';
        bar.style.width = r.width + 'px';
        bar.classList.add('on');
    }

    // 行的可视裁剪范围 = 弹窗卡片 ∩ 列表滚动容器
    function visibleClip(row) {
        const parts = [];
        if (dialog && dialog.isConnected) parts.push(dialog.getBoundingClientRect());
        const rowH = row.getBoundingClientRect().height;
        let el = row.parentElement;
        while (el && el !== document.body && el !== document.documentElement) {
            const s = getComputedStyle(el);
            if (/(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflowX)) {
                const r = el.getBoundingClientRect();
                if (r.height >= rowH * 1.2) parts.push(r);
                break;
            }
            el = el.parentElement;
        }
        if (!parts.length) return null;
        let top = -Infinity;
        let bottom = Infinity;
        parts.forEach((p) => {
            if (p.top > top) top = p.top;
            if (p.bottom < bottom) bottom = p.bottom;
        });
        return { top: top, bottom: bottom };
    }

    function flashBar(on) {
        const bar = ensureBar();
        bar.classList.remove('hit-on', 'hit-off');
        void bar.offsetWidth; // 重启动画
        bar.classList.add(on ? 'hit-on' : 'hit-off');
    }

    // 由滚动 / 窗口变化触发时会传入事件对象 → 关掉过渡，直接跟位；
    // 由 400ms 兜底轮询调用时不传参 → 保留平滑过渡
    function onViewportChange(evt) {
        if (!dialog || !items[cursor]) return;
        if (evt) {
            const bar = ensureBar();
            clearTimeout(snapTimer);
            bar.classList.add('snap');
            snapTimer = setTimeout(() => bar.classList.remove('snap'), 140);
        }
        placeBar(items[cursor]);
    }

    function paint() {
        highlighted = items[cursor] || null;
        updateHint();
        if (!highlighted) { placeBar(null); return; }
        highlighted.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        placeBar(highlighted);
    }

    /* ========================= 接管 / 释放弹窗 ========================= */

    function describe(el) {
        if (!el) return '无';
        const r = el.getBoundingClientRect();
        return el.tagName + '.' + el.className + ' h=' + Math.round(r.height) +
            ' | ' + el.outerHTML.slice(0, 220).replace(/\s+/g, ' ');
    }

    // 自检：某行明显比其它行高 → 下划线会画偏，自动把罪魁祸首打到控制台
    function checkAlignment(rows) {
        if (rows.length < 2) return;
        const hs = rows.map((r) => r.getBoundingClientRect().height);
        const med = hs.slice().sort((a, b) => a - b)[Math.floor(hs.length / 2)];
        const odd = rows.filter((r) => r.getBoundingClientRect().height > med * 1.6);
        if (!odd.length) return;
        console.log('[收藏夹键盘] 有一行的高度明显大于其它行（中位数 ' + Math.round(med) + 'px），下划线可能画偏。异常行：');
        odd.slice(0, 3).forEach((r) => console.log(describe(r)));
    }

    function attach(root, rows) {
        detach(true);
        dialog = root;
        items = rows;
        cursor = 0;
        liveTimer = setInterval(() => {
            // 唯一的退出条件：检测到收藏框已经关掉
            if (!dialog || !dialog.isConnected || !isVisible(dialog)) { onDialogClosed(); return; }
            // 列表被重绘（勾选/取消勾选后 B 站常整列换新节点）→ 按原下标重新取行
            if (items.some((el) => !el.isConnected)) { refresh(); return; }
            onViewportChange(); // 列表被滚动（含虚拟滚动）时，让下划线跟上
        }, 400);
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);
        // 鼠标点选收藏夹时，让下划线和提示条也跟过去
        document.addEventListener('click', onRowClick, true);
        showKeyHint();
        paint();
        log('已接管，行数 =', rows.length, '根节点 =', String(root.className));
        checkAlignment(rows);
    }

    function detach(silent) {
        clearInterval(liveTimer);
        liveTimer = 0;
        window.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
        document.removeEventListener('click', onRowClick, true);
        clearTimeout(snapTimer);
        snapTimer = 0;
        if (barEl) barEl.classList.remove('on', 'hit-on', 'hit-off', 'snap');
        highlighted = null;
        dialog = null;
        items = [];
        cursor = 0;
        if (!silent) hideHint();
    }

    function refresh() {
        if (!dialog || !dialog.isConnected || !isVisible(dialog)) { onDialogClosed(); return false; }
        const next = collectItems(dialog);
        if (next.length) items = next;
        if (!items.length) { detach(); return false; }
        if (cursor > items.length - 1) cursor = items.length - 1;
        paint();
        return true;
    }

    // 已经开着弹窗（比如用鼠标点的收藏按钮）时，也能立刻接管
    function ensureDialog() {
        if (Date.now() < suppressUntil) return false; // 刚关闭，别再接管残留在 DOM 里的弹窗
        if (dialog) {
            if (dialog.isConnected && isVisible(dialog)) {
                if (!items.length || items.some((el) => !el.isConnected)) refresh();
                return !!items.length;
            }
            // 之前接管的收藏框已经关掉了 → 在这里立刻收尾（不等 400ms 轮询）
            onDialogClosed();
            return false;
        }
        const now = Date.now();
        if (now - lastOpenCheck > 500) {
            lastOpenCheck = now;
            const anchor = elementWithText('新建收藏夹');
            if (anchor) {
                const hit = detectFromScan(new Set(), new Set());
                if (hit) { attach(hit.root, hit.rows); return true; }
            }
        }
        return false;
    }

    // 鼠标点在某一行的任意位置（含勾选框）→ 把光标挪到那一行，下划线和提示条跟着走
    function onRowClick(e) {
        if (!dialog || !dialog.isConnected || !isVisible(dialog)) return;
        const t = e.target;
        if (!t || !dialog.contains(t)) return;

        let idx = -1;
        for (let i = 0; i < items.length; i++) {
            if (items[i] === t || items[i].contains(t)) { idx = i; break; }
        }
        if (idx < 0) return; // 点的是"新建收藏夹"、确定之类的按钮，不动下划线

        cursor = idx;
        paint(); // 先按点中的那一行把下划线画过去
        // 勾选/取消勾选后 B 站常常重绘整列，行元素会换新节点；
        // 等这次点击处理完再按相同下标取一遍，下划线就还落在同一个收藏夹上
        setTimeout(() => { if (dialog) refresh(); }, 0);
    }

    /* ============================ 具体动作 ============================ */

    function move(step) {
        if (!items.length) return;
        cursor = (cursor + step + items.length) % items.length;
        paint();
    }

    // true/false；无法判断时返回 null
    function checkState(row) {
        const input = row.querySelector('input[type="checkbox"]');
        if (input) return !!input.checked;
        const nodes = [row].concat(Array.prototype.slice.call(row.querySelectorAll('*')));
        let sawHint = false;
        for (const n of nodes) {
            const cls = typeof n.className === 'string' ? n.className : '';
            const aria = n.getAttribute && n.getAttribute('aria-checked');
            if (aria !== null && aria !== undefined) { sawHint = true; if (aria === 'true') return true; }
            if (/check|select|active/i.test(cls)) {
                sawHint = true;
                if (/checked|selected|active/i.test(cls)) return true;
            }
        }
        return sawHint ? false : null;
    }

    function toggleCurrent() {
        const row = items[cursor];
        if (!row) return;
        const before = checkState(row);
        row.click();

        // 有的版本整行不响应点击，这时再点一下勾选框
        setTimeout(() => {
            if (!dialog || !row.isConnected) { refresh(); return; }
            if (before !== null && checkState(row) === before) {
                const box = row.querySelector(CHECK_SELECTOR);
                if (box && box !== row) { log('整行点击无效，改点勾选框'); box.click(); }
            }
            // 下划线反馈：蓝色脉冲 = 已加入，变灰 = 已移除
            const now = checkState(row);
            if (now === true) flashBar(true);
            else if (now === false) flashBar(false);
            refresh();
        }, 60);
    }

    function findConfirmButton() {
        // 从高亮行所属的列表往外扩散找"确定"，最多往上找 4 层
        let scope = dialog;
        for (let i = 0; i < 4 && scope; i++) {
            const cands = Array.prototype.filter.call(
                scope.querySelectorAll('button, [class*="btn"], [role="button"]'),
                isVisible
            );
            const hit = cands.find((b) => CONFIRM_TEXTS.indexOf(textOf(b)) !== -1);
            if (hit) return hit;
            scope = scope.parentElement;
        }
        return null;
    }

    function save() {
        const btn = findConfirmButton();
        if (btn) {
            log('点击保存：', textOf(btn));
            btn.click();
            finishClose();
            return;
        }
        const close = Array.prototype.find.call(
            document.querySelectorAll('[class*="close"], [aria-label*="关闭"]'),
            isVisible
        );
        if (close) { log('没有确定按钮，点关闭'); close.click(); finishClose(); return; }
        log('没有确定按钮，发 Esc');
        (document.activeElement || document.body).dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })
        );
        finishClose();
    }

    // 保存/关闭后的收尾：进入静默期 + 把焦点从弹窗里放掉
    // 不再主动去关弹窗，而是等检测到收藏框确实关掉（B 站自己关）才 detach
    function finishClose() {
        suppressUntil = Date.now() + 900;
        releasePopupFocus();
        setTimeout(releasePopupFocus, 150); // 有的弹窗关闭时会把焦点收回去，再放掉一次
    }

    // 检测到收藏框已经关掉：真正退出接管（清理定时器、下划线、提示条，把控制权交还页面）
    function onDialogClosed() {
        if (!dialog) return;
        log('检测到收藏框关闭，退出接管');
        suppressUntil = Date.now() + 400; // 弹窗有时只是被隐藏、仍挂在 DOM 里，短暂静默避免又接管回去
        detach();
        releasePopupFocus();
        setTimeout(releasePopupFocus, 150); // 关闭瞬间焦点可能被弹窗收回，再放一次
    }

    // 只 blur 回 body，不主动去 focus 播放器：
    // 焦点留在弹窗里会让左右键（快进）失效，而把焦点塞进播放器又会让上下键（音量）失效，
    // 回到 body 才是和刚进页面一样的状态，两套快捷键都正常。
    function releasePopupFocus() {
        const ae = document.activeElement;
        if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
    }

    /* ============================ 诊断输出 ============================ */

    function dumpDiagnostics(added, changed) {
        const rows = [];
        const push = (el, kind) => {
            const r = el.getBoundingClientRect();
            if (r.height < 30) return;
            rows.push({
                kind: kind,
                tag: el.tagName,
                cls: String(el.className).slice(0, 70),
                w: Math.round(r.width),
                h: Math.round(r.height),
                text: textOf(el).slice(0, 36)
            });
        };
        added.forEach((n) => push(n, 'added'));
        changed.forEach((n) => push(n, 'changed'));

        console.log('[收藏夹键盘] 没识别到收藏弹窗，所以 ↑↓ 落到播放器上变成了调音量。');
        console.log('[收藏夹键盘] 按 E 之后新增/变化的可见节点（前 25 个）：');
        console.table(rows.slice(0, 25));

        const anchor = elementWithText('新建收藏夹');
        console.log('[收藏夹键盘] 页面上的"新建收藏夹"节点 =', anchor ? anchor.outerHTML.slice(0, 400) : '没有找到');
        console.log('[收藏夹键盘] input[type=checkbox] 数量 =', document.querySelectorAll('input[type=checkbox]').length);
        console.log('[收藏夹键盘] 把上面的信息发给脚本作者，或在 DIALOG_SELECTORS 最前面补上真实 class。');

        showHint('未能识别收藏弹窗，请按 F12 查看 [收藏夹键盘] 日志', 6000);
    }

    /* ============================ 键盘主逻辑 ============================ */

    function handleKey(e) {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (isTypingTarget(e.target)) return;

        const key = e.key;
        const isSpace = key === ' ' || key === 'Spacebar' || e.code === 'Space';

        if (key === 'e' || key === 'E') {
            if (!dialog) beginScan(); // 弹窗交给 B 站自己打开，我们只负责等它出现
            return;
        }

        if (!ensureDialog()) return;

        let handled = true;
        switch (key) {
            case 'ArrowDown': move(1); break;
            case 'ArrowUp': move(-1); break;
            case 'Enter': save(); return;
            // Esc 不做处理：放行给 B 站去关收藏框，
            // 脚本退出只由"检测到收藏框关闭"触发（见 onDialogClosed）
            default:
                if (isSpace) toggleCurrent();
                else handled = false;
        }
        if (!handled) return;

        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    window.addEventListener('keydown', handleKey, true);
})();