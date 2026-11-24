import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');

test('buildInjectExpression and REMOVE_EXPRESSION compile cleanly as valid JS', () => {
  const injectExpr = cdp.buildInjectExpression();
  const removeExpr = cdp.REMOVE_EXPRESSION;
  assert.doesNotThrow(() => new vm.Script(injectExpr));
  assert.doesNotThrow(() => new vm.Script(removeExpr));
  assert.ok(injectExpr.includes('ag-claude-style-css'));
  assert.ok(injectExpr.includes('ag-cs-home-panel'));
  assert.ok(removeExpr.includes('window.__agClaudeStyle.destroy'));
});

test('inject expression mounts and REMOVE_EXPRESSION cleanly tears down on simulated Antigravity DOM', async () => {
  function makeNode(tag, opts = {}) {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const node = {
      tagName: tag.toUpperCase(),
      id: opts.id || '',
      style: {
        _props: {},
        setProperty(k, v) { this._props[k] = String(v); },
        getPropertyValue(k) { return this._props[k] || ''; },
        removeProperty(k) { delete this._props[k]; },
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      get textContent() {
        return children.length ? children.map((c) => c.textContent).join('') : this._text;
      },
      set textContent(v) {
        children.length = 0;
        this._text = String(v);
      },
      set innerHTML(html) {
        children.length = 0;
        this._html = html;
      },
      get innerHTML() { return this._html || ''; },
      get childElementCount() { return children.length; },
      get firstChild() { return children[0] || null; },
      get nextSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
      },
      get lastElementChild() { return children[children.length - 1] || null; },
      clientWidth: opts.clientWidth ?? 900,
      clientHeight: opts.clientHeight ?? 700,
      width: 0,
      height: 0,
      appendChild(ch) {
        ch.parentElement = this;
        ch.parentNode = this;
        children.push(ch);
        return ch;
      },
      insertBefore(ch, ref) {
        ch.parentElement = this;
        ch.parentNode = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, ch);
        else children.push(ch);
        return ch;
      },
      removeChild(ch) {
        const idx = children.indexOf(ch);
        if (idx >= 0) children.splice(idx, 1);
        ch.parentElement = null;
        ch.parentNode = null;
        return ch;
      },
      remove() {
        if (this.parentElement) this.parentElement.removeChild(this);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, force) {
        const on = force === undefined ? !attrs.has(k) : Boolean(force);
        if (on) attrs.set(k, ''); else attrs.delete(k);
        return on;
      },
      addEventListener(ev, cb) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(cb);
      },
      removeEventListener(ev, cb) {
        const arr = listeners.get(ev);
        if (!arr) return;
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      },
      dispatch(ev, payload = {}) {
        const list = listeners.get(ev) || [];
        for (const fn of [...list]) fn({ type: ev, stopPropagation() {}, preventDefault() {}, ...payload });
      },
      getContext() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 480, bottom: 300, width: 480, height: 300 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matches(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matches(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  }

  function matchesSimple(node, simple) {
    let rest = simple.trim();
    if (!rest) return false;
    const tagMatch = /^[a-zA-Z0-9_-]+/.exec(rest);
    if (tagMatch) {
      if (node.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      if (rest[0] === '#') {
        const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || node.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '.') {
        const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || !node.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '[') {
        const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
        if (!m) return false;
        const ok = m[2] === undefined ? node.hasAttribute(m[1]) : node.getAttribute(m[1]) === m[2];
        if (!ok) return false;
        rest = rest.slice(m[0].length);
      } else {
        return false;
      }
    }
    return true;
  }

  function matches(node, selector) {
    return selector.split(',').some((part) => {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return false;
      if (!matchesSimple(node, tokens[tokens.length - 1])) return false;
      let cur = node.parentElement;
      let idx = tokens.length - 2;
      while (cur && idx >= 0) {
        if (matchesSimple(cur, tokens[idx])) idx--;
        cur = cur.parentElement;
      }
      return idx < 0;
    });
  }

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  // Build simulated Antigravity Home DOM
  const home = makeNode('div', { className: 'agy-home' });
  const scrollWrap = makeNode('div');
  const scrollCol = makeNode('div');
  const greeting = makeNode('div', { attrs: { 'data-testid': 'home-greeting' } });
  const h1 = makeNode('h1', { className: 'home-greeting-title', text: 'Welcome back, girl. Where should we pick up?' });
  greeting.appendChild(h1);
  scrollCol.appendChild(greeting);
  scrollWrap.appendChild(scrollCol);
  home.appendChild(scrollWrap);

  const inputBox = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const queuedWrap = makeNode('div', { className: 'relative z-[1] flex flex-col gap-2 w-full hidden-if-empty mb-2' });
  const queuedCard = makeNode('div', { text: '排队中的消息 1 · 智能体完成后发送' });
  queuedWrap.appendChild(queuedCard);
  inputBox.appendChild(queuedWrap);
  const composerShell = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', className: 'surface-composer' });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const editorWrap = makeNode('div', { className: 'relative w-full' });
  const placeholder = makeNode('p', { className: 'pointer-events-none', text: '有问题尽管问' });
  const editorEl = makeNode('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  editorWrap.appendChild(placeholder);
  editorWrap.appendChild(editorEl);
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  const modelBtn = makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  const modelSpan = makeNode('span', { text: 'Gemini 4 Argon' });
  const effortSpan = makeNode('span', { className: 'opacity-70', text: ' Low' });
  modelSpan.appendChild(effortSpan);
  modelBtn.appendChild(modelSpan);
  footer.appendChild(modelBtn);
  card.appendChild(editorWrap);
  card.appendChild(footer);
  composerShell.appendChild(card);
  inputBox.appendChild(composerShell);
  home.appendChild(inputBox);
  body.appendChild(home);

  // Simulated Settings dialog containing General BEFORE Appearance
  const dialog = makeNode('div', { attrs: { role: 'dialog' } });
  const generalPanel = makeNode('div', { className: 'p-6 flex flex-col gap-4' });
  const generalH2 = makeNode('h2', { text: '常规' });
  const generalSec = makeNode('div', { className: 'space-y-2' });
  generalPanel.appendChild(generalH2);
  generalPanel.appendChild(generalSec);
  const appearancePanel = makeNode('div', { className: 'p-6 flex flex-col gap-4' });
  const appearanceH2 = makeNode('h2', { text: '外观' });
  const appearanceWrap = makeNode('div', { className: 'flex flex-col gap-8' });
  const appearanceSec = makeNode('div', { className: 'space-y-2' });
  appearanceWrap.appendChild(appearanceSec);
  appearancePanel.appendChild(appearanceH2);
  appearancePanel.appendChild(appearanceWrap);
  dialog.appendChild(generalPanel);
  dialog.appendChild(appearancePanel);
  body.appendChild(dialog);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    createElement: (t) => makeNode(t),
    getElementById: (id) => html.querySelector('#' + id),
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const timers = new Set();
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    Uint8Array,
    Float32Array,
    Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression(cdp.DEFAULT_CONFIG), sandbox);
    assert.equal(res.status, 'ok');
    assert.equal(html.getAttribute('data-ag-cs-style'), '1');
    assert.equal(html.getAttribute('data-ag-cs-palette'), 'obsidian');
    assert.equal(html.getAttribute('data-ag-cs-home'), 'studio');
    assert.equal(h1.textContent, "What's up next?");
    assert.equal(placeholder.getAttribute('data-ag-cs-placeholder'), '描述任务或提出问题');
    assert.equal(effortSpan.getAttribute('data-ag-cs-effort'), 'low');
    assert.equal(effortSpan.classList.contains('ag-cs-effort-badge'), true);
    assert.ok(head.querySelector('#ag-claude-style-css'));
    assert.ok(home.querySelector('.ag-cs-home-panel'));
    assert.ok(home.querySelector('.ag-cs-ripple-host'));
    assert.ok(home.querySelector('.ag-cs-ripple-canvas'));
    assert.ok(card.querySelector('.ag-cs-crab'));

    // Queued message container before composer shell gets raised by 46px when Clawd crab is active
    assert.equal(queuedWrap.getAttribute('data-ag-cs-queued'), '1');
    assert.equal(queuedWrap.style.getPropertyValue('margin-bottom'), '46px');

    const injectedCss = head.querySelector('#ag-claude-style-css')?.textContent || '';
    assert.ok(injectedCss.includes('width: 264px'));
    assert.ok(injectedCss.includes('margin-bottom: 46px !important'));
    assert.ok(injectedCss.includes('z-index: 12 !important'));
    assert.ok(injectedCss.includes('[data-effort-theme="light"]'));

    // Smooth typing caret overlay is mounted on editor host
    assert.equal(editorWrap.getAttribute('data-ag-cs-caret-host'), '1');
    assert.ok(editorWrap.querySelector('.ag-cs-smooth-caret'));

    // Interactive Thinking Effort Slider Popover (Claude Code & ChatGPT Performance Styles — NO inline style switch)
    assert.equal(sandbox.globalThis.__agCsPerfAssets.FRAME_COUNT, 31);
    assert.ok(sandbox.globalThis.__agCsPerfAssets.frames.every((u) => u.startsWith('data:image/webp;base64,')));

    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn);
    const effortPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(effortPop);
    assert.equal(effortPop.getAttribute('data-effort-style'), 'claude');
    assert.equal(effortPop.getAttribute('data-effort-theme'), 'dark');
    assert.equal(effortPop.getAttribute('data-perf-theme'), 'dark');
    assert.ok(effortPop.innerHTML.includes('ag-cs-effort-matrix'));
    assert.ok(effortPop.innerHTML.includes('ag-cs-effort-knob'));
    assert.ok(effortPop.innerHTML.includes('ag-cs-effort-value-slot'));
    assert.equal(effortPop.innerHTML.includes('ag-cs-effort-style-switch'), false);

    // Light theme (even under obsidian/claude palettes) must update popover theme attributes to "light"
    body.className = 'theme-light';
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, palette: 'obsidian' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(effortPop.getAttribute('data-effort-theme'), 'light');
    assert.equal(effortPop.getAttribute('data-perf-theme'), 'light');
    body.className = 'theme-dark';

    // Switch Effort Slider to ChatGPT (Codex) style via settings refresh
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({
      ...cdp.DEFAULT_CONFIG,
      effortSliderStyle: 'chatgpt',
      performanceBackdrop: 'page',
    });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // closes first
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // reopens in chatgpt (Codex) style
    const codexPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(codexPop);
    assert.equal(codexPop.getAttribute('data-effort-style'), 'chatgpt');
    assert.equal(codexPop.getAttribute('data-effort-theme'), 'dark');
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-track'));
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-fill'));
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-energy'));
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-stars'));
    assert.equal((codexPop.innerHTML.match(/class="ag-cs-codex-star"/g) || []).length, 22);
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-knob'));
    assert.equal(body.querySelector('.ag-cs-perf-backdrop'), null);

    // Switch Effort Slider to Liang Wufeng (31-frame performance portrait) + page backdrop
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({
      ...cdp.DEFAULT_CONFIG,
      effortSliderStyle: 'liangwufeng',
      performanceBackdrop: 'page',
    });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // closes Codex
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // reopens in liangwufeng style
    const lwfPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(lwfPop);
    assert.equal(lwfPop.getAttribute('data-effort-style'), 'liangwufeng');
    assert.equal(lwfPop.getAttribute('data-effort-theme'), 'dark');
    assert.ok(lwfPop.innerHTML.includes('ag-cs-chatgpt-rail'));
    assert.ok(lwfPop.innerHTML.includes('ag-cs-perf-bar'));
    assert.ok(lwfPop.innerHTML.includes('ag-cs-perf-thumb'));
    assert.ok(lwfPop.innerHTML.includes('ag-cs-perf-ticks'));
    assert.equal(lwfPop.innerHTML.includes('ag-cs-perf-status'), false);
    assert.equal(lwfPop.innerHTML.includes('ag-cs-effort-style-switch'), false);
    assert.ok(body.querySelector('.ag-cs-perf-backdrop'));

    // Context HUD popover opens cleanly with NO embedded settings controls, concise tab names, and clamps maxHeight on short viewports
    sandbox.window.innerHeight = 650;
    const origAnchorRect = modelBtn.getBoundingClientRect;
    modelBtn.getBoundingClientRect = () => ({ left: 260, top: 560, right: 390, bottom: 584, width: 130, height: 24 });
    sandbox.window.__agClaudeStyle.openContextPopover(modelBtn, 'quotas');
    const ctxPop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(ctxPop);
    assert.equal(ctxPop.style.maxHeight, '544px');
    assert.ok(parseInt(ctxPop.style.top, 10) + 300 <= 560);
    modelBtn.getBoundingClientRect = origAnchorRect;
    sandbox.window.innerHeight = 900;
    assert.ok(ctxPop.innerHTML.includes('模型配额'));
    assert.ok(ctxPop.innerHTML.includes('工具/代理 (0)'));
    assert.equal(ctxPop.innerHTML.includes('ag-cs-ctx-settings-list'), false);
    assert.equal(ctxPop.innerHTML.includes('Token HUD 与圆环快捷设置'), false);
    assert.equal(ctxPop.innerHTML.includes('data-hud-key'), false);

    // Settings section must mount ONLY in Appearance, NOT General, grouped cleanly into 3 cards + collapsible HUD details
    assert.equal(generalPanel.querySelector('#ag-cs-settings-sec'), null);
    const settingsSec = appearancePanel.querySelector('#ag-cs-settings-sec');
    assert.ok(settingsSec);
    assert.equal(settingsSec.querySelector('h3')?.textContent, 'AGY Claude Style (agy-claude-style)');
    const settingGroups = settingsSec.querySelectorAll('.ag-cs-settings-group');
    assert.equal(settingGroups.length, 4);
    assert.deepEqual(
      settingGroups.map((g) => g.getAttribute('data-ag-cs-group')),
      ['appearance', 'interaction', 'focus', 'telemetry']
    );
    const hudDetails = settingsSec.querySelector('.ag-cs-settings-details');
    assert.ok(hudDetails);
    assert.equal(hudDetails.hasAttribute('open'), false);
    const claudeCondRow = settingsSec.querySelector('[data-ag-cs-cond="claude"]');
    const lwfCondRow = settingsSec.querySelector('[data-ag-cs-cond="liangwufeng"]');
    assert.equal(claudeCondRow?.getAttribute('data-ag-cs-dim'), '1'); // because liangwufeng is currently active
    assert.equal(lwfCondRow?.hasAttribute('data-ag-cs-dim'), false);

    const settingKeys = new Set(
      appearancePanel.querySelectorAll('#ag-cs-settings-sec button').map((b) => b.getAttribute('data-ag-cs-key'))
    );
    assert.equal(settingKeys.size, 24);
    for (const expectedKey of [
      'language',
      'homeLayout',
      'palette',
      'logoInk',
      'sidebarRestyle',
      'composerRestyle',
      'effortSliderStyle',
      'effortAccent',
      'performanceBackdrop',
      'smoothCaret',
      'mascot',
      'homeRipple',
      'focusMode',
      'sprintMinutes',
      'meteorRide',
      'costGuard',
      'inlineStats',
      'ringMode',
      'turnBadges',
      'hudTopBar',
      'hudBottomBar',
      'hudRimProgress',
      'hudFooterChip',
      'hudCompact',
    ]) {
      assert.ok(settingKeys.has(expectedKey), `Missing settings control for ${expectedKey}`);
    }

    // Verify all 5 language buttons exist in Appearance settings and clicking switches UI + emits CDP binding
    const bindingCalls = [];
    sandbox[cdp.SETTING_BINDING] = (payload) => bindingCalls.push(JSON.parse(payload));
    const getLangBtns = () =>
      appearancePanel
        .querySelectorAll('#ag-cs-settings-sec button')
        .filter((b) => b.getAttribute('data-ag-cs-key') === 'language');
    assert.deepEqual(
      getLangBtns().map((b) => [b.getAttribute('data-ag-cs-val'), b.textContent]),
      [
        ['"zh-CN"', '简体中文'],
        ['"zh-TW"', '繁體中文'],
        ['"yue"', '粵語'],
        ['"en"', 'English'],
        ['"ja"', '日本語'],
      ]
    );

    const checkLangSwitch = (targetLang, hostTitle, expectedSettingsLangTitle, expectedOverviewTab, expectedPlaceholder, expectedQuotaTab) => {
      appearanceH2.textContent = hostTitle;
      const btn = getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === JSON.stringify(targetLang));
      assert.ok(btn, `Expected language button for ${targetLang}`);
      btn.dispatch('click');
      assert.equal(html.getAttribute('data-ag-cs-lang'), targetLang);
      const secNow = appearancePanel.querySelector('#ag-cs-settings-sec');
      assert.ok(secNow, `Settings section should stay mounted when Appearance title is ${hostTitle}`);
      assert.equal(secNow.getAttribute('data-ag-cs-lang'), targetLang);
      assert.equal(secNow.querySelector('[data-ag-cs-row="language"] [data-k="t"]')?.textContent, expectedSettingsLangTitle);
      assert.equal(home.querySelector('.ag-cs-home-tab[data-tab="overview"]')?.textContent, expectedOverviewTab);
      assert.equal(placeholder.getAttribute('data-ag-cs-placeholder'), expectedPlaceholder);
      assert.ok(ctxPop.innerHTML.includes(expectedQuotaTab));
    };

    checkLangSwitch('zh-TW', '外觀', '介面語言', '概覽', '描述任務或提出問題', '模型配額');
    checkLangSwitch('yue', '外觀', '介面語言', '概覽', '寫低你想做嘅任務或者問題', '模型配額');
    checkLangSwitch('en', 'Appearance', 'Interface Language', 'Overview', 'How can I help you today?', 'Quotas');
    assert.equal(html.hasAttribute('data-ag-cs-cjk'), false);
    checkLangSwitch('ja', '外観', '表示言語', '概要', 'タスクの説明や質問を入力してください', 'クォータ');
    assert.equal(html.getAttribute('data-ag-cs-cjk'), '1');
    checkLangSwitch('zh-CN', '外观', '界面语言', '概览', '描述任务或提出问题', '模型配额');

    // Also verify live open Effort Popover refreshes across languages
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn);
    const activeLwfPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(activeLwfPop);
    assert.ok(activeLwfPop.innerHTML.includes('性能 · PERFORMANCE'));
    getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"ja"').dispatch('click');
    assert.ok(activeLwfPop.innerHTML.includes('パフォーマンス'));
    getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"en"').dispatch('click');
    assert.ok(activeLwfPop.innerHTML.includes('PERFORMANCE'));
    getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"zh-CN"').dispatch('click');
    assert.ok(activeLwfPop.innerHTML.includes('性能 · PERFORMANCE'));

    assert.deepEqual(
      bindingCalls.map((c) => [c.key, c.value]),
      [
        ['language', 'zh-TW'],
        ['language', 'yue'],
        ['language', 'en'],
        ['language', 'ja'],
        ['language', 'zh-CN'],
        ['language', 'ja'],
        ['language', 'en'],
        ['language', 'zh-CN'],
      ]
    );
    appearanceH2.textContent = '外观';

    // Refreshing config to chatgpt (Codex) dims BOTH claude and liangwufeng sub-rows
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'chatgpt' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="claude"]')?.getAttribute('data-ag-cs-dim'), '1');
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="liangwufeng"]')?.getAttribute('data-ag-cs-dim'), '1');

    // Refreshing config externally syncs open Settings buttons & conditional row dimming immediately
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, palette: 'claude' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(html.getAttribute('data-ag-cs-palette'), 'claude');
    assert.equal(html.getAttribute('data-ag-cs-effort-accent'), 'on');
    assert.equal(html.getAttribute('data-ag-cs-perf-backdrop'), 'card');
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="claude"]')?.hasAttribute('data-ag-cs-dim'), false);
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="liangwufeng"]')?.getAttribute('data-ag-cs-dim'), '1');
    const claudeBtn = appearancePanel
      .querySelectorAll('#ag-cs-settings-sec button')
      .find((b) => b.getAttribute('data-ag-cs-key') === 'palette' && b.getAttribute('data-ag-cs-val') === '"claude"');
    assert.equal(claudeBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(claudeBtn.hasAttribute('data-pressed'), true);

    // Effort word-boundary guard: "Flow" inside a model label must not be tagged "low"
    effortSpan.textContent = 'Flow';
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, palette: 'obsidian' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(effortSpan.hasAttribute('data-ag-cs-effort'), false);

    // Teardown must cleanly remove everything and restore host greeting text!
    const rem = vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.ok(rem.removed >= 1);
    assert.equal(html.hasAttribute('data-ag-cs-style'), false);
    assert.equal(html.hasAttribute('data-ag-cs-effort-accent'), false);
    assert.equal(html.hasAttribute('data-ag-cs-perf-backdrop'), false);
    assert.equal(html.hasAttribute('data-ag-cs-lang'), false);
    assert.equal(html.hasAttribute('data-ag-cs-cjk'), false);
    assert.equal(sandbox.globalThis.__agCsEffortCore, undefined);
    assert.equal(sandbox.globalThis.__agCsPerfAssets, undefined);
    assert.equal(sandbox.globalThis.__agCsCleanups, undefined);
    assert.equal(body.querySelector('.ag-cs-perf-backdrop'), null);
    assert.equal(h1.textContent, 'Welcome back, girl. Where should we pick up?');
    assert.equal(placeholder.hasAttribute('data-ag-cs-placeholder'), false);
    assert.equal(effortSpan.hasAttribute('data-ag-cs-effort'), false);
    assert.equal(home.querySelector('.ag-cs-home-panel'), null);
    assert.equal(home.querySelector('.ag-cs-ripple-host'), null);
    assert.equal(home.querySelector('.ag-cs-ripple-canvas'), null);
    assert.equal(card.querySelector('.ag-cs-crab'), null);
    assert.equal(dialog.querySelector('#ag-cs-settings-sec'), null);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('buildInjectExpression defers cleanly when documentElement is null at document-start and mounts on DOMContentLoaded', () => {
  const docListeners = new Map();
  let htmlEl = null;
  let headEl = null;
  let bodyEl = null;
  const attrs = new Map();
  const makeStub = (tag) => ({
    tagName: tag.toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    parentElement: null,
    classList: { contains: () => false, add() {}, remove() {} },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    appendChild(c) { c.parentNode = this; c.parentElement = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; c.parentElement = null; return c; },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    hasAttribute(k) { return attrs.has(k); },
    removeAttribute(k) { attrs.delete(k); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
  });

  const doc = {
    get documentElement() { return htmlEl; },
    get head() { return headEl; },
    get body() { return bodyEl; },
    hidden: false,
    readyState: 'loading',
    createElement: (t) => makeStub(t),
    getElementById(id) {
      return headEl?.children?.find((c) => c.id === id) || htmlEl?.children?.find((c) => c.id === id) || null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(ev, fn) {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = docListeners.get(ev);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };

  let observedNode = null;
  const timers = new Set();
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class {
      observe(node) {
        if (!node) throw new TypeError('parameter 1 is not of type Node');
        observedNode = node;
      }
      disconnect() {}
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression(), sandbox);
    assert.equal(res.status, 'deferred');
    assert.equal(sandbox.window.__agClaudeStyle, undefined);

    // Simulate document parsing completing
    htmlEl = makeStub('html');
    headEl = makeStub('head');
    bodyEl = makeStub('body');
    htmlEl.appendChild(headEl);
    htmlEl.appendChild(bodyEl);
    doc.readyState = 'interactive';
    for (const fn of [...(docListeners.get('DOMContentLoaded') || [])]) fn();

    assert.ok(sandbox.window.__agClaudeStyle, 'Expected __agClaudeStyle to mount after DOMContentLoaded');
    assert.equal(observedNode, htmlEl);
    assert.ok(headEl.children.some((c) => c.id === cdp.STYLE_ID));
    assert.equal(attrs.get('data-ag-cs-style'), '1');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(sandbox.window.__agClaudeStyle, undefined);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('effort popover uses clientWidth (immune to pop-in scale), preserves Extra label, and mounts ChatGPT status only on interaction', async () => {
  const timers = new Set();
  const makeNode = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const parseAttrs = (str) => {
      const out = {};
      const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let m;
      while ((m = re.exec(str))) {
        out[m[1]] = m[2] ?? '';
      }
      return out;
    };
    const buildChildrenFromHtml = (parent, htmlStr) => {
      parent.children.length = 0;
      const stack = [parent];
      const tokRe = /<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
      let tok;
      while ((tok = tokRe.exec(htmlStr))) {
        if (tok[1]) {
          if (stack.length > 1) stack.pop();
        } else if (tok[2]) {
          const parsed = parseAttrs(tok[3] || '');
          const child = makeNode(tok[2], { className: parsed.class || '', attrs: parsed });
          stack[stack.length - 1].appendChild(child);
          if (!tok[4]) stack.push(child);
        } else if (tok[5]) {
          const cur = stack[stack.length - 1];
          const txt = tok[5].replace(/\s+/g, ' ');
          if (txt.trim()) cur._text += txt;
        }
      }
    };
    const matchesSimple = (n, s) => {
      let rest = s.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      _listeners: listeners,
      clientWidth: opts.clientWidth ?? (classes.has('ag-cs-effort-track') ? 230 : 264),
      offsetWidth: opts.offsetWidth ?? (classes.has('ag-cs-effort-track') ? 230 : 264),
      clientHeight: opts.clientHeight ?? 30,
      offsetHeight: opts.offsetHeight ?? 30,
      _knobTransitionLog: [],
      style: {
        _props: {},
        transition: '',
        backgroundImage: '',
        setProperty(k, v) {
          this._props[k] = String(v);
          if (k === '--ag-cs-knob-x') node._knobTransitionLog.push({ val: String(v), transition: this.transition });
        },
        getPropertyValue(k) { return this._props[k] || ''; },
        removeProperty(k) { delete this._props[k]; },
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, f) => (f === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : f ? classes.add(c) : classes.delete(c)),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      get innerHTML() { return this._html || ''; },
      set innerHTML(v) { this._html = String(v); buildChildrenFromHtml(this, this._html); },
      get childElementCount() { return children.length; },
      appendChild(ch) { ch.parentElement = this; ch.parentNode = this; children.push(ch); return ch; },
      removeChild(ch) { const i = children.indexOf(ch); if (i >= 0) children.splice(i, 1); ch.parentElement = null; ch.parentNode = null; return ch; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, force) { const on = force === undefined ? !attrs.has(k) : Boolean(force); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, payload = {}) {
        const list = listeners.get(ev) || [];
        for (const fn of list) fn({ stopPropagation() {}, preventDefault() {}, ...payload });
      },
      getContext() { return null; },
      getBoundingClientRect() {
        // Simulate 0.98 pop-in scale transform distorting boundingClientRect while clientWidth remains unscaled (230)
        if (classes.has('ag-cs-effort-track')) return { left: 16, top: 20, right: 241.4, bottom: 50, width: 225.4, height: 30 };
        return { left: 100, top: 500, right: 240, bottom: 524, width: 140, height: 24 };
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (sel.split(',').some((p) => matchesSimple(cur, p.trim()))) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (parts.some((p) => matchesSimple(c, p))) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-light' });
  html.appendChild(head);
  html.appendChild(body);

  const card = makeNode('div', { className: 'surface-composer-card' });
  const modelNameSpan = makeNode('span', { text: 'Gemini 4 Hydrogen Extra' });
  const effortSpan = makeNode('span', { text: ' Extra' });
  const modelBtn = makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  modelBtn.appendChild(modelNameSpan);
  modelBtn.appendChild(effortSpan);
  modelBtn.__reactFiber$test = {
    memoizedProps: {
      selectedModel: { label: 'Gemini 4 Hydrogen (XHigh)' },
      modelOptions: [
        { label: 'Gemini 3.8 Flash (Low)' },
        { label: 'Gemini 3.8 Flash (Medium)' },
        { label: 'Gemini 3.8 Flash (High)' },
        { label: 'Gemini 4 Hydrogen (Low)' },
        { label: 'Gemini 4 Hydrogen (Medium)' },
        { label: 'Gemini 4 Hydrogen (High)' },
        { label: 'Gemini 4 Hydrogen (XHigh)' },
      ],
      setSelectedModel() {},
    },
    return: null,
  };
  card.appendChild(modelBtn);
  const inputBox = makeNode('div', { attrs: { 'data-testid': 'agent-input-box' } });
  inputBox.appendChild(card);
  body.appendChild(inputBox);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const winListeners = new Map();
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/workspace' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    addEventListener(ev, fn) { if (!winListeners.has(ev)) winListeners.set(ev, new Set()); winListeners.get(ev).add(fn); },
    removeEventListener(ev, fn) { winListeners.get(ev)?.delete(fn); },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.runInNewContext(cdp.buildInjectExpression(), sandbox);
    assert.equal(winListeners.get('resize')?.size || 0, 1);

    // 1. Open Claude slider on Light theme + Extra badge + scaled getBoundingClientRect()
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn);
    const pop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(pop);
    assert.equal(pop.getAttribute('data-effort-theme'), 'light');
    assert.equal(pop.getAttribute('data-perf-theme'), 'light');
    assert.equal(pop.querySelector('.ag-cs-effort-value')?.textContent.trim(), 'Extra');

    const knob = pop.querySelector('.ag-cs-effort-knob');
    assert.ok(knob);
    // track.clientWidth === 230 => span = 214 => at apex (prog = 1) must be 214.00px (NOT scaled 209.40px)
    assert.equal(knob.style.getPropertyValue('--ag-cs-knob-x'), '214.00px');
    // Initial mount sets --ag-cs-knob-x synchronously with transition === 'none' so knob does not sweep from 0px
    assert.ok(knob._knobTransitionLog.length >= 1);
    assert.equal(knob._knobTransitionLog[0].val, '214.00px');
    assert.equal(knob._knobTransitionLog[0].transition, 'none');
    assert.equal(knob.style.transition, '');

    // If track.clientWidth === 0 (hidden/detached), positionKnob falls back cleanly to left: calc(...)
    const track = pop.querySelector('.ag-cs-effort-track');
    track.clientWidth = 0;
    pop._syncEffortKnob();
    assert.equal(knob.style.left, 'calc(1.0000 * (100% - 16px))');

    // 2. Switch to ChatGPT (Codex) mode: preserves "Extra" in value label, mounts 22 stars + nebula, responds to ArrowLeft/End
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'chatgpt', hudTopBar: true });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;

    const codexTrack = pop.querySelector('.ag-cs-codex-track');
    assert.ok(codexTrack, 'Expected Codex track element');
    assert.equal(pop.querySelectorAll('.ag-cs-codex-star').length, 22);
    assert.equal(pop.querySelector('.ag-cs-codex-value')?.textContent.trim(), 'Extra');
    assert.equal(pop.getAttribute('data-energy'), '1');
    codexTrack.dispatch('keydown', { key: 'Home' });
    assert.equal(pop.querySelector('.ag-cs-codex-value')?.textContent.trim(), 'Low');
    codexTrack.dispatch('keydown', { key: 'End' });
    assert.equal(pop.querySelector('.ag-cs-codex-value')?.textContent.trim(), 'Extra');

    // 2b. Switch to Liang Wufeng mode: preserves "Extra" in meta, verifies card scrim & translucent page backdrop, omits idle status until tick hover/click
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'liangwufeng', hudTopBar: true });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;

    const bgEl = pop.querySelector('.ag-cs-perf-card-bg');
    assert.ok(bgEl?.style?.backgroundImage.includes('76%'), 'Expected tightened 76% stop in card scrim');

    const meta = pop.querySelector('.ag-cs-perf-meta');
    assert.ok(meta?.textContent.includes('Extra'), `Expected Extra in meta, got: ${meta?.textContent}`);
    assert.equal(pop.querySelector('.ag-cs-perf-status'), null);

    const firstTick = pop.querySelector('.ag-cs-perf-tick');
    firstTick.dispatch('mouseenter');
    assert.ok(pop.querySelector('.ag-cs-perf-status'));
    firstTick.dispatch('mouseleave');
    assert.equal(pop.querySelector('.ag-cs-perf-status'), null);
    firstTick.dispatch('click');
    assert.ok(pop.querySelector('.ag-cs-perf-status'));

    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'liangwufeng', performanceBackdrop: 'page', hudTopBar: true });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    const pageBgEl = pop.querySelector('.ag-cs-perf-card-bg');
    assert.ok(pageBgEl);
    assert.equal((pageBgEl.style.backgroundImage.match(/linear-gradient\(/g) || []).length, 1, 'Expected only translucent scrim linear-gradient in page mode');

    // 3. Clicking XHigh from High when host dynamically sets badge to " Extra" updates open popover to "Extra"
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'claude' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    modelBtn.__reactFiber$test.memoizedProps.selectedModel = { label: 'Gemini 4 Hydrogen (High)' };
    modelBtn.__reactFiber$test.memoizedProps.setSelectedModel = (opt) => {
      modelBtn.__reactFiber$test.memoizedProps.selectedModel = opt;
      effortSpan.textContent = /\bXHigh\b/i.test(opt.label) ? ' Extra' : ' High';
    };
    effortSpan.textContent = ' High';
    effortSpan.setAttribute('data-ag-cs-effort', 'xhigh'); // intentionally stale attr must not shadow live ' High' text
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // closes previous
    assert.equal(pop.parentElement, null);
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // opens on High
    const activePop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(activePop);
    assert.equal(activePop.querySelector('.ag-cs-effort-value')?.textContent.trim(), 'High');
    const xhighTick = activePop.querySelector('.ag-cs-effort-tick[data-effort-id="xhigh"]');
    assert.ok(xhighTick);
    xhighTick.dispatch('click', { detail: 1 });
    assert.equal(effortSpan.getAttribute('data-ag-cs-effort'), 'extra');
    assert.equal(activePop.querySelector('.ag-cs-effort-value')?.textContent.trim(), 'Extra');
    assert.equal(activePop.querySelector('.ag-cs-effort-track')?.getAttribute('aria-valuetext'), 'Extra');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(winListeners.get('resize')?.size || 0, 0);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('bottom-right context ring navigates directly to quotas or breakdown tab based on ringMode', async () => {
  const timers = new Set();
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const parseAttrs = (str) => {
      const out = {};
      const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let m;
      while ((m = re.exec(str))) out[m[1]] = m[2] ?? '';
      return out;
    };
    const buildChildrenFromHtml = (parent, htmlStr) => {
      parent.children.length = 0;
      const stack = [parent];
      const tokRe = /<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
      let tok;
      while ((tok = tokRe.exec(htmlStr))) {
        if (tok[1]) {
          if (stack.length > 1) stack.pop();
        } else if (tok[2]) {
          const parsed = parseAttrs(tok[3] || '');
          const child = makeEl(tok[2], { className: parsed.class || '', attrs: parsed });
          stack[stack.length - 1].appendChild(child);
          if (!tok[4]) stack.push(child);
        } else if (tok[5]) {
          const cur = stack[stack.length - 1];
          const txt = tok[5].replace(/\s+/g, ' ');
          if (txt.trim()) cur._text += txt;
        }
      }
    };
    const matchesSimple = (n, s) => {
      let rest = s.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesChain = (n, selector) =>
      selector.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      _listeners: listeners,
      clientWidth: 280,
      offsetWidth: 280,
      clientHeight: 30,
      offsetHeight: 30,
      style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, getPropertyValue(k) { return this._props[k] || ''; }, removeProperty(k) { delete this._props[k]; } },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) { this._html = v; buildChildrenFromHtml(this, v); },
      get innerHTML() { return this._html || ''; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, extra = {}) {
        const e = { type: ev, stopPropagation() {}, preventDefault() {}, ...extra };
        for (const cb of [...(listeners.get(ev) || [])]) cb(e);
      },
      getBoundingClientRect() { return { left: 200, top: 600, right: 480, bottom: 630, width: 280, height: 30 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) { let cur = this; while (cur) { if (matchesChain(cur, sel)) return cur; cur = cur.parentElement; } return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesChain(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  const cascadeId = '11111111-1111-4111-8111-111111111111';
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const inputBox = makeEl('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeEl('div', { className: 'surface-composer-card' });
  const editorEl = makeEl('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  const modelBtn = makeEl('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  footer.appendChild(modelBtn);
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  const mockTraj = {
    trajectory: {
      steps: [
        { status: 3, step: { case: 'userInput' } },
        { status: 1, step: { case: 'plannerResponse', value: {} } },
      ],
      generatorMetadata: [
        {
          metadata: {
            value: {
              usage: { inputTokens: '2000', cacheReadTokens: '18000', outputTokens: '500', thinkingOutputTokens: '100' },
              chatStartMetadata: {
                contextWindowMetadata: { estimatedTokensUsed: 50000, maxContextTokens: 256000 },
              },
            },
          },
        },
      ],
    },
  };
  inputBox.__reactFiber$test = {
    memoizedProps: {
      cascadeId,
      store: {
        getState: () => ({
          cascadeTrajectorySummaries: {
            [cascadeId]: { stepCount: 2, lastModifiedTime: '2026-11-14T10:00:00Z' },
          },
        }),
        subscribe: () => () => {},
      },
    },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() { return mockTraj; },
          async retrieveUserQuotaSummary() { return { models: [] }; },
        },
      },
    },
    return: null,
  };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.runInNewContext(cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, ringMode: 'context' }), sandbox);
    await new Promise((r) => setTimeout(r, 80));

    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    assert.ok(ringBtn, 'Expected bottom-right context ring widget');

    ringBtn.dispatch('click');
    let pop = body.querySelector('.ag-cs-ctx-popover');
    assert.equal(pop?.querySelector('.is-active')?.getAttribute('data-ctx-tab'), 'breakdown');
    pop?.querySelector('.ag-cs-ctx-close')?.dispatch('click');

    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;

    ringBtn.dispatch('click');
    pop = body.querySelector('.ag-cs-ctx-popover');
    assert.equal(pop?.querySelector('.is-active')?.getAttribute('data-ctx-tab'), 'quotas');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('new conversation renders bottom-right ring and inline tokens info on home view and during Turn 1 (calls === 0)', async () => {
  const timers = new Set();
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const parseAttrs = (str) => {
      const out = {};
      const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let m;
      while ((m = re.exec(str))) out[m[1]] = m[2] ?? '';
      return out;
    };
    const buildChildrenFromHtml = (parent, htmlStr) => {
      parent.children.length = 0;
      const stack = [parent];
      const tokRe = /<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
      let tok;
      while ((tok = tokRe.exec(htmlStr))) {
        if (tok[1]) {
          if (stack.length > 1) stack.pop();
        } else if (tok[2]) {
          const parsed = parseAttrs(tok[3] || '');
          const child = makeEl(tok[2], { className: parsed.class || '', attrs: parsed });
          stack[stack.length - 1].appendChild(child);
          if (!tok[4]) stack.push(child);
        } else if (tok[5]) {
          const cur = stack[stack.length - 1];
          const txt = tok[5].replace(/\s+/g, ' ');
          if (txt.trim()) cur._text += txt;
        }
      }
    };
    const matchesSimple = (n, s) => {
      let rest = s.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesChain = (n, selector) =>
      selector.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      _listeners: listeners,
      clientWidth: 480,
      offsetWidth: 480,
      clientHeight: 30,
      offsetHeight: 30,
      style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, getPropertyValue(k) { return this._props[k] || ''; }, removeProperty(k) { delete this._props[k]; } },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) { this._html = v; buildChildrenFromHtml(this, v); },
      get innerHTML() { return this._html || ''; },
      get firstChild() { return children[0] || null; },
      get childElementCount() { return children.length; },
      get nextSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
      },
      get lastElementChild() { return children[children.length - 1] || null; },
      getContext() { return null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentElement = this;
        c.parentNode = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, extra = {}) {
        const e = { type: ev, stopPropagation() {}, preventDefault() {}, ...extra };
        for (const cb of [...(listeners.get(ev) || [])]) cb(e);
      },
      getBoundingClientRect() { return { left: 200, top: 600, right: 680, bottom: 630, width: 480, height: 30 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) { let cur = this; while (cur) { if (matchesChain(cur, sel)) return cur; cur = cur.parentElement; } return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesChain(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  // Part A: New conversation Home view (.agy-home, no conversation-view, no cascadeId) with ringMode: 'quota'
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const home = makeEl('div', { className: 'agy-home' });
  const greeting = makeEl('div', { attrs: { 'data-testid': 'home-greeting' } });
  greeting.appendChild(makeEl('h1', { className: 'home-greeting-title', text: 'Welcome' }));
  home.appendChild(greeting);

  const inputBox = makeEl('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeEl('div', { className: 'surface-composer-card' });
  const editorEl = makeEl('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  const modelBtn = makeEl('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  modelBtn.appendChild(makeEl('span', { text: 'Gemini 4 Hydrogen' }));
  modelBtn.appendChild(makeEl('span', { text: ' Extra' }));
  footer.appendChild(modelBtn);
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  home.appendChild(inputBox);
  body.appendChild(home);

  let currentCascadeId = '';
  let currentStatus = 2;
  let currentTraj = { trajectory: { steps: [], generatorMetadata: [] } };
  const docListeners = new Map();
  inputBox.__reactFiber$test = {
    memoizedProps: {
      get cascadeId() { return currentCascadeId; },
      store: {
        getState: () => ({
          trajectorySummaries: { summaries: currentCascadeId ? { [currentCascadeId]: { stepCount: currentTraj.trajectory.steps.length, status: currentStatus } } : {} },
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [{ label: 'Gemini 4 Hydrogen (XHigh)', quotaInfo: { remainingFraction: 0.42 } }],
            },
          },
        }),
        subscribe: () => () => {},
      },
    },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() { return currentTraj; },
          async retrieveUserQuotaSummary() {
            return { groups: [{ displayName: 'Gemini', buckets: [{ window: '5h', remaining: { case: 'remainingFraction', value: 0.42 } }] }] };
          },
        },
      },
    },
    return: null,
  };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener(ev, fn) { if (!docListeners.has(ev)) docListeners.set(ev, []); docListeners.get(ev).push(fn); },
    removeEventListener(ev, fn) { const a = docListeners.get(ev); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 5),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(
      cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota', hudFooterChip: true, hudTopBar: true }),
      sandbox
    );
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 60));

    // On .agy-home before sending, ring shows quota (42%) and inline stats + surround HUDs are mounted!
    const statsBtn = footer.querySelector('.ag-cs-inline-stats');
    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    const chip = footer.querySelector('.ag-cs-hud-footer-chip');
    const topBar = card.querySelector('.ag-cs-hud-top-bar');
    assert.ok(statsBtn, 'Expected inline tokens info on new conversation home view');
    assert.ok(ringBtn, 'Expected bottom-right ring on new conversation home view');
    assert.ok(chip, 'Expected optional footer chip when enabled on new conversation');
    assert.ok(topBar, 'Expected optional top HUD bar when enabled on new conversation');
    assert.equal(statsBtn.textContent, '0 轮 0 步 · 0 tok · 0% 缓存');
    assert.equal(ringBtn.getAttribute('data-ring-mode'), 'quota');
    assert.equal(ringBtn.querySelector('span')?.textContent, '42%');

    // Typing a draft in new conversation updates inline tokens estimate live
    editorEl.textContent = '帮我修复新建对话下未显示圆环及tokens信息的问题';
    for (const fn of [...(docListeners.get('input') || [])]) {
      fn({ type: 'input', target: editorEl });
    }
    await new Promise((r) => setTimeout(r, 40));
    assert.match(statsBtn.textContent, /^0 轮 0 步 · ~\d+ tok · 0% 缓存$/);

    // Part B: Transition into a newly started conversation while Turn 1 is still streaming (calls === 0)
    home.remove();
    currentCascadeId = '22222222-2222-4222-8222-222222222222';
    const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': currentCascadeId } });
    editorEl.textContent = '';
    currentTraj = {
      trajectory: {
        steps: [
          { status: 3, step: { case: 'userInput', value: { query: 'Hello' } } },
          { status: 1, metadata: { modelUsage: { outputTokens: '64' } }, step: { case: 'plannerResponse', value: { thinking: 'Thinking...' } } },
        ],
        generatorMetadata: [],
      },
    };
    convView.appendChild(inputBox);
    body.appendChild(convView);
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota' });
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(footer.querySelector('.ag-cs-inline-stats'), 'Expected inline stats during Turn 1 before generatorMetadata');
    assert.ok(footer.querySelector('.ag-cs-context-ring'), 'Expected ring during Turn 1 before generatorMetadata');
    assert.equal(footer.querySelector('.ag-cs-inline-stats')?.textContent, '0 轮 2 步 · ~64 tok · 0% 缓存');
    assert.equal(footer.querySelector('.ag-cs-context-ring span')?.textContent, '42%');

    // Part C: Once Turn 1 completes its first LLM call, stats & ring update in-place and click opens latest data
    currentStatus = 1;
    currentTraj = {
      trajectory: {
        steps: [
          { status: 3, step: { case: 'userInput', value: { query: 'Hello' } } },
          { status: 3, step: { case: 'plannerResponse', value: { response: 'Hi' } } },
        ],
        generatorMetadata: [
          {
            stepIndices: [0, 1],
            metadata: {
              value: {
                modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
                usage: { inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '300' },
                chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 20000, maxContextTokens: 734000 } },
              },
            },
          },
        ],
      },
    };
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota' });
    await new Promise((r) => setTimeout(r, 60));
    doc.hidden = false;

    assert.equal(footer.querySelector('.ag-cs-inline-stats')?.textContent, '1 轮 2 步 · 10.3k tok · 90% 缓存');
    footer.querySelector('.ag-cs-inline-stats')?.dispatch('click');
    const pop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(pop);
    assert.ok(pop.innerHTML.includes('734.0K'), `Expected updated 734.0K context window in popover, got ${pop.innerHTML}`);

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(footer.querySelector('.ag-cs-inline-stats'), null);
    assert.equal(footer.querySelector('.ag-cs-context-ring'), null);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('Q&A takeover card, side-question panel, and running tasks clear Clawd mascot without double spacing', async () => {
  const timers = new Set();
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const children = [];
    const matchesSimple = (node, simple) => {
      let rest = simple.trim();
      if (!rest) return false;
      const tagMatch = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tagMatch) {
        if (node.tagName !== tagMatch[0].toUpperCase()) return false;
        rest = rest.slice(tagMatch[0].length);
      }
      while (rest.length > 0) {
        if (rest[0] === '#') {
          const m = /^#((?:\\.|[a-zA-Z0-9_-])+)/.exec(rest);
          if (!m || node.id !== m[1].replace(/\\/g, '')) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !node.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? node.hasAttribute(m[1]) : node.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesChain = (node, selector) =>
      selector.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(node, tokens[tokens.length - 1])) return false;
        let cur = node.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || opts.id || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      clientWidth: 640,
      offsetWidth: 640,
      clientHeight: 40,
      offsetHeight: 40,
      style: {
        _props: {},
        setProperty(k, v) { this._props[k] = String(v); },
        getPropertyValue(k) { return this._props[k] || ''; },
        removeProperty(k) { delete this._props[k]; },
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      get childElementCount() { return children.length; },
      get firstChild() { return children[0] || null; },
      get nextSibling() {
        if (!this.parentElement) return null;
        const i = this.parentElement.children.indexOf(this);
        return i >= 0 ? this.parentElement.children[i + 1] || null : null;
      },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentElement = this;
        c.parentNode = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener() {},
      removeEventListener() {},
      getContext() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 40, width: 640, height: 40 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) { let cur = this; while (cur) { if (matchesChain(cur, sel)) return cur; cur = cur.parentElement; } return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesChain(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view' } });
  const rtcWrap = makeEl('div', { className: 'relative z-10 flex flex-col gap-1 min-h-0' });
  const takeoverWrap = makeEl('div', { className: 'relative z-[1] mb-1 flex flex-col min-h-0' });
  const takeoverCard = makeEl('div', { className: 'agy-takeover-frame', attrs: { 'data-testid': 'interaction-takeover-card' } });
  takeoverWrap.appendChild(takeoverCard);

  const contentsWrap = makeEl('div', { className: 'contents' });
  const inputBox = makeEl('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const queuedWrap = makeEl('div', { className: 'relative z-[1] flex flex-col gap-2 w-full hidden-if-empty mb-2' });
  const composerShell = makeEl('div', { id: 'antigravity.agentSidePanelInputBox', className: 'surface-composer' });
  const runningWrap = makeEl('div', { className: 'relative z-[1]' });
  const runningPanel = makeEl('div', { className: 'grid grid-rows-[0fr]', attrs: { 'data-testid': 'running-items-panel' } });
  runningWrap.appendChild(runningPanel);
  const card = makeEl('div', { className: 'surface-composer-card' });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  card.appendChild(footer);
  composerShell.appendChild(runningWrap);
  composerShell.appendChild(card);
  inputBox.appendChild(queuedWrap);
  inputBox.appendChild(composerShell);
  contentsWrap.appendChild(inputBox);

  rtcWrap.appendChild(takeoverWrap);
  rtcWrap.appendChild(contentsWrap);
  convView.appendChild(rtcWrap);
  body.appendChild(convView);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 5),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression(cdp.DEFAULT_CONFIG), sandbox);
    assert.equal(res.status, 'ok');

    // 1. Q&A takeover card alone: wrapper raised by 46px with data-ag-cs-takeover="1"
    assert.equal(takeoverWrap.getAttribute('data-ag-cs-takeover'), '1');
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(queuedWrap.hasAttribute('data-ag-cs-queued'), false);
    assert.equal(runningWrap.hasAttribute('data-ag-cs-queued'), false);

    // 2. When queued message is also present, queuedWrap takes the 46px clearance and takeoverWrap avoids double spacing
    const queuedItem = makeEl('div', { text: '排队中的消息' });
    queuedWrap.appendChild(queuedItem);
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(queuedWrap.getAttribute('data-ag-cs-queued'), '1');
    assert.equal(queuedWrap.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '');

    // 3. When queued clears and side-question-panel sits below takeoverWrap, side-question-panel takes clearance
    queuedItem.remove();
    const sideQ = makeEl('div', { attrs: { 'data-testid': 'side-question-panel' } });
    rtcWrap.insertBefore(sideQ, contentsWrap);
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(sideQ.getAttribute('data-ag-cs-takeover'), '1');
    assert.equal(sideQ.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);

    // 4. When running-items-panel expands (grid-rows-[1fr]), its wrapper takes the 46px clearance
    runningPanel.className = 'grid grid-rows-[1fr]';
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(runningWrap.getAttribute('data-ag-cs-queued'), '1');
    assert.equal(runningWrap.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(sideQ.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);

    // 5. Turning mascot off clears all takeover/queued clearances cleanly
    runningPanel.className = 'grid grid-rows-[0fr]';
    sideQ.remove();
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, mascot: 'off' });
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '');
    assert.equal(runningWrap.hasAttribute('data-ag-cs-queued'), false);

    // 6. Re-enable crab, verify takeover clearance returns, then verify REMOVE_EXPRESSION tears down cleanly
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(takeoverWrap.getAttribute('data-ag-cs-takeover'), '1');
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '46px');
    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '');

    const injectedCss = cdp.buildInjectExpression(cdp.DEFAULT_CONFIG);
    assert.ok(injectedCss.includes('interaction-takeover-card'));
    assert.ok(injectedCss.includes('side-question-panel'));
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('ring and popover stay live despite static trajectorySummaries and non-root child Fiber stores', async () => {
  const timers = new Set();
  const intervals = [];
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const children = [];
    const listeners = new Map();
    const parseAttrs = (str) => {
      const out = {};
      const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let m;
      while ((m = re.exec(str))) out[m[1]] = m[2] ?? '';
      return out;
    };
    const buildChildrenFromHtml = (parent, htmlStr) => {
      parent.children.length = 0;
      const stack = [parent];
      const tokRe = /<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
      let tok;
      while ((tok = tokRe.exec(htmlStr))) {
        if (tok[1]) {
          if (stack.length > 1) stack.pop();
        } else if (tok[2]) {
          const parsed = parseAttrs(tok[3] || '');
          const child = makeEl(tok[2], { className: parsed.class || '', attrs: parsed });
          stack[stack.length - 1].appendChild(child);
          if (!tok[4]) stack.push(child);
        } else if (tok[5]) {
          const cur = stack[stack.length - 1];
          const txt = tok[5].replace(/\s+/g, ' ');
          if (txt.trim()) cur._text += txt;
        }
      }
    };
    const matchesSimple = (n, sel) => {
      if (!n || n.nodeType !== 1) return false;
      let rest = sel.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesChain = (n, selector) =>
      selector.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      _listeners: listeners,
      clientWidth: 400,
      offsetWidth: 400,
      clientHeight: 30,
      offsetHeight: 30,
      style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, getPropertyValue(k) { return this._props[k] || ''; }, removeProperty(k) { delete this._props[k]; } },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) { this._html = v; buildChildrenFromHtml(this, v); },
      get innerHTML() { return this._html || ''; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, extra = {}) {
        const e = { type: ev, stopPropagation() {}, preventDefault() {}, ...extra };
        for (const cb of [...(listeners.get(ev) || [])]) cb(e);
      },
      getBoundingClientRect() { return { left: 200, top: 600, right: 600, bottom: 630, width: 400, height: 30 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) { let cur = this; while (cur) { if (matchesChain(cur, sel)) return cur; cur = cur.parentElement; } return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesChain(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  const cascadeId = '33333333-3333-4333-8333-333333333333';
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const inputBox = makeEl('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeEl('div', { className: 'surface-composer-card' });
  const editorEl = makeEl('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  const modelBtn = makeEl('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  footer.appendChild(modelBtn);
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  let currentTraj = {
    trajectory: {
      steps: [
        { status: 3, step: { case: 'userInput', value: { query: 'Start' } } },
        { status: 3, step: { case: 'plannerResponse', value: { response: 'Ready' } } },
      ],
      generatorMetadata: [
        {
          stepIndices: [0, 1],
          metadata: {
            value: {
              modelDisplayName: 'Orchestrator (Carbon)',
              usage: { inputTokens: '2000', cacheReadTokens: '7500', outputTokens: '500' },
              chatStartMetadata: {
                contextWindowMetadata: { estimatedTokensUsed: 10000, maxContextTokens: 256000 },
              },
            },
          },
        },
      ],
    },
  };

  // Dummy child store sits below real app root store on Fiber return chain
  const dummyStore = { getState: () => ({ localOnly: true }), subscribe: () => () => {} };
  const rootStore = {
    getState: () => ({
      trajectorySummaries: {
        summaries: {
          // Intentionally stays frozen at stepCount 2 / old timestamp even as trajectory grows
          [cascadeId]: { stepCount: 2, lastModifiedTime: '2026-11-17T10:00:00Z' },
        },
      },
    }),
    subscribe: () => () => {},
  };
  let trajectoryFetchCount = 0;
  const rootFiber = {
    memoizedProps: { store: rootStore },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() {
            trajectoryFetchCount += 1;
            return currentTraj;
          },
          async retrieveUserQuotaSummary() { return { groups: [] }; },
        },
      },
    },
    return: null,
  };
  inputBox.__reactFiber$test = {
    memoizedProps: { cascadeId, store: dummyStore },
    return: rootFiber,
  };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  let nowMs = 1_700_000_000_000;
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() { return nowMs; }
  }

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(() => fn(nowMs), 5),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    performance: { now: () => nowMs },
    Date: MockDate,
    Math, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, ringMode: 'context' }), sandbox);
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 40));

    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    assert.ok(ringBtn);
    assert.equal(ringBtn.querySelector('span')?.textContent, '96%');

    // Trajectory grows to >50% context used (140K / 256K -> 45% remaining) while trajectorySummaries stays frozen!
    currentTraj = {
      trajectory: {
        steps: [
          { status: 3, step: { case: 'userInput', value: { query: 'Start' } } },
          { status: 3, step: { case: 'plannerResponse', value: { response: 'Ready' } } },
          { status: 3, step: { case: 'userInput', value: { query: 'Continue' } } },
          { status: 3, step: { case: 'plannerResponse', value: { response: 'Working' } } },
        ],
        generatorMetadata: [
          ...currentTraj.trajectory.generatorMetadata,
          {
            stepIndices: [2, 3],
            metadata: {
              value: {
                modelDisplayName: 'Orchestrator (Carbon)',
                usage: { inputTokens: '12000', cacheReadTokens: '126000', outputTokens: '2000' },
                chatStartMetadata: {
                  contextWindowMetadata: { estimatedTokensUsed: 10000, maxContextTokens: 256000 },
                },
              },
            },
          },
        ],
      },
    };

    // 1. After idle TTL (4s), poll tick refreshes trajectory automatically without summary changes
    nowMs += 4000;
    for (const fn of intervals) fn();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(trajectoryFetchCount >= 2, 'Expected poll after TTL to re-fetch trajectory despite static summary');
    assert.equal(ringBtn.querySelector('span')?.textContent, '45%');

    // 2. Trajectory grows again to 75% used (192K / 256K -> 25% remaining); clicking ring refreshes popover immediately
    currentTraj = {
      trajectory: {
        steps: [
          ...currentTraj.trajectory.steps,
          { status: 3, step: { case: 'userInput', value: { query: 'More' } } },
          { status: 3, step: { case: 'plannerResponse', value: { response: 'More reply' } } },
        ],
        generatorMetadata: [
          ...currentTraj.trajectory.generatorMetadata,
          {
            stepIndices: [4, 5],
            metadata: {
              value: {
                modelDisplayName: 'Orchestrator (Carbon)',
                usage: { inputTokens: '15000', cacheReadTokens: '175000', outputTokens: '2000' },
              },
            },
          },
        ],
      },
    };
    ringBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    const pop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(pop, 'Expected context popover to open on ring click');
    assert.ok(pop.innerHTML.includes('25.0%'), `Expected popover to refresh to 25.0% remaining, got ${pop.innerHTML}`);

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('syncTurnBadges mounts exactly one #T badge on the final agent-response of multi-response tool turns without misalignment, and style.css fixes sidebar badges/actions', async () => {
  const css = cdp.readCss();
  assert.match(
    css,
    /\[data-testid="conversation-row-sidebar"\]\s*\{\s*min-height:\s*28px\s*!important;\s*height:\s*auto\s*!important;/,
    'style.css unlocks conversation row height to auto for two-line project badges'
  );
  assert.ok(
    css.includes('[data-testid="conversation-row-sidebar"]:has([data-project-glyph])') &&
      css.includes('min-height: 46px !important;'),
    'style.css expands rows with project badges'
  );
  assert.ok(
    css.includes('.agy-sidebar-row .agy-row-actions') && css.includes('background: transparent !important;'),
    'style.css overrides Antigravity triple-gradient .agy-row-actions backdrop'
  );

  const timers = new Set();
  const matchesSimple = (n, sel) => {
    if (!n || n.nodeType !== 1) return false;
    let rest = sel.replace(/^:scope\s*>\s*/, '').trim();
    if (!rest) return false;
    const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
    if (tm) {
      if (n.tagName !== tm[0].toUpperCase()) return false;
      rest = rest.slice(tm[0].length);
    }
    while (rest) {
      if (rest[0] === '#') {
        const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || n.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '.') {
        const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || !n.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '[') {
        const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
        if (!m) return false;
        const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
        if (!ok) return false;
        rest = rest.slice(m[0].length);
      } else {
        return false;
      }
    }
    return true;
  };
  const matchesChain = (n, selector) =>
    selector.split(',').some((part) => {
      const cleaned = part.replace(/^:scope\s*>\s*/, '').trim();
      const tokens = cleaned.split(/\s+/).filter(Boolean);
      if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
      let cur = n.parentElement;
      let idx = tokens.length - 2;
      while (cur && idx >= 0) {
        if (matchesSimple(cur, tokens[idx])) idx -= 1;
        cur = cur.parentElement;
      }
      return idx < 0;
    });

  const makeNode = (tag, { id = '', className = '', attrs = {}, text = '' } = {}) => {
    const children = [];
    const attrMap = new Map(Object.entries(attrs));
    const classes = new Set(String(className).split(/\s+/).filter(Boolean));
    const listeners = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      id,
      parentElement: null,
      parentNode: null,
      children,
      _text: text,
      _html: '',
      style: { _p: {}, setProperty(k, v) { this._p[k] = String(v); }, getPropertyValue(k) { return this._p[k] || ''; }, removeProperty(k) { delete this._p[k]; } },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, f) => (f === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : f ? classes.add(c) : classes.delete(c)),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        children.length = 0;
        const mSpan = /<span>([^<]*)<\/span>/.exec(this._html);
        if (mSpan) this.appendChild(makeNode('span', { text: mSpan[1] }));
      },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(ch) { ch.parentElement = this; ch.parentNode = this; children.push(ch); return ch; },
      removeChild(ch) { const i = children.indexOf(ch); if (i >= 0) children.splice(i, 1); ch.parentElement = null; ch.parentNode = null; return ch; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrMap.set(k, String(v)); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
      getAttribute(k) { return attrMap.has(k) ? attrMap.get(k) : null; },
      hasAttribute(k) { return attrMap.has(k); },
      removeAttribute(k) { attrMap.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrMap.has(k) : Boolean(f); if (on) attrMap.set(k, ''); else attrMap.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener() {},
      matches(sel) { return matchesChain(this, sel); },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matchesChain(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      getBoundingClientRect() { return { left: 100, top: 100, right: 500, bottom: 140, width: 400, height: 40 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      isConnected: true,
      clientWidth: 400,
      offsetWidth: 400,
      clientHeight: 30,
      offsetHeight: 30,
      dispatch(ev, extra = {}) {
        const e = { type: ev, stopPropagation() {}, preventDefault() {}, ...extra };
        for (const cb of [...(listeners.get(ev) || [])]) cb(e);
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (n, depth) => {
          for (const c of n.children) {
            const matched = parts.some((p) => {
              if (p.startsWith(':scope >')) return depth === 0 && matchesChain(c, p);
              return matchesChain(c, p);
            });
            if (matched) out.push(c);
            walk(c, depth + 1);
          }
        };
        walk(this, 0);
        return out;
      },
    };
    return node;
  };

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const cascadeId = '44444444-4444-4444-8444-444444444444';
  const convView = makeNode('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  // Turn 1: user message + 3 separate agent-response wrappers (simulating text -> tool -> text -> tool -> final summary)
  const u1 = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: 'Inspect repo' });
  const r1aWrap = makeNode('div', { id: 'turn1-resp-1' });
  const r1a = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Step 1' });
  r1aWrap.appendChild(r1a);
  const r1bWrap = makeNode('div', { id: 'turn1-resp-2' });
  const r1b = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Step 2' });
  r1bWrap.appendChild(r1b);
  const r1cWrap = makeNode('div', { id: 'turn1-resp-3' });
  const r1c = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Turn 1 final' });
  r1cWrap.appendChild(r1c);

  // Turn 2: user message + 2 separate agent-response wrappers
  const u2 = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: 'Fix bug' });
  const r2aWrap = makeNode('div', { id: 'turn2-resp-1' });
  const r2a = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Running test' });
  r2aWrap.appendChild(r2a);
  const r2bWrap = makeNode('div', { id: 'turn2-resp-2' });
  const r2b = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Turn 2 final' });
  r2bWrap.appendChild(r2b);

  for (const el of [u1, r1aWrap, r1bWrap, r1cWrap, u2, r2aWrap, r2bWrap]) convView.appendChild(el);

  const inputBox = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const editorEl = makeNode('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  const modelBtn = makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' }, text: 'Gemini 4 Neon' });
  footer.appendChild(modelBtn);
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  const traj = {
    trajectory: {
      steps: [
        { status: 3, metadata: { createdAt: { seconds: '1700001000' } }, step: { case: 'userInput', value: { query: 'Inspect repo' } } },
        { status: 3, metadata: { createdAt: { seconds: '1700001002' } }, step: { case: 'plannerResponse', value: { response: 'Step 1' } } },
        { status: 3, metadata: { createdAt: { seconds: '1700001003' } }, step: { case: 'viewFile', value: {} } },
        { status: 3, metadata: { createdAt: { seconds: '1700001005' } }, step: { case: 'plannerResponse', value: { response: 'Turn 1 final' } } },
        { status: 3, metadata: { createdAt: { seconds: '1700002000' } }, step: { case: 'userInput', value: { query: 'Fix bug' } } },
        { status: 3, metadata: { createdAt: { seconds: '1700002003' } }, step: { case: 'runCommand', value: {} } },
        { status: 3, metadata: { createdAt: { seconds: '1700002006' } }, step: { case: 'plannerResponse', value: { response: 'Turn 2 final' } } },
      ],
      generatorMetadata: [
        { stepIndices: [0, 1], metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '5000', cacheReadTokens: '10000', outputTokens: '300' } } } },
        { stepIndices: [2, 3], metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '6000', cacheReadTokens: '15000', outputTokens: '500' } } } },
        { stepIndices: [4, 5, 6], metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '8000', cacheReadTokens: '25000', outputTokens: '700' } } } },
      ],
    },
  };

  const rootStore = {
    getState: () => ({
      trajectorySummaries: {
        summaries: {
          [cascadeId]: { stepCount: 7, status: 1, lastModifiedTime: { seconds: '1700002006' } },
        },
      },
    }),
    subscribe: () => () => {},
  };
  const rootFiber = {
    memoizedProps: { store: rootStore },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() { return traj; },
          async retrieveUserQuotaSummary() { return { groups: [] }; },
        },
      },
    },
    return: null,
  };
  inputBox.__reactFiber$test = {
    memoizedProps: { cascadeId },
    return: rootFiber,
  };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/conversation/multi-resp-1' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    electronApi: {
      async getCascadeTrajectory() { return traj; },
      async getAllCascadeTrajectories() { return {}; },
    },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, turnBadges: true }), sandbox);
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 80));

    const allBars = convView.querySelectorAll('.ag-cs-turn-bar');
    assert.equal(allBars.length, 2, `Expected exactly 2 turn badges across 5 agent-response nodes, got ${allBars.length}`);

    // Turn 1 badge MUST sit on turn1-resp-3 (NOT turn1-resp-1 or turn1-resp-2)
    assert.equal(r1aWrap.querySelector('.ag-cs-turn-bar'), null);
    assert.equal(r1bWrap.querySelector('.ag-cs-turn-bar'), null);
    const bar1 = r1cWrap.querySelector('.ag-cs-turn-bar');
    assert.ok(bar1, 'Expected #T1 badge on final agent-response of Turn 1');
    assert.ok(bar1.innerHTML.includes('#T1'), `Expected #T1 in bar1, got ${bar1.innerHTML}`);

    // Turn 2 badge MUST sit on turn2-resp-2 (NOT turn2-resp-1)
    assert.equal(r2aWrap.querySelector('.ag-cs-turn-bar'), null);
    const bar2 = r2bWrap.querySelector('.ag-cs-turn-bar');
    assert.ok(bar2, 'Expected #T2 badge on final agent-response of Turn 2');
    assert.ok(bar2.innerHTML.includes('#T2'), `Expected #T2 in bar2, got ${bar2.innerHTML}`);

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('streaming Turn 2 response does not hijack #T1 badge, observer ignores external characterData, and pollIntervalMs is respected', async () => {
  const timers = new Set();
  const makeNode = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const children = [];
    const matchesSimple = (n, sel) => {
      if (!n || n.nodeType !== 1) return false;
      let rest = sel.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesSel = (n, sel) =>
      sel.split(',').some((part) => {
        const cleaned = part.trim().replace(/^:scope\s*>\s*/, '');
        const tokens = cleaned.split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      clientWidth: 400,
      offsetWidth: 400,
      clientHeight: 30,
      offsetHeight: 30,
      _text: opts.text || '',
      _html: '',
      style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) {
        this._html = String(v);
        children.length = 0;
        const mSpan = /<span>([^<]*)<\/span>/.exec(this._html);
        if (mSpan) this.appendChild(makeNode('span', { text: mSpan[1] }));
      },
      get innerHTML() { return this._html; },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); if (k === 'class') node.className = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener() {},
      removeEventListener() {},
      matches(sel) { return matchesSel(this, sel); },
      closest(sel) { let c = this; while (c) { if (matchesSel(c, sel)) return c; c = c.parentElement; } return null; },
      getBoundingClientRect: () => ({ left: 10, top: 100, right: 310, bottom: 130, width: 300, height: 30 }),
      animate: () => ({ cancel() {}, finished: Promise.resolve() }),
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (n, depth) => {
          for (const ch of n.children) {
            const matched = parts.some((p) => {
              if (p.startsWith(':scope >')) return depth === 0 && matchesSel(ch, p);
              return matchesSel(ch, p);
            });
            if (matched) out.push(ch);
            walk(ch, depth + 1);
          }
        };
        walk(this, 0);
        return out;
      },
    };
    return node;
  };

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const cascadeId = '55555555-5555-4555-8555-555555555555';
  const convView = makeNode('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const u1 = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: 'Turn 1 prompt' });
  const r1Wrap = makeNode('div', { id: 'turn1-wrap' });
  const r1 = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Turn 1 done' });
  r1.__reactFiber$test = {
    memoizedProps: {
      cascadeId,
      stepIndex: 1,
      container: {
        cascadeId,
        steps: [{ stepIndex: 1, metadata: { createdAt: { seconds: '1700001005' } } }],
      },
    },
    return: null,
  };
  r1Wrap.appendChild(r1);

  const u2 = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: 'Turn 2 prompt' });
  const r2Wrap = makeNode('div', { id: 'turn2-streaming-wrap' });
  const r2 = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Streaming...' });
  r2.__reactFiber$test = {
    memoizedProps: {
      cascadeId,
      stepIndex: 3,
      container: {
        cascadeId,
        steps: [{ stepIndex: 3, metadata: { createdAt: { seconds: '1700002005' } } }],
      },
    },
    return: null,
  };
  r2Wrap.appendChild(r2);

  for (const el of [u1, r1Wrap, u2, r2Wrap]) convView.appendChild(el);

  const inputBox = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const editorEl = makeNode('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  footer.appendChild(makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' }, text: 'Gemini 4 Neon' }));
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  // External code editor outside conversation-view
  const codeEditor = makeNode('div', { className: 'monaco-editor' });
  body.appendChild(codeEditor);

  // Trajectory: Turn 1 completed with generatorMetadata; Turn 2 is streaming with no generatorMetadata yet
  const traj = {
    trajectory: {
      steps: [
        { status: 3, metadata: { createdAt: { seconds: '1700001000' } }, step: { case: 'userInput', value: { query: 'Turn 1 prompt' } } },
        { status: 3, metadata: { createdAt: { seconds: '1700001005' } }, step: { case: 'plannerResponse', value: { response: 'Turn 1 done' } } },
        { status: 3, metadata: { createdAt: { seconds: '1700002000' } }, step: { case: 'userInput', value: { query: 'Turn 2 prompt' } } },
        { status: 2, metadata: { createdAt: { seconds: '1700002005' } }, step: { case: 'plannerResponse', value: { response: 'Streaming...' } } },
      ],
      generatorMetadata: [
        { stepIndices: [0, 1], metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '5000', cacheReadTokens: '10000', outputTokens: '300' } } } },
      ],
    },
  };

  const rootStore = {
    getState: () => ({
      trajectorySummaries: {
        summaries: { [cascadeId]: { stepCount: 4, status: 2, lastModifiedTime: { seconds: '1700002005' } } },
      },
    }),
    subscribe: () => () => {},
  };
  const rootFiber = {
    memoizedProps: { store: rootStore },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() { return traj; },
          async retrieveUserQuotaSummary() { return { groups: [] }; },
        },
      },
    },
    return: null,
  };
  inputBox.__reactFiber$test = { memoizedProps: { cascadeId }, return: rootFiber };

  const intervalDelays = [];
  let observerCb = null;
  let rafCalls = 0;

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class {
      constructor(cb) { observerCb = cb; }
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => { rafCalls++; return rafCalls; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (_fn, ms) => { intervalDelays.push(ms); return intervalDelays.length; },
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    electronApi: {
      async getCascadeTrajectory() { return traj; },
      async getAllCascadeTrajectories() { return {}; },
    },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(
      cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, turnBadges: true, pollIntervalMs: 3200 }),
      sandbox
    );
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 80));

    // Turn 1 badge MUST stay on Turn 1 and NOT jump onto streaming Turn 2 response
    const bar1 = r1Wrap.querySelector('.ag-cs-turn-bar');
    assert.ok(bar1, 'Expected #T1 badge to remain mounted on Turn 1');
    assert.ok(bar1.innerHTML.includes('#T1'));
    assert.equal(r2Wrap.querySelector('.ag-cs-turn-bar'), null, 'Streaming Turn 2 must not hijack #T1 badge');

    // Configured pollIntervalMs (3200ms) must NOT be clamped down to 1500ms
    assert.ok(intervalDelays.includes(3200), `Expected pollIntervalMs 3200 to be honored, got ${JSON.stringify(intervalDelays)}`);

    // characterData mutations outside conversation-view / agent-input-box must be ignored
    const rafBefore = rafCalls;
    observerCb([{ type: 'characterData', target: { nodeType: 3, parentElement: codeEditor } }]);
    assert.equal(rafCalls, rafBefore, 'External editor characterData must not trigger scheduleSync');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('virtualized 20-turn chat with thinking Turn 21 never leaks #T11 or #T20 onto thinking node across pre-poll, tool-thinking, and completion stages', async () => {
  const timers = new Set();
  const makeNode = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const children = [];
    const matchesSimple = (n, sel) => {
      if (!n || n.nodeType !== 1) return false;
      let rest = sel.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesSel = (n, sel) =>
      sel.split(',').some((part) => {
        const cleaned = part.trim().replace(/^:scope\s*>\s*/, '');
        const tokens = cleaned.split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      clientWidth: 600,
      offsetWidth: 600,
      clientHeight: 32,
      offsetHeight: 32,
      _text: opts.text || '',
      _html: '',
      style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) { this._html = String(v); },
      get innerHTML() { return this._html; },
      get firstChild() { return children[0] || null; },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentElement = this;
        c.parentNode = this;
        const i = ref ? children.indexOf(ref) : -1;
        if (i >= 0) children.splice(i, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); if (k === 'class') node.className = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener() {},
      removeEventListener() {},
      matches(sel) { return matchesSel(this, sel); },
      closest(sel) { let c = this; while (c) { if (matchesSel(c, sel)) return c; c = c.parentElement; } return null; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 32, width: 600, height: 32 }),
      animate: () => ({ cancel() {}, finished: Promise.resolve() }),
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (n, depth) => {
          for (const ch of n.children) {
            const matched = parts.some((p) => {
              if (p.startsWith(':scope >')) return depth === 0 && matchesSel(ch, p);
              return matchesSel(ch, p);
            });
            if (matched) out.push(ch);
            walk(ch, depth + 1);
          }
        };
        walk(this, 0);
        return out;
      },
    };
    return node;
  };

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const cascadeId = '66666666-6666-4666-8666-666666666666';
  const convView = makeNode('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });

  // Build 20 completed turns (#T1..#T20) in trajectory, but only mount #T12..#T20 in virtualized DOM
  const steps = [];
  const generatorMetadata = [];
  const domWraps = new Map();
  for (let t = 1; t <= 20; t++) {
    const uStepIdx = (t - 1) * 2;
    const rStepIdx = uStepIdx + 1;
    const tsBase = 1700000000 + t * 100;
    steps.push(
      { status: 3, metadata: { createdAt: { seconds: String(tsBase) } }, step: { case: 'userInput', value: { query: `Prompt ${t}` } } },
      { status: 3, metadata: { createdAt: { seconds: String(tsBase + 5) } }, step: { case: 'plannerResponse', value: { response: `Answer ${t}` } } }
    );
    generatorMetadata.push({
      stepIndices: [uStepIdx, rStepIdx],
      metadata: {
        value: {
          modelDisplayName: 'Gemini 3.8 Flash',
          usage: { inputTokens: String(1000 + t * 100), cacheReadTokens: String(100000 + t * 1000), outputTokens: String(90 + t) },
        },
      },
    });
    if (t >= 12) {
      const uNode = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: `Prompt ${t}` });
      const rWrap = makeNode('div', { id: `turn-${t}-wrap` });
      const rNode = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: `Answer ${t}` });
      rNode.__reactFiber$test = {
        memoizedProps: {
          cascadeId,
          stepIndex: rStepIdx,
          container: {
            cascadeId,
            steps: [{ stepIndex: rStepIdx, status: 3, metadata: { createdAt: { seconds: String(tsBase + 5) } } }],
          },
        },
        return: null,
      };
      rWrap.appendChild(rNode);
      convView.appendChild(uNode);
      convView.appendChild(rWrap);
      domWraps.set(t, rWrap);
    }
  }

  // Mount Turn 21 ("工作中") in the DOM right after #T20
  const u21 = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: '那个后台是啥任务' });
  const r21Wrap = makeNode('div', { id: 'turn-21-thinking-wrap' });
  const r21 = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: '工作中' });
  // Stage 1: pre-poll window where trajectory still only has #T1..#T20 (#T20.nextUserStepIdx === Infinity),
  // and Turn 21 DOM node has no Fiber step yet (or a new stepIndex > #T20.lastStepIdx)
  r21.__reactFiber$test = {
    memoizedProps: {
      cascadeId,
      stepIndex: 41,
      container: {
        cascadeId,
        steps: [{ stepIndex: 41, status: 1, metadata: { createdAt: { seconds: '1700002505' } } }],
      },
    },
    return: null,
  };
  r21Wrap.appendChild(r21);
  convView.appendChild(u21);
  convView.appendChild(r21Wrap);

  const inputBox = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const editorEl = makeNode('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  footer.appendChild(makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' }, text: 'Gemini 3.8 Flash' }));
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  const traj = { trajectory: { steps, generatorMetadata } };
  let sumStepCount = 40;
  let sumStatus = 2;

  const rootStore = {
    getState: () => ({
      trajectorySummaries: {
        summaries: { [cascadeId]: { stepCount: sumStepCount, status: sumStatus, lastModifiedTime: { seconds: '1700002505' } } },
      },
    }),
    subscribe: () => () => {},
  };
  const rootFiber = {
    memoizedProps: { store: rootStore },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() { return traj; },
          async retrieveUserQuotaSummary() { return { groups: [] }; },
        },
      },
    },
    return: null,
  };
  inputBox.__reactFiber$test = { memoizedProps: { cascadeId }, return: rootFiber };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  let pollFn = null;
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => {
      const id = setTimeout(() => fn(Date.now()), 5);
      timers.add(id);
      return id;
    },
    cancelAnimationFrame: (id) => { timers.delete(id); clearTimeout(id); },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn) => { pollFn = fn; return 1; },
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    electronApi: {
      async getCascadeTrajectory() { return traj; },
      async getAllCascadeTrajectories() { return {}; },
    },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(
      cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, turnBadges: true }),
      sandbox
    );
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 80));

    // Stage 1 (pre-poll cache window): #T12..#T20 stay on their own nodes, and Turn 21 ("工作中") has NO badge (neither #T11 nor #T20!)
    for (let t = 12; t <= 20; t++) {
      const bar = domWraps.get(t).querySelector('.ag-cs-turn-bar');
      assert.ok(bar && bar.innerHTML.includes(`#T${t}`), `Expected #T${t} on turn ${t} in Stage 1`);
    }
    assert.equal(r21Wrap.querySelector('.ag-cs-turn-bar'), null, 'Stage 1: thinking Turn 21 must not show #T11 or hijack #T20');

    // Stage 2: Trajectory poll delivers Turn 21 userInput + thinking step (and r21 lacks Fiber locator)
    r21.__reactFiber$test = null;
    steps.push(
      { status: 3, metadata: { createdAt: { seconds: '1700002500' } }, step: { case: 'userInput', value: { query: '那个后台是啥任务' } } },
      { status: 1, metadata: { createdAt: { seconds: '1700002505' } }, step: { case: 'plannerResponse', value: { thinking: 'Checking...', response: '' } } }
    );
    sumStepCount = 42;
    if (pollFn) pollFn();
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(domWraps.get(20).querySelector('.ag-cs-turn-bar')?.innerHTML.includes('#T20'));
    assert.equal(r21Wrap.querySelector('.ag-cs-turn-bar'), null, 'Stage 2: unmatched thinking Turn 21 must never fallback to #T11');

    // Stage 3: Turn 21 completes a tool call (Call 1) and is now thinking on Call 2 (status: 1)
    steps[41].status = 3;
    steps.push(
      { status: 3, metadata: { createdAt: { seconds: '1700002506' } }, step: { case: 'viewFile', value: { content: 'task' } } },
      { status: 1, metadata: { createdAt: { seconds: '1700002508' } }, step: { case: 'plannerResponse', value: { thinking: 'Still thinking...', response: '' } } }
    );
    generatorMetadata.push({
      stepIndices: [40, 41],
      metadata: {
        value: {
          modelDisplayName: 'Gemini 3.8 Flash',
          usage: { inputTokens: '500', cacheReadTokens: '125000', outputTokens: '45' },
        },
      },
    });
    r21.__reactFiber$test = {
      memoizedProps: {
        cascadeId,
        stepIndex: 43,
        container: {
          cascadeId,
          steps: [
            { stepIndex: 41, status: 3 },
            { stepIndex: 42, status: 3 },
            { stepIndex: 43, status: 1 },
          ],
        },
      },
      return: null,
    };
    sumStepCount = 44;
    if (pollFn) pollFn();
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(r21Wrap.querySelector('.ag-cs-turn-bar'), null, 'Stage 3: multi-step Turn 21 still thinking on Call 2 must not show premature HUD');

    // Stage 4: Turn 21 completes Call 2 (status: 3) -> #T21 mounts cleanly!
    steps[43].status = 3;
    steps[43].step.value.response = '后台没有正在运行的任务。';
    generatorMetadata.push({
      stepIndices: [42, 43],
      metadata: {
        value: {
          modelDisplayName: 'Gemini 3.8 Flash',
          usage: { inputTokens: '800', cacheReadTokens: '125500', outputTokens: '120' },
        },
      },
    });
    r21.__reactFiber$test.memoizedProps.container.steps[2].status = 3;
    sumStepCount = 45;
    sumStatus = 1;
    if (pollFn) pollFn();
    await new Promise((r) => setTimeout(r, 80));

    const bar21 = r21Wrap.querySelector('.ag-cs-turn-bar');
    assert.ok(bar21, 'Stage 4: completed Turn 21 should mount #T21 badge');
    assert.ok(bar21.innerHTML.includes('#T21'), `Expected #T21 in bar21, got ${bar21.innerHTML}`);

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('remote (cloud) conversation populates Token HUD, top bar, turn badges, and popover via live agentStateProvider when getCascadeTrajectory is unimplemented', async () => {
  const timers = new Set();
  const makeNode = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const listeners = new Map();
    const children = [];
    const matchesSimple = (n, sel) => {
      if (!n || n.nodeType !== 1) return false;
      let rest = sel.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesSel = (n, sel) =>
      sel.split(',').some((part) => {
        const cleaned = part.trim().replace(/^:scope\s*>\s*/, '');
        const tokens = cleaned.split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      clientWidth: 600,
      offsetWidth: 600,
      clientHeight: 32,
      offsetHeight: 32,
      _text: opts.text || '',
      _html: '',
      style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) {
        this._html = String(v);
        children.length = 0;
        const mSpan = /<span>([^<]*)<\/span>/.exec(this._html);
        if (mSpan) this.appendChild(makeNode('span', { text: mSpan[1] }));
      },
      get innerHTML() { return this._html; },
      get firstChild() { return children[0] || null; },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentElement = this;
        c.parentNode = this;
        const i = ref ? children.indexOf(ref) : -1;
        if (i >= 0) children.splice(i, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); if (k === 'class') node.className = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener() {},
      dispatch(ev, extra = {}) {
        const e = { type: ev, stopPropagation() {}, preventDefault() {}, ...extra };
        for (const cb of [...(listeners.get(ev) || [])]) cb(e);
      },
      matches(sel) { return matchesSel(this, sel); },
      closest(sel) { let c = this; while (c) { if (matchesSel(c, sel)) return c; c = c.parentElement; } return null; },
      getBoundingClientRect: () => ({ left: 100, top: 400, right: 620, bottom: 432, width: 520, height: 32 }),
      animate: () => ({ cancel() {}, finished: Promise.resolve() }),
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (n, depth) => {
          for (const ch of n.children) {
            const matched = parts.some((p) => {
              if (p.startsWith(':scope >')) return depth === 0 && matchesSel(ch, p);
              return matchesSel(ch, p);
            });
            if (matched) out.push(ch);
            walk(ch, depth + 1);
          }
        };
        walk(this, 0);
        return out;
      },
    };
    return node;
  };

  const cascadeId = '9108d632-06be-4d5d-8338-3e81f464fbfd';
  const prefixedCascadeId = `v1/default/jetski_remote_agents_3p/${cascadeId}`;
  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const convView = makeNode('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const u1 = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: 'Issue #4' });
  const r1Wrap = makeNode('div', { id: 'remote-turn1' });
  const r1 = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Analysis' });
  r1.__reactFiber$test = {
    memoizedProps: {
      cascadeId: prefixedCascadeId,
      stepIndex: 2,
      container: { cascadeId: prefixedCascadeId, steps: [{ stepIndex: 2 }] },
    },
    return: null,
  };
  r1Wrap.appendChild(r1);
  const u2 = makeNode('div', { attrs: { 'data-testid': 'user-input-step' }, text: 'Reply plan A' });
  const r2Wrap = makeNode('div', { id: 'remote-turn2' });
  const r2 = makeNode('div', { attrs: { 'data-testid': 'agent-response' }, text: 'Replied' });
  r2.__reactFiber$test = {
    memoizedProps: {
      cascadeId: prefixedCascadeId,
      stepIndex: 4,
      container: { cascadeId: prefixedCascadeId, steps: [{ stepIndex: 4 }] },
    },
    return: null,
  };
  r2Wrap.appendChild(r2);
  for (const el of [u1, r1Wrap, u2, r2Wrap]) convView.appendChild(el);

  const inputBox = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const editorEl = makeNode('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  footer.appendChild(makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' }, text: 'Gemini 4 Hydrogen High' }));
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  // Live agentStateProvider starts empty (connecting), then streams cloud steps!
  let liveAgentState = {
    conversationId: cascadeId,
    status: 2,
    fullyIdle: false,
    trajectorySlice: {
      conversationId: cascadeId,
      totalStepsLength: 0,
      stepsSlice: { startIndex: 0 },
      stepsInSlice: [],
      generatorMetadatasInSlice: [],
    },
  };
  const providerListeners = new Set();
  let disposedListenerCount = 0;
  const liveProvider = {
    getState: () => liveAgentState,
    onDidChange: (cb) => {
      providerListeners.add(cb);
      return {
        dispose: () => {
          providerListeners.delete(cb);
          disposedListenerCount++;
        },
      };
    },
  };

  let getCascadeCalls = 0;
  const rootStore = {
    getState: () => ({
      conversation: { convoState: { type: 'active', cascadeId } },
      trajectorySummaries: {
        summaries: {
          [cascadeId]: {
            cloud: true,
            stepCount: 0,
            status: 1,
            lastModifiedTime: { seconds: '1795181631' },
          },
        },
      },
    }),
    subscribe: () => () => {},
  };

  const trajCtx = {
    peek: (id) => (id === cascadeId ? liveProvider : undefined),
    getAgentStates: () => new Map([[cascadeId, { provider: liveProvider }]]),
    subscribe: (id) => (id === cascadeId ? { agentStateProvider: liveProvider, unsubscribe: () => {} } : undefined),
  };

  const rootFiber = {
    memoizedProps: { store: rootStore },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() {
            getCascadeCalls++;
            throw new Error('ConnectError: [unimplemented] unimplemented: cloudproxy: GetConversation: unimplemented');
          },
          async retrieveUserQuotaSummary() {
            return {
              groups: [{ name: 'Gemini', buckets: [{ window: '5h', disabled: false, remainingPct: 72 }] }],
            };
          },
        },
        next: {
          memoizedValue: trajCtx,
          next: null,
        },
      },
    },
    return: null,
  };
  inputBox.__reactFiber$test = { memoizedProps: { cascadeId }, return: rootFiber };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => {
      const id = setTimeout(() => fn(Date.now()), 5);
      timers.add(id);
      return id;
    },
    cancelAnimationFrame: (id) => { timers.delete(id); clearTimeout(id); },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(
      cdp.buildInjectExpression({
        ...cdp.DEFAULT_CONFIG,
        ringMode: 'quota',
        hudTopBar: true,
        hudBottomBar: true,
        turnBadges: true,
      }),
      sandbox
    );
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 60));

    // Must not call unimplemented getCascadeTrajectory for cloud: true summary
    assert.equal(getCascadeCalls, 0);
    assert.equal(providerListeners.size, 1, 'Expected live subscription to cloud agentStateProvider.onDidChange');

    // Now cloud stream delivers steps with step-level modelUsage & empty generatorMetadata stubs
    liveAgentState = {
      conversationId: cascadeId,
      status: 1,
      fullyIdle: true,
      trajectorySlice: {
        conversationId: cascadeId,
        totalStepsLength: 5,
        stepsSlice: { startIndex: 0 },
        stepsInSlice: [
          {
            status: 3,
            metadata: { createdAt: { seconds: '1795180381' }, sourceTrajectoryStepInfo: { stepIndex: 0 } },
            step: { case: 'userInput', value: { query: '', userResponse: '看看 issue #4' } },
          },
          {
            status: 3,
            metadata: { createdAt: { seconds: '1795180385' }, sourceTrajectoryStepInfo: { stepIndex: 1 } },
            step: { case: 'viewFile', value: { absolutePathUri: 'file:///home/antigravity/repo/inject.js', lineRangeBytes: 9000 } },
          },
          {
            status: 3,
            metadata: {
              createdAt: { seconds: '1795180390' },
              viewableAt: { seconds: '1795180393' },
              finishedGeneratingAt: { seconds: '1795180398' },
              modelUsage: { inputTokens: '16000', cacheReadTokens: '30000', outputTokens: '1000', thinkingOutputTokens: '400', responseOutputTokens: '600' },
              modelInfo: { displayName: 'Gemini 4 Neon (High)', modelName: 'gemini-4-neon-high', maxTokens: 1048576 },
              sourceTrajectoryStepInfo: { stepIndex: 2 },
            },
            step: { case: 'plannerResponse', value: { response: '分析完成' } },
          },
          {
            status: 3,
            metadata: { createdAt: { seconds: '1795181503' }, sourceTrajectoryStepInfo: { stepIndex: 3 } },
            step: { case: 'userInput', value: { query: '', userResponse: '按方案 A 回复' } },
          },
          {
            status: 3,
            metadata: {
              createdAt: { seconds: '1795181510' },
              viewableAt: { seconds: '1795181513' },
              finishedGeneratingAt: { seconds: '1795181515' },
              modelUsage: { inputTokens: '4000', cacheReadTokens: '50000', outputTokens: '400', thinkingOutputTokens: '100', responseOutputTokens: '300' },
              modelInfo: { displayName: 'Gemini 4 Hydrogen (High)', modelName: 'gemini-4-hydrogen-high', maxTokens: 1048576 },
              sourceTrajectoryStepInfo: { stepIndex: 4 },
            },
            step: { case: 'plannerResponse', value: { response: '已回复' } },
          },
        ],
        generatorMetadatasInSlice: [0, 1, 2, 3, 4].map((i) => ({
          stepIndices: [i],
          metadata: {},
          plannerConfig: { modelName: 'Gemini 4 Hydrogen (High)' },
        })),
      },
    };
    for (const cb of [...providerListeners]) cb(liveAgentState);
    await new Promise((r) => setTimeout(r, 260));

    const statsBtn = footer.querySelector('.ag-cs-inline-stats');
    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    const topBar = card.querySelector('.ag-cs-hud-top-bar');
    const botBar = card.querySelector('.ag-cs-hud-bottom-bar');
    assert.ok(statsBtn && ringBtn && topBar && botBar);

    // Inline stats reflects real remote calls, steps, speed, total tokens & cache hit
    assert.match(statsBtn.textContent, /^2 轮 5 步 · 200 tok\/s · 101\.4k tok · 80% 缓存$/);
    // Ring stays in quota mode (72%) while Top HUD bar consistently shows context % & 1.05M window!
    assert.equal(ringBtn.querySelector('span')?.textContent, '72%');
    assert.ok(topBar.innerHTML.includes('剩余 95%'), `Expected top bar context remaining 95%, got ${topBar.innerHTML}`);
    assert.ok(topBar.innerHTML.includes('/ 1.05M'), `Expected top bar 1.05M window, got ${topBar.innerHTML}`);
    assert.ok(topBar.innerHTML.includes('已用 54.3K'), `Expected top bar used 54.3K, got ${topBar.innerHTML}`);
    assert.ok(topBar.innerHTML.includes('缓存 80%'), `Expected top bar cache 80%, got ${topBar.innerHTML}`);

    // Per-turn badges mount on BOTH turns even with prefixed v1/default/jetski_remote_agents_3p/ Fiber cascadeId!
    const bar1 = r1Wrap.querySelector('.ag-cs-turn-bar');
    const bar2 = r2Wrap.querySelector('.ag-cs-turn-bar');
    assert.ok(bar1 && bar1.innerHTML.includes('#T1'), 'Expected #T1 badge in remote conversation');
    assert.ok(bar2 && bar2.innerHTML.includes('#T2'), 'Expected #T2 badge in remote conversation');

    // Clicking stats opens popover with full remote telemetry
    statsBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    const pop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(pop);
    assert.ok(pop.innerHTML.includes('1.05M'));
    assert.ok(pop.innerHTML.includes('Gemini 4 Hydrogen (High)'));

    assert.equal(getCascadeCalls, 0);

    // Teardown must dispose agentStateProvider listener cleanly
    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(providerListeners.size, 0);
    assert.ok(disposedListenerCount >= 1);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('fallback to createAgentStateProviderForConvo when getCascadeTrajectory throws cloudproxy unimplemented without cloud summary flag', async () => {
  const timers = new Set();
  const makeNode = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const children = [];
    const matchesSimple = (n, sel) => {
      if (!n || n.nodeType !== 1) return false;
      let rest = sel.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesSel = (n, sel) =>
      sel.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      clientWidth: 400,
      offsetWidth: 400,
      clientHeight: 30,
      offsetHeight: 30,
      _text: opts.text || '',
      _html: '',
      style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) {
        this._html = String(v);
        children.length = 0;
        const mSpan = /<span>([^<]*)<\/span>/.exec(this._html);
        if (mSpan) this.appendChild(makeNode('span', { text: mSpan[1] }));
      },
      get innerHTML() { return this._html; },
      get firstChild() { return children[0] || null; },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      insertBefore(c, ref) { c.parentElement = this; c.parentNode = this; const i = ref ? children.indexOf(ref) : -1; if (i >= 0) children.splice(i, 0, c); else children.push(c); return c; },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener() {},
      removeEventListener() {},
      matches(sel) { return matchesSel(this, sel); },
      closest(sel) { let c = this; while (c) { if (matchesSel(c, sel)) return c; c = c.parentElement; } return null; },
      getBoundingClientRect: () => ({ left: 10, top: 100, right: 310, bottom: 130, width: 300, height: 30 }),
      animate: () => ({ cancel() {}, finished: Promise.resolve() }),
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const ch of n.children) {
            if (matchesSel(ch, sel)) out.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return out;
      },
    };
  };

  const cascadeId = '87822bdb-220b-46cb-b17e-eb9cbad81014';
  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);
  const convView = makeNode('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const inputBox = makeNode('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  footer.appendChild(makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' }, text: 'Gemini 4 Neon High' }));
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  let getCascadeAttempts = 0;
  let tempProviderDisposed = 0;
  const rootStore = {
    getState: () => ({ trajectorySummaries: { summaries: {} } }),
    subscribe: () => () => {},
  };
  const rootFiber = {
    memoizedProps: { store: rootStore },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() {
            getCascadeAttempts++;
            throw new Error('ConnectError: [unimplemented] unimplemented: cloudproxy: GetConversation: unimplemented');
          },
          createAgentStateProviderForConvo(id) {
            let st = { conversationId: id, status: 2, trajectorySlice: { stepsInSlice: [] } };
            const listeners = new Set();
            const t = setTimeout(() => {
              st = {
                conversationId: id,
                status: 1,
                fullyIdle: true,
                trajectorySlice: {
                  conversationId: id,
                  totalStepsLength: 2,
                  stepsSlice: { startIndex: 0 },
                  stepsInSlice: [
                    { status: 3, metadata: { createdAt: { seconds: '1795189880' } }, step: { case: 'userInput', value: { userResponse: '环境信息' } } },
                    {
                      status: 3,
                      metadata: {
                        createdAt: { seconds: '1795189882' },
                        viewableAt: { seconds: '1795189884' },
                        finishedGeneratingAt: { seconds: '1795189886' },
                        modelUsage: { inputTokens: '12000', cacheReadTokens: '18000', outputTokens: '300', thinkingOutputTokens: '100', responseOutputTokens: '200' },
                        modelInfo: { displayName: 'Gemini 4 Neon (High)', maxTokens: 1048576 },
                      },
                      step: { case: 'plannerResponse', value: { response: 'Linux x86_64' } },
                    },
                  ],
                  generatorMetadatasInSlice: [{ stepIndices: [1], metadata: {} }],
                },
              };
              for (const cb of [...listeners]) cb(st);
            }, 25);
            timers.add(t);
            return {
              getState: () => st,
              onDidChange: (cb) => {
                listeners.add(cb);
                return { dispose: () => listeners.delete(cb) };
              },
              dispose: () => { tempProviderDisposed++; listeners.clear(); },
            };
          },
        },
      },
    },
    return: null,
  };
  inputBox.__reactFiber$test = { memoizedProps: { cascadeId }, return: rootFiber };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    getElementById: () => null,
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { const id = setTimeout(() => fn(Date.now()), 5); timers.add(id); return id; },
    cancelAnimationFrame: (id) => { timers.delete(id); clearTimeout(id); },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, ringMode: 'context' }), sandbox);
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(getCascadeAttempts, 1, 'Should attempt getCascadeTrajectory once then remember cloud-only failure');
    assert.ok(tempProviderDisposed >= 1, 'Temporary agentStateProvider must be disposed after snapshot');
    assert.match(footer.querySelector('.ag-cs-inline-stats')?.textContent || '', /^1 轮 2 步 · 150 tok\/s · 30\.3k tok · 60% 缓存$/);
    assert.equal(footer.querySelector('.ag-cs-context-ring span')?.textContent, '97%');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('hudBottomBar triggers quota fetch in context mode, low-context triggers /compact warning on target composer, copy reports telemetry, and 3-way loadSettings preserves local edits', async () => {
  const timers = new Set();
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const listeners = new Map();
    const children = [];
    const matchesSimple = (n, sel) => {
      if (!n || n.nodeType !== 1) return false;
      let rest = sel.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesSel = (n, sel) =>
      sel.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      clientWidth: 420,
      offsetWidth: 420,
      clientHeight: 32,
      offsetHeight: 32,
      _text: opts.text || '',
      _html: '',
      _props: {},
      style: {
        setProperty(k, v) { el._props[k] = String(v); },
        getPropertyValue(k) { return el._props[k] || ''; },
        removeProperty(k) { delete el._props[k]; },
      },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) {
        this._html = String(v);
        children.length = 0;
        const mBtn = /data-hud-compact-btn="1"/.test(this._html);
        if (mBtn) {
          this.appendChild(makeEl('button', { className: 'ag-cs-hud-compact-btn', attrs: { 'data-hud-compact-btn': '1' }, text: '/compact' }));
        }
        const acts = Array.from(this._html.matchAll(/data-ctx-act="([^"]+)"/g));
        for (const m of acts) {
          this.appendChild(makeEl('button', { className: 'ag-cs-ctx-act-btn', attrs: { 'data-ctx-act': m[1] } }));
        }
        const mSpan = /<span>([^<]*)<\/span>/.exec(this._html);
        if (mSpan) this.appendChild(makeEl('span', { text: mSpan[1] }));
      },
      get innerHTML() { return this._html; },
      get childElementCount() { return children.length; },
      get firstChild() { return children[0] || null; },
      get firstElementChild() { return children[0] || null; },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(ch) { ch.parentElement = ch.parentNode = el; children.push(ch); return ch; },
      insertBefore(ch, ref) { ch.parentElement = ch.parentNode = el; const i = ref ? children.indexOf(ref) : -1; if (i >= 0) children.splice(i, 0, ch); else children.push(ch); return ch; },
      removeChild(ch) { const i = children.indexOf(ch); if (i >= 0) children.splice(i, 1); ch.parentElement = ch.parentNode = null; return ch; },
      remove() { if (el.parentElement) el.parentElement.removeChild(el); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') el.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const arr = listeners.get(ev); if (arr) { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1); } },
      dispatch(ev, payload = {}) { for (const fn of [...(listeners.get(ev) || [])]) fn({ type: ev, stopPropagation() {}, preventDefault() {}, ...payload }); },
      focus() {},
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      getBoundingClientRect: () => ({ left: 10, top: 320, right: 430, bottom: 352, width: 420, height: 32 }),
      closest(sel) { let c = el; while (c) { if (matchesSel(c, sel)) return c; c = c.parentElement; } return null; },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const res = [];
        const walk = (n) => {
          for (const ch of n.children || []) {
            if (matchesSel(ch, sel)) res.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return res;
      },
    };
    return el;
  };

  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  // Two composer boxes: an unrelated earlier box (hidden/other) and our active card's box!
  const otherBox = makeEl('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const otherEd = makeEl('div', { attrs: { contenteditable: 'true' }, text: 'untouched other composer' });
  otherBox.appendChild(otherEd);
  body.appendChild(otherBox);

  const cascadeId = 'low-ctx-convo-1';
  const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const activeBox = makeEl('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeEl('div', { className: 'surface-composer-card' });
  const activeEd = makeEl('div', { attrs: { contenteditable: 'true' } });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  card.appendChild(activeEd);
  card.appendChild(footer);
  activeBox.appendChild(card);
  convView.appendChild(activeBox);
  body.appendChild(convView);

  let quotaCalls = 0;
  let copiedText = '';
  const fakeTraj = {
    trajectory: {
      steps: [
        { status: 3, metadata: { createdAt: '2026-11-17T12:00:00Z' }, step: { case: 'userInput', value: { query: 'Trim context window' } } },
        { status: 3, metadata: { createdAt: '2026-11-17T12:00:05Z' }, step: { case: 'plannerResponse', value: { response: 'Working...' } } },
      ],
      generatorMetadata: [
        {
          stepIndices: [1],
          metadata: {
            value: {
              modelDisplayName: 'Claude Sonnet 4.5',
              usage: { inputTokens: '12000', cacheReadTokens: '160000', outputTokens: '4000', model: 1001 },
              chatStartMetadata: {
                contextWindowMetadata: { maxContextTokens: 200000, estimatedTokensUsed: 176000 }, // 12% free (<= 20%)
              },
            },
          },
        },
      ],
    },
  };
  const fakeRootStore = {
    getState: () => ({
      trajectorySummaries: { [cascadeId]: { summary: { stepCount: 2, status: 1 } } },
      userStatus: {
        cascadeModelConfigData: {
          clientModelGroups: [
            {
              groupName: 'Claude Sonnet',
              buckets: [{ id: 'b5h', window: '5h', remainingFraction: 0.65, resetTime: new Date(Date.now() + 3600000).toISOString() }],
            },
          ],
        },
      },
    }),
    subscribe: () => () => {},
  };
  const fakeSvc = {
    async getCascadeTrajectory() { return fakeTraj; },
    async retrieveUserQuotaSummary() {
      quotaCalls++;
      return {
        groups: [
          {
            displayName: 'Claude Sonnet',
            buckets: [
              {
                bucketId: 'b5h',
                window: '5h',
                remaining: { case: 'remainingFraction', value: 0.65 },
                resetTime: new Date(Date.now() + 3600000).toISOString(),
              },
            ],
          },
        ],
      };
    },
  };
  activeBox.__reactFiber$test = {
    memoizedProps: { cascadeId, store: fakeRootStore, getCascadeTrajectory: fakeSvc.getCascadeTrajectory },
    dependencies: { firstContext: { memoizedValue: fakeSvc, next: null } },
    return: null,
  };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };
  const storage = { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } };
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN', clipboard: { writeText: async (t) => { copiedText = t; } } },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: storage,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { const id = setTimeout(() => fn(Date.now()), 5); timers.add(id); return id; },
    cancelAnimationFrame: (id) => { timers.delete(id); clearTimeout(id); },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    InputEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(
      cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, ringMode: 'context', hudBottomBar: true, hudTopBar: true }),
      sandbox
    );
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 120));

    // 1. hudBottomBar must trigger quota fetch even when ringMode is 'context'
    assert.ok(quotaCalls >= 1, 'Expected hudBottomBar to trigger quota fetch in context mode');
    const botBar = card.querySelector('.ag-cs-hud-bottom-bar');
    assert.ok(botBar && botBar.innerHTML.includes('65%'), `Expected bottom HUD bar to render 65% quota, got ${botBar?.innerHTML}`);

    // 2. Low context (12% remaining <= 20%) flags ring, top bar & /compact button
    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    const topBar = card.querySelector('.ag-cs-hud-top-bar');
    assert.equal(ringBtn?.getAttribute('data-ctx-low'), 'warn');
    assert.equal(topBar?.getAttribute('data-ctx-low'), 'warn');

    // 3. Popover shows low-ctx banner & working Copy button
    ringBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    const pop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(pop);
    assert.ok(pop.innerHTML.includes('ag-cs-ctx-warn-banner'));
    assert.ok(!pop.innerHTML.includes('ag-cs-ctx-cost'));

    assert.equal(pop.querySelector('button[data-ctx-act="export"]'), null);
    const copyBtn = pop.querySelector('button[data-ctx-act="copy"]');
    copyBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 30));
    assert.match(copiedText, /会话累计/);
    assert.doesNotMatch(copiedText, /参考 API|费用/);

    // 4. Scoped /compact fills activeEd ONLY and leaves otherEd untouched
    const compactBtn = topBar.querySelector('[data-hud-compact-btn="1"]');
    assert.ok(compactBtn);
    compactBtn.dispatch('click');
    assert.equal(activeEd.textContent, '/compact');
    assert.equal(otherEd.textContent, 'untouched other composer');

    // 5. 3-way loadSettings merge keeps local UI preference (hudCompact=true) when external config changes only palette
    const savedMap = JSON.parse(storage.getItem('agClaudeStyle.settings.v1') || '{}');
    savedMap.hudCompact = true;
    storage.setItem('agClaudeStyle.settings.v1', JSON.stringify(savedMap));
    sandbox.window.__agClaudeStyle.refreshConfig({
      ...cdp.DEFAULT_CONFIG,
      ringMode: 'context',
      hudBottomBar: true,
      hudTopBar: true,
      palette: 'claude',
    });
    const stAfter = sandbox.window.__agClaudeStyle.getState();
    assert.equal(stAfter.cfg.palette, 'claude');
    assert.equal(stAfter.cfg.hudCompact, true);

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('unmountRipple tolerates zero-size .agy-home (field=null) and copy honestly reflects failure and success', async () => {
  const timers = new Set();
  const matchesSel = (node, sel) => {
    if (!node || !sel) return false;
    return sel.split(',').some((p) => {
      const s = p.trim();
      if (!s) return false;
      const parts = s.split(/\s+/);
      const tail = parts[parts.length - 1];
      const matchOne = (el, tok) => {
        if (!el) return false;
        const br = /\[([^\]=]+)(?:="([^"]*)")?\]/.exec(tok);
        const tagPart = tok.split('.')[0].split('[')[0];
        if (tagPart && el.tagName !== tagPart.toUpperCase()) return false;
        const partsDot = tok.split('.');
        for (let i = 1; i < partsDot.length; i++) {
          const cls = partsDot[i].replace(/\[.*$/, '');
          if (cls && !el.classList.contains(cls)) return false;
        }
        if (br) {
          const ok = br[2] === undefined ? el.hasAttribute(br[1]) : el.getAttribute(br[1]) === br[2];
          if (!ok) return false;
        }
        return true;
      };
      if (!matchOne(node, tail)) return false;
      let cur = node.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !matchOne(cur, parts[i])) cur = cur.parentElement;
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    });
  };

  const makeEl = (tag, opts = {}) => {
    const children = [];
    const attrs = new Map();
    const listeners = new Map();
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: opts.id || '',
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      textContent: opts.text || '',
      _html: '',
      _href: '',
      clientWidth: opts.clientWidth ?? 0,
      clientHeight: opts.clientHeight ?? 0,
      parentElement: null,
      parentNode: null,
      children,
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); for (const x of String(v || '').split(/\s+/).filter(Boolean)) classes.add(x); },
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (x) => classes.has(x),
      },
      get isConnected() {
        let cur = el;
        while (cur.parentElement) cur = cur.parentElement;
        return cur.tagName === 'HTML';
      },
      set innerHTML(v) {
        this._html = String(v);
        children.length = 0;
        for (const m of this._html.matchAll(/data-ctx-act="([^"]+)"/g)) {
          this.appendChild(makeEl('button', { attrs: { 'data-ctx-act': m[1] } }));
        }
      },
      get innerHTML() { return this._html; },
      get href() { return this._href; },
      set href(v) { this._href = String(v); },
      appendChild(ch) { ch.parentElement = ch.parentNode = el; children.push(ch); return ch; },
      insertBefore(ch, ref) { ch.parentElement = ch.parentNode = el; const i = ref ? children.indexOf(ref) : -1; if (i >= 0) children.splice(i, 0, ch); else children.push(ch); return ch; },
      removeChild(ch) { const i = children.indexOf(ch); if (i >= 0) children.splice(i, 1); ch.parentElement = ch.parentNode = null; return ch; },
      remove() { if (el.parentElement) el.parentElement.removeChild(el); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') el.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, p = {}) { for (const fn of [...(listeners.get(ev) || [])]) fn({ type: ev, stopPropagation() {}, preventDefault() {}, ...p }); },
      getBoundingClientRect: () => ({ left: 10, top: 320, right: 430, bottom: 352, width: 420, height: 32 }),
      closest(sel) { let c = el; while (c) { if (matchesSel(c, sel)) return c; c = c.parentElement; } return null; },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const res = [];
        const walk = (n) => {
          for (const ch of n.children || []) {
            if (matchesSel(ch, sel)) res.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return res;
      },
    };
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
    return el;
  };

  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  // Hidden/collapsed zero-size home (.agy-home clientWidth=0, clientHeight=0) -> field remains null
  const home = makeEl('div', { className: 'agy-home', clientWidth: 0, clientHeight: 0 });
  body.appendChild(home);

  const cascadeId = 'mixed-cost-convo-1';
  const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const box = makeEl('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeEl('div', { className: 'surface-composer-card' });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  card.appendChild(footer);
  box.appendChild(card);
  convView.appendChild(box);
  body.appendChild(convView);

  let clipMode = 'reject';
  const mixedTraj = {
    trajectory: {
      steps: [
        { status: 3, metadata: { createdAt: '2026-11-17T12:00:00Z' }, step: { case: 'userInput', value: { query: 'Test mixed pricing' } } },
        { status: 3, metadata: { createdAt: '2026-11-17T12:00:05Z' }, step: { case: 'plannerResponse', value: { response: 'One' } } },
        { status: 3, metadata: { createdAt: '2026-11-17T12:00:10Z' }, step: { case: 'plannerResponse', value: { response: 'Two' } } },
      ],
      generatorMetadata: [
        {
          stepIndices: [1],
          metadata: { value: { modelDisplayName: 'Claude Sonnet 4.5', usage: { inputTokens: '10000', outputTokens: '2000', model: 1001 } } },
        },
        {
          stepIndices: [2],
          metadata: { value: { modelDisplayName: 'claude-opus-99.9', usage: { inputTokens: '20000', outputTokens: '3000', model: 1999 } } },
        },
      ],
    },
  };
  const fakeSvc = { async getCascadeTrajectory() { return mixedTraj; } };
  box.__reactFiber$test = {
    memoizedProps: { cascadeId, getCascadeTrajectory: fakeSvc.getCascadeTrajectory },
    dependencies: { firstContext: { memoizedValue: fakeSvc, next: null } },
    return: null,
  };

  const storage = { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } };
  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: {
      language: 'zh-CN',
      clipboard: {
        writeText: () => (clipMode === 'reject' ? Promise.reject(new Error('Clipboard denied')) : Promise.resolve()),
      },
    },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: storage,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { const id = setTimeout(() => fn(Date.now()), 5); timers.add(id); return id; },
    cancelAnimationFrame: (id) => { timers.delete(id); clearTimeout(id); },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.runInNewContext(
      cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, homeLayout: 'studio', homeRipple: true, ringMode: 'context' }),
      sandbox
    );
    await new Promise((r) => setTimeout(r, 80));

    // 1. Zero-size ripple mounted with field=null -> turning off homeRipple MUST NOT throw TypeError in unmountRipple()
    assert.ok(home.querySelector('.ag-cs-ripple-host'), 'Expected zero-size ripple host attached');
    assert.doesNotThrow(() => {
      sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, homeLayout: 'studio', homeRipple: false, ringMode: 'context' });
    });
    assert.equal(home.querySelector('.ag-cs-ripple-host'), null);

    // Re-enable zero-size ripple, then REMOVE_EXPRESSION (destroy -> unmountRipple) must also not throw
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, homeLayout: 'studio', homeRipple: true, ringMode: 'context' });
    assert.ok(home.querySelector('.ag-cs-ripple-host'));

    // 2. Statistics remain available without pricing UI.
    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    ringBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    const pop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(pop);
    assert.doesNotMatch(pop.innerHTML, /部分参考|Ref\. API|ag-cs-ctx-cost/);
    assert.doesNotMatch(pop.innerHTML, /~\$/);

    // Copy failure/success feedback remains, while the export action is absent.
    assert.equal(pop.querySelector('button[data-ctx-act="export"]'), null);
    const copyBtn = pop.querySelector('button[data-ctx-act="copy"]');
    assert.ok(copyBtn);
    copyBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(copyBtn.textContent, '✕ 失败');
    assert.equal(copyBtn.getAttribute('data-action-state'), 'error');
    clipMode = 'resolve';
    copyBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(copyBtn.textContent, '✓ 已复制');
    assert.equal(copyBtn.getAttribute('data-action-state'), 'ok');

    assert.doesNotThrow(() => {
      vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    });
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('inject expression enters sidecar-lite mode on plugin://swarm-- iframe without CSS, syncs language via refreshConfig, and tears down cleanly', () => {
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;
  const FILTER_SKIP = 3;
  const SHOW_ELEMENT = 1;
  const SHOW_TEXT = 4;

  function makeText(text) {
    return {
      nodeType: 3,
      nodeValue: String(text),
      parentElement: null,
      parentNode: null,
      isConnected: true,
      childNodes: [],
      children: [],
    };
  }

  function matchesSimple(node, simple) {
    let rest = simple.trim();
    if (!rest) return false;
    const tagM = /^[a-zA-Z0-9_-]+/.exec(rest);
    if (tagM) {
      if (node.tagName !== tagM[0].toUpperCase()) return false;
      rest = rest.slice(tagM[0].length);
    }
    while (rest) {
      if (rest[0] === '#') {
        const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || node.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '.') {
        const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || !node.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '[') {
        const m = /^\[([^\]=*^$]+)(?:="([^"]*)")?\]/.exec(rest);
        if (!m) return false;
        const ok = m[2] === undefined ? node.hasAttribute(m[1]) : node.getAttribute(m[1]) === m[2];
        if (!ok) return false;
        rest = rest.slice(m[0].length);
      } else {
        return false;
      }
    }
    return true;
  }

  function matchesSelector(node, sel) {
    if (!node || node.nodeType !== 1) return false;
    return sel.split(',').some((part) => {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length || !matchesSimple(node, tokens[tokens.length - 1])) return false;
      let cur = node.parentElement;
      let idx = tokens.length - 2;
      while (cur && idx >= 0) {
        if (matchesSimple(cur, tokens[idx])) idx--;
        cur = cur.parentElement;
      }
      return idx < 0;
    });
  }

  function makeEl(tag, opts = {}) {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const childNodes = [];
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || attrs.get('id') || '',
      parentElement: null,
      parentNode: null,
      isConnected: true,
      childNodes,
      get children() {
        return childNodes.filter((c) => c.nodeType === 1);
      },
      get lastElementChild() {
        const ch = this.children;
        return ch[ch.length - 1] || null;
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
      appendChild(n) {
        const item = typeof n === 'string' ? makeText(n) : n;
        item.parentElement = this;
        item.parentNode = this;
        childNodes.push(item);
        return item;
      },
      append(...nodes) {
        for (const n of nodes) this.appendChild(n);
        return this;
      },
      remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.childNodes.indexOf(this);
        if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
        this.parentNode = null;
        this.parentElement = null;
        this.isConnected = false;
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      matches(sel) {
        return matchesSelector(this, sel);
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      contains(other) {
        let cur = other;
        while (cur) {
          if (cur === this) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.childNodes) {
            if (c.nodeType === 1) {
              if (matchesSelector(c, sel)) out.push(c);
              walk(c);
            }
          }
        };
        walk(this);
        return out;
      },
      get textContent() {
        return childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
      },
      set textContent(v) {
        childNodes.length = 0;
        this.appendChild(makeText(v));
      },
    };
    if (opts.text) el.appendChild(makeText(opts.text));
    return el;
  }

  class MockMutationObserver {
    observe() {}
    disconnect() {}
  }

  const html = makeEl('html', { attrs: { lang: 'en' } });
  const head = makeEl('head');
  const body = makeEl('body');
  html.append(head, body);

  const tabBoard = makeEl('button', { text: 'Board' });
  const select = makeEl('select', { id: 'f-agent' });
  const optAll = makeEl('option', { text: 'From anyone' });
  const optCoord = makeEl('option', { text: 'From coordinator' });
  select.append(optAll, optCoord);
  const msgBody = makeEl('div', { className: 'msg-body' });
  const postText = makeEl('p', { text: 'Board' });
  msgBody.append(postText);
  body.append(tabBoard, select, msgBody);

  const doc = {
    nodeType: 9,
    documentElement: html,
    head,
    body,
    get childNodes() {
      return [html];
    },
    defaultView: { MutationObserver: MockMutationObserver },
    getElementById(id) {
      return html.querySelectorAll(`#${id}`)[0] || null;
    },
    createElement(tag) {
      return makeEl(tag);
    },
    querySelectorAll(sel) {
      return html.querySelectorAll(sel);
    },
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker(root, whatToShow, filter) {
      const list = [];
      const accept = (n) => {
        if (n.nodeType === 1 && !(whatToShow & SHOW_ELEMENT)) return FILTER_SKIP;
        if (n.nodeType === 3 && !(whatToShow & SHOW_TEXT)) return FILTER_SKIP;
        if (filter && typeof filter.acceptNode === 'function') return filter.acceptNode(n);
        return FILTER_ACCEPT;
      };
      const traverse = (node) => {
        for (const ch of node.childNodes) {
          const res = accept(ch);
          if (res === FILTER_REJECT) continue;
          if (res === FILTER_ACCEPT) list.push(ch);
          if (ch.nodeType === 1) traverse(ch);
        }
      };
      traverse(root);
      let idx = -1;
      return {
        currentNode: null,
        nextNode() {
          idx += 1;
          if (idx >= list.length) return false;
          this.currentNode = list[idx];
          return true;
        },
      };
    },
  };

  const sandbox = {
    console,
    document: doc,
    location: { protocol: 'plugin:', href: 'plugin://swarm--swarm_board-42226/?token=test' },
    NodeFilter: { SHOW_ELEMENT, SHOW_TEXT, FILTER_ACCEPT, FILTER_REJECT },
    MutationObserver: MockMutationObserver,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const codeHash = cdp.computeHash(cdp.readRuntimeBundle());
  const injectRes = vm.runInNewContext(
    cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, language: 'zh-CN' }),
    sandbox
  );

  assert.equal(injectRes.status, 'ok');
  assert.equal(doc.getElementById(cdp.STYLE_ID), null, 'sidecar must not inject main style.css');
  assert.equal(sandbox.window.__agClaudeStyle.sidecar, true);
  assert.equal(sandbox.window.__agClaudeStyle.getState().language, 'zh-CN');
  assert.equal(tabBoard.textContent, '看板');
  assert.equal(optAll.textContent, '来自所有人');
  assert.equal(optCoord.textContent, '来自 coordinator');
  assert.equal(postText.textContent, 'Board');

  // Lightweight config sync switches language live in Swarm sidecar
  const refreshRes = vm.runInNewContext(
    cdp.buildConfigScriptExpression({ ...cdp.DEFAULT_CONFIG, language: 'ja' }, codeHash),
    sandbox
  );
  assert.equal(refreshRes.status, 'refreshed');
  assert.equal(tabBoard.textContent, 'ボード');
  assert.equal(optAll.textContent, 'すべての投稿者');
  assert.equal(optCoord.textContent, '送信者: coordinator');

  // Remove expression restores DOM text and cleans globals
  vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
  assert.equal(tabBoard.textContent, 'Board');
  assert.equal(optAll.textContent, 'From anyone');
  assert.equal(optCoord.textContent, 'From coordinator');
  assert.equal(html.getAttribute('lang'), 'en');
  assert.equal(sandbox.window.__agClaudeStyle, undefined);
  assert.equal(sandbox.globalThis.__agCsSidecarCore, undefined);
});

test('focus mode, sprint pill, dual ring, cost guard bar, and Clawd meteor wish mount and clean up cleanly', () => {
  function makeNode(tag, opts = {}) {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const node = {
      tagName: tag.toUpperCase(),
      id: opts.id || '',
      style: {
        _props: {},
        setProperty(k, v) { this._props[k] = String(v); },
        getPropertyValue(k) { return this._props[k] || ''; },
        removeProperty(k) { delete this._props[k]; },
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(h) { children.length = 0; this._html = h; },
      get innerHTML() { return this._html || ''; },
      get firstChild() { return children[0] || null; },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(ch) { ch.parentElement = this; ch.parentNode = this; children.push(ch); return ch; },
      insertBefore(ch, ref) {
        ch.parentElement = this;
        ch.parentNode = this;
        const i = ref ? children.indexOf(ref) : -1;
        if (i >= 0) children.splice(i, 0, ch);
        else children.push(ch);
        return ch;
      },
      removeChild(ch) {
        const i = children.indexOf(ch);
        if (i >= 0) children.splice(i, 1);
        ch.parentElement = null;
        ch.parentNode = null;
        return ch;
      },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') this.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener() {},
      getBoundingClientRect() { return { left: 0, top: 0, right: 440, bottom: 180, width: 440, height: 180 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) {
        let cur = this;
        while (cur) { if (matchSel(cur, sel)) return cur; cur = cur.parentElement; }
        return null;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
    };
    return node;
  }
  function matchOne(n, s) {
    let rest = s.trim();
    if (!rest) return false;
    const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
    if (tm) { if (n.tagName !== tm[0].toUpperCase()) return false; rest = rest.slice(tm[0].length); }
    while (rest) {
      if (rest[0] === '.') {
        const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || !n.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '#') {
        const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || n.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '[') {
        const m = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/.exec(rest);
        if (!m) return false;
        if (m[2] !== undefined ? n.getAttribute(m[1]) !== m[2] : !n.hasAttribute(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else return false;
    }
    return true;
  }
  function matchSel(n, sel) {
    return sel.split(',').some((part) => {
      const segs = part.trim().split(/\s+/);
      let cur = n;
      for (let i = segs.length - 1; i >= 0; i--) {
        if (!cur) return false;
        if (i === segs.length - 1) { if (!matchOne(cur, segs[i])) return false; cur = cur.parentElement; }
        else { while (cur && !matchOne(cur, segs[i])) cur = cur.parentElement; if (!cur) return false; cur = cur.parentElement; }
      }
      return true;
    });
  }

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'dark' });
  html.appendChild(head);
  html.appendChild(body);

  const convo = makeNode('div', { attrs: { 'data-testid': 'conversation-view' } });
  const inputBox = makeNode('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const editor = makeNode('div', { attrs: { contenteditable: 'true' }, text: 'A'.repeat(18000) });
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  card.appendChild(editor);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convo.appendChild(inputBox);
  body.appendChild(convo);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    createElement: (t) => makeNode(t),
    getElementById: (id) => html.querySelector('#' + id),
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };
  const timers = new Set();
  const intervals = new Set();
  const store = new Map();
  const sandbox = {
    document: doc,
    location: { href: 'app://antigravity/chat', pathname: '/chat', protocol: 'app:' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval: (id) => { intervals.delete(id); clearInterval(id); },
    matchMedia: () => ({ matches: false }),
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression(cdp.DEFAULT_CONFIG), sandbox);
    assert.equal(res.status, 'ok');

    const ring = footer.querySelector('.ag-cs-context-ring');
    assert.ok(ring, 'Dual ring button mounted');
    assert.equal(ring.getAttribute('data-ring-mode'), 'dual');
    assert.ok(ring.innerHTML.includes('ag-cs-ring-fill-quota'), 'Dual concentric inner quota circle rendered');

    const sprintPill = footer.querySelector('.ag-cs-sprint-pill');
    assert.ok(sprintPill, 'Sprint timer pill mounted');

    const guardBar = card.querySelector('.ag-cs-cost-guard-bar');
    assert.ok(guardBar, 'Large draft >= 4k tok triggers cost guard warning bar');

    assert.equal(sandbox.window.__agClaudeStyle.launchMeteorRide('cruise'), true);
    assert.equal(sandbox.window.__agClaudeStyle.getState().hasMeteor, true);
    assert.equal(sandbox.window.__agClaudeStyle.triggerMeteorWish(), true);
    assert.ok(card.querySelector('.ag-cs-wish-toast'), 'Mid-flight wish spawns floating starlight toast');

    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, focusMode: true });
    assert.equal(html.getAttribute('data-ag-cs-focus'), '1');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(html.hasAttribute('data-ag-cs-focus'), false);
    assert.equal(card.querySelector('.ag-cs-meteor-stage'), null);
    assert.equal(card.querySelector('.ag-cs-cost-guard-bar'), null);
    assert.equal(footer.querySelector('.ag-cs-sprint-pill'), null);
    assert.equal(sandbox.globalThis.__agCsFocusCore, undefined);
  } finally {
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});
