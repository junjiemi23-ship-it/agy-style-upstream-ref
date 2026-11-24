import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const usageCore = require('../usage-core.js');

test('formatCompactTokens matches expected units and rounding', () => {
  assert.equal(usageCore.formatCompactTokens(0), '0');
  assert.equal(usageCore.formatCompactTokens(949), '949');
  assert.equal(usageCore.formatCompactTokens(1540), '1.5k');
  assert.equal(usageCore.formatCompactTokens(999990), '1M');
  assert.equal(usageCore.formatCompactTokens(647800000), '647.8M');
  assert.equal(usageCore.formatCompactTokens(2500000000), '2.5B');
});

test('formatHomeHour formats AM/PM in zh and en', () => {
  assert.equal(usageCore.formatHomeHour(0, true), '上午 12 点');
  assert.equal(usageCore.formatHomeHour(12, true), '下午 12 点');
  assert.equal(usageCore.formatHomeHour(15, true), '下午 3 点');
  assert.equal(usageCore.formatHomeHour(0, false), '12 AM');
  assert.equal(usageCore.formatHomeHour(14, false), '2 PM');
});

test('analyzeTrajectoryForUsage extracts calls, days, hours, models, and retryInfos fallback', () => {
  const t0 = Math.floor(new Date(2026, 10, 10, 14, 15, 0).getTime() / 1000);
  const t1 = Math.floor(new Date(2026, 10, 11, 9, 30, 0).getTime() / 1000);
  const traj = {
    trajectory: {
      steps: [
        { metadata: { createdAt: { seconds: String(t0), nanos: 0 } } },
        { metadata: { createdAt: { seconds: String(t1), nanos: 0 } } },
      ],
      generatorMetadata: [
        {
          stepIndices: [0],
          metadata: {
            value: {
              modelDisplayName: 'Gemini 4 Argon (High)',
              usage: { inputTokens: '1000', cacheReadTokens: '4000', outputTokens: '500' },
            },
          },
        },
        {
          stepIndices: [1],
          metadata: {
            value: {
              responseModel: 'claude-opus-5.5',
              retryInfos: [
                { usage: { inputTokens: '100', outputTokens: '10' } },
                { usage: { inputTokens: '2000', cacheReadTokens: '8000', cacheWriteTokens: '500', outputTokens: '1000' } },
              ],
            },
          },
        },
      ],
    },
  };
  const rec = usageCore.analyzeTrajectoryForUsage(traj, { stepCount: 2, lastModifiedTime: { seconds: String(t1) } }, 'c1');
  assert.equal(rec.cascadeId, 'c1');
  assert.equal(rec.subagent, false);
  assert.equal(rec.calls, 2);
  assert.equal(rec.days['2026-11-10'].total, 5500);
  assert.equal(rec.days['2026-11-10'].hours[14], 1);
  assert.equal(rec.days['2026-11-11'].total, 11500);
  assert.equal(rec.days['2026-11-11'].hours[9], 1);
  assert.equal(rec.days['2026-11-11'].models['claude-opus-5.5'].total, 11500);
});

test('aggregateUsageRollup excludes subagents from sessions, filters ranges, and picks book yardstick', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0);
  const dToday = usageCore.homeDayKey(now);
  const d10 = usageCore.homeDayKey(new Date(2026, 10, 4, 12, 0, 0));
  const d45 = usageCore.homeDayKey(new Date(2026, 8, 25, 12, 0, 0));

  const records = [
    {
      cascadeId: 'main-1',
      subagent: false,
      days: {
        [dToday]: {
          calls: 3,
          input: 10000,
          output: 2000,
          cacheRead: 30000,
          cacheWrite: 0,
          total: 42000,
          hours: (() => { const a = new Array(24).fill(0); a[15] = 3; return a; })(),
          models: { 'Gemini 4 Argon': { input: 10000, output: 2000, cacheRead: 30000, cacheWrite: 0, total: 42000, calls: 3 } },
        },
        [d45]: {
          calls: 1,
          input: 5000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
          total: 6000,
          hours: (() => { const a = new Array(24).fill(0); a[8] = 1; return a; })(),
          models: { 'Claude Opus': { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, total: 6000, calls: 1 } },
        },
      },
    },
    {
      cascadeId: 'sub-1',
      subagent: true,
      days: {
        [d10]: {
          calls: 2,
          input: 8000,
          output: 2000,
          cacheRead: 0,
          cacheWrite: 0,
          total: 10000,
          hours: (() => { const a = new Array(24).fill(0); a[15] = 2; return a; })(),
          models: { 'Gemini 4 Argon': { input: 8000, output: 2000, cacheRead: 0, cacheWrite: 0, total: 10000, calls: 2 } },
        },
      },
    },
  ];

  const all = usageCore.aggregateUsageRollup(records, 'all', 0.0, true, now);
  assert.equal(all.sessions, 1); // sub-1 excluded!
  assert.equal(all.calls, 6);
  assert.equal(all.tokens, 58000);
  assert.equal(all.activeDays, 3);
  assert.equal(all.peakHour, '下午 3 点');
  assert.equal(all.model, 'Gemini 4 Argon');
  assert.match(all.funBook, /《道德经》/);

  const seven = usageCore.aggregateUsageRollup(records, '7d', 0.0, true, now);
  assert.equal(seven.sessions, 1);
  assert.equal(seven.calls, 3);
  assert.equal(seven.tokens, 42000);
  assert.equal(seven.activeDays, 1);

  const thirty = usageCore.aggregateUsageRollup(records, '30d', 0.0, false, now);
  assert.equal(thirty.tokens, 52000);
  assert.equal(thirty.activeDays, 2);
});

test('homeHeatGrid produces Sunday-aligned 26+ week cells with levels 0..5', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0); // Saturday
  const dToday = usageCore.homeDayKey(now);
  const dPrev = usageCore.homeDayKey(new Date(2026, 10, 13, 12, 0, 0));
  const grid = usageCore.homeHeatGrid({ [dToday]: 10000, [dPrev]: 1500 }, now);
  assert.ok(grid.cells.length >= 26 * 7);
  assert.equal(grid.cells[0].date.length, 10);
  const last = grid.cells[grid.cells.length - 1];
  assert.equal(last.date, dToday);
  assert.equal(last.level, 5);
  const prevCell = grid.cells.find((c) => c.date === dPrev);
  assert.equal(prevCell.level, 1);
});

test('homeChartTicks never produce overlapping labels', () => {
  const widths = new Array(30).fill(42);
  const ticks = usageCore.homeChartTicks(widths, 420, 8, 2);
  assert.ok(ticks.length >= 1);
  assert.equal(ticks[ticks.length - 1].index, 29);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i - 1].left + widths[ticks[i - 1].index] + 8 <= ticks[i].left);
  }
});

test('analyzeActiveConversation handles empty and populated trajectories', () => {
  const empty = usageCore.analyzeActiveConversation(null);
  assert.equal(empty.calls, 0);
  assert.equal(empty.contextUsed, 0);
  assert.equal(empty.isRunning, false);

  const traj = {
    steps: [
      { status: 3, step: { case: 'userInput' } },
      { status: 1, step: { case: 'plannerResponse', value: {} } },
    ],
    generatorMetadata: [
      {
        metadata: {
          value: {
            usage: { inputTokens: '2000', cacheReadTokens: '18000', outputTokens: '500', thinkingOutputTokens: '100' },
            streamingDuration: { seconds: '1', nanos: 0 },
            timeToFirstToken: { seconds: '0', nanos: 500000000 },
            chatStartMetadata: {
              contextWindowMetadata: {
                estimatedTokensUsed: 50000,
                maxContextTokens: 256000,
                tokenBreakdown: {
                  groups: [
                    { type: 1, name: 'System', numTokens: 10000 },
                    { type: 2, name: 'Tools', numTokens: 5000 },
                    { type: 7, name: 'Chat', numTokens: 35000 },
                  ],
                },
              },
            },
          },
        },
      },
    ],
  };
  const info = usageCore.analyzeActiveConversation(traj);
  assert.equal(info.calls, 1);
  assert.equal(info.steps, 2);
  assert.equal(info.contextUsed, 50000);
  assert.equal(info.sysTokens, 10000);
  assert.equal(info.toolsTokens, 5000);
  assert.equal(info.msgTokens, 35000);
  assert.equal(info.cacheHitPct, 90);
  assert.equal(info.lastSpeed, 500);
  assert.equal(info.isRunning, true);
  assert.equal(info.isThinking, true);
});

test('computeRingTelemetry calculates remaining percentage, color thresholds, draft deduction, and quota mode', () => {
  // 1. > 30% remaining -> ok (#257de0)
  const okRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 51500, maxContextTokens: 256000 },
    draftTokens: 0,
    ringMode: 'context',
  });
  assert.equal(okRing.mode, 'context');
  assert.equal(okRing.remainingTokens, 204500);
  assert.equal(okRing.pctRound, 80);
  assert.equal(okRing.level, 'ok');
  assert.equal(okRing.color, '#257de0');

  // 2. <= 30% remaining -> warn (#fbb315)
  const warnRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 185000, maxContextTokens: 256000 },
    draftTokens: 5000,
    ringMode: 'context',
  });
  assert.equal(warnRing.usedTokens, 190000);
  assert.equal(warnRing.remainingTokens, 66000);
  assert.equal(warnRing.pctRound, 26);
  assert.equal(warnRing.level, 'warn');
  assert.equal(warnRing.color, '#fbb315');

  // 3. <= 10% remaining -> danger (#dc3c3d)
  const dangerRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 240000, maxContextTokens: 256000 },
    draftTokens: 0,
    ringMode: 'context',
  });
  assert.equal(dangerRing.pctRound, 6);
  assert.equal(dangerRing.level, 'danger');
  assert.equal(dangerRing.color, '#dc3c3d');

  // 4. Quota mode with valid quotaInfo vs fallback when quotaInfo is null
  const quotaRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 50000, maxContextTokens: 256000 },
    quotaInfo: { effectiveRemainingPct: 71.3 },
    ringMode: 'quota',
  });
  assert.equal(quotaRing.mode, 'quota');
  assert.equal(quotaRing.pctRound, 71);
  assert.equal(quotaRing.color, '#257de0');

  const fallbackRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 128000, maxContextTokens: 256000 },
    quotaInfo: null,
    ringMode: 'quota',
  });
  assert.equal(fallbackRing.mode, 'context');
  assert.equal(fallbackRing.pctRound, 50);
});

test('estimateTextTokens, normalizeQuotaData, and getActiveQuotaInfo handle CJK, code, and model pools', () => {
  assert.equal(usageCore.estimateTextTokens('').tokens, 0);
  const est = usageCore.estimateTextTokens('把右下角的圆环改成显示用量剩余 const x = 42;');
  assert.ok(est.tokens > 5);
  assert.ok(est.cjk >= 10);

  const qData = usageCore.normalizeQuotaData(
    null,
    {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 4 Argon (High)',
              quotaInfo: { remainingFraction: 0.75, resetTime: { seconds: String(Math.floor(Date.now() / 1000) + 3600) } },
            },
            {
              label: 'Claude Opus 5.5 (High)',
              quotaInfo: { remainingFraction: 0.2, resetTime: { seconds: String(Math.floor(Date.now() / 1000) + 7200) } },
            },
          ],
        },
      },
    }
  );
  assert.ok(qData.groups.length >= 2);
  const activeArgon = usageCore.getActiveQuotaInfo(qData, 'Gemini 4 Argon (High)');
  assert.ok(activeArgon);
  assert.equal(Math.round(activeArgon.effectiveRemainingPct), 75);
});

test('analyzeActiveConversation splits chatMsgTokens and toolResultsTokens without double-counting and attaches subagent telemetry', () => {
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: { seconds: '1700000000' } }, step: { case: 'userInput', value: { query: 'Inspect files' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700000005' }, toolCall: { name: 'read_file' } }, step: { case: 'generic', value: {} } },
      { status: 3, metadata: { createdAt: { seconds: '1700000010' } }, step: { case: 'plannerResponse', value: { response: 'Done' } } },
    ],
    generatorMetadata: [
      {
        stepIndices: [0, 1, 2],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 4 Argon (High)',
            usage: { inputTokens: '4000', cacheReadTokens: '124000', outputTokens: '500', thinkingOutputTokens: '100' },
            chatStartMetadata: {
              contextWindowMetadata: {
                estimatedTokensUsed: 131200,
                maxContextTokens: 256000,
                tokenBreakdown: {
                  groups: [
                    { type: 1, name: 'System', numTokens: 11900, children: [{ name: 'SYSTEM_PROMPT', numTokens: 11900 }] },
                    { type: 2, name: 'Tools', numTokens: 8200, children: [{ name: 'read_file', numTokens: 8200 }] },
                    {
                      type: 7,
                      name: 'Messages',
                      numTokens: 111100,
                      children: [
                        { name: '0: USER_INPUT', numTokens: 12000 },
                        { name: '1: GENERIC', numTokens: 89200 },
                        { name: '2: PLANNER_RESPONSE', numTokens: 9900 },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, {
    cascadeId: 'parent-1',
    subagents: [
      {
        id: 'sub-abc12345',
        parentId: 'parent-1',
        rootId: 'parent-1',
        status: 1,
        createdAtSec: 1700000006,
        analysis: {
          totalCalls: 4,
          totalSteps: 12,
          totalTokens: 45000,
          totalOutput: 2100,
          contextUsed: 18000,
          lastModel: 'Gemini 4 Argon (High)',
          toolBreakdown: [{ name: 'run_command', count: 3, tokens: 4000 }],
        },
      },
    ],
  });

  // Verify no double counting: sys + tools + chatMsgTokens + toolResultsTokens === contextUsed
  assert.equal(info.sysTokens, 11900);
  assert.equal(info.toolsTokens, 8200);
  assert.equal(info.msgTokens, 111100);
  assert.equal(info.toolResultsTokens, 89200);
  assert.equal(info.chatMsgTokens, 21900);
  assert.equal(info.sysTokens + info.toolsTokens + info.chatMsgTokens + info.toolResultsTokens, 131200);

  // Verify subagent aggregation and per-turn attribution
  assert.equal(info.subagentCount, 1);
  assert.equal(info.subagentCalls, 4);
  assert.equal(info.subagentTokens, 45000);
  assert.equal(info.turnDetails.length, 1);
  assert.equal(info.turnDetails[0].toolCalls, 1);
  assert.equal(info.turnDetails[0].subagentCount, 1);
  assert.equal(info.turnDetails[0].subagentCalls, 4);
  assert.equal(info.turnDetails[0].subagentTokens, 45000);
});

test('analyzeActiveConversation exposes liveTokens and liveSpeed during Turn 1 before generatorMetadata completes', () => {
  const traj = {
    steps: [
      { status: 3, step: { case: 'userInput', value: { query: 'Hello' } } },
      {
        status: 1,
        metadata: { viewableAt: { seconds: '1000', nanos: 0 }, modelUsage: { outputTokens: '42' } },
        step: { case: 'plannerResponse', value: { thinking: 'Analyzing the workspace files carefully...', response: '' } },
      },
    ],
    generatorMetadata: [],
  };
  const info = usageCore.analyzeActiveConversation(traj, { cascadeId: 'new-c1', nowSec: 1002 });
  assert.equal(info.calls, 0);
  assert.equal(info.steps, 2);
  assert.equal(info.totalTokens, 0);
  assert.equal(info.isRunning, true);
  assert.equal(info.isThinking, true);
  assert.equal(info.liveTokens, 42);
  assert.equal(info.liveSpeed, 21);
  assert.equal(info.displaySpeed, 21);
});

test('getActiveQuotaInfo prioritizes Argon and Claude/GPT before matching specific or default Gemini groups', () => {
  const quota = {
    groups: [
      { name: 'Gemini', buckets: [{ window: '5h', disabled: false, remainingPct: 60 }] },
      { name: 'Gemini 4 Argon', buckets: [{ window: '5h', disabled: false, remainingPct: 25 }] },
      { name: 'Gemini 3.8 Flash', buckets: [{ window: '5h', disabled: false, remainingPct: 90 }] },
      { name: 'Claude / GPT', buckets: [{ window: 'weekly', disabled: false, remainingPct: 40 }] },
    ],
    modelConfigs: [],
  };
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Gemini 4 Argon (High)')?.groupName, 'Gemini 4 Argon');
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Gemini 3.8 Flash (Low)')?.groupName, 'Gemini 3.8 Flash');
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Gemini 4 Hydrogen Extra')?.groupName, 'Gemini');
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Claude Opus 5.5')?.groupName, 'Claude / GPT');
});

test('analyzeActiveConversation tracks growing usage when chatStartMetadata repeats stale Turn 1 values or omits contextWindowMetadata', () => {
  const staleStartCw = {
    estimatedTokensUsed: 30000,
    maxContextTokens: 734000,
    tokenBreakdown: {
      groups: [
        { type: 1, name: 'System', numTokens: 12000 },
        { type: 2, name: 'Tools', numTokens: 8000 },
        {
          type: 7,
          name: 'Messages',
          numTokens: 10000,
          children: [
            { name: '0: USER_INPUT', numTokens: 4000 },
            { name: '1: PLANNER_RESPONSE', numTokens: 6000 },
          ],
        },
      ],
    },
  };
  const traj = {
    steps: [
      { status: 3, step: { case: 'userInput', value: { query: 'Turn 1' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'Reply 1' } } },
      { status: 3, step: { case: 'userInput', value: { query: 'Inspect large codebase' } } },
      { status: 3, metadata: { toolCall: { name: 'read_file' } }, step: { case: 'viewFile', value: { absolutePathUri: 'file:///repo/big.js', content: 'x'.repeat(4000) } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'Done inspecting.' } } },
    ],
    generatorMetadata: [
      {
        stepIndices: [0, 1],
        metadata: {
          value: {
            modelDisplayName: 'Orchestrator (Carbon)',
            usage: { inputTokens: '10000', cacheReadTokens: '18000', outputTokens: '2000' },
            chatStartMetadata: { contextWindowMetadata: staleStartCw },
          },
        },
      },
      {
        stepIndices: [2, 3, 4],
        metadata: {
          value: {
            modelDisplayName: 'Orchestrator (Carbon)',
            usage: { inputTokens: '25000', cacheReadTokens: '380000', outputTokens: '2000', thinkingOutputTokens: '0' },
            // Stale Turn 1 chatStartMetadata repeated across handoff / tool loop
            chatStartMetadata: { contextWindowMetadata: staleStartCw },
          },
        },
      },
      {
        stepIndices: [4],
        metadata: {
          value: {
            modelDisplayName: 'Orchestrator (Carbon)',
            usage: { inputTokens: '25000', cacheReadTokens: '380000', outputTokens: '2000' },
            // Partial cwMeta with only maxContextTokens (must not zero out contextUsed)
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 734000 } },
          },
        },
      },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, { cascadeId: 'carbon-1' });
  assert.equal(info.maxContextTokens, 734000);
  assert.equal(info.contextUsed, 407000);
  assert.equal(info.hasActiveLimits, true);
  assert.equal(info.turnDetails[info.turnDetails.length - 1].ctxUsed, 407000);
  assert.equal(
    info.sysTokens + info.toolsTokens + info.chatMsgTokens + info.toolResultsTokens + info.overheadTokens,
    info.contextUsed
  );
  assert.ok(info.overheadTokens < 1000, `Expected post-breakdown reconciliation to avoid huge overhead, got ${info.overheadTokens}`);

  const ring = usageCore.computeRingTelemetry({ activeInfo: info, ringMode: 'context' });
  assert.equal(ring.pctRound, 45);
});

test('analyzeActiveConversation handles post-checkpoint compaction and ISO/string timestamps & durations', () => {
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: '2026-11-17T12:00:00Z' }, step: { case: 'userInput', value: { query: 'Before compact' } } },
      { status: 3, metadata: { createdAt: '2026-11-17T12:01:00Z' }, step: { case: 'plannerResponse', value: { response: 'Long output' } } },
      { status: 3, metadata: { createdAt: '2026-11-17T12:02:00Z' }, step: { case: 'checkpoint', value: {} } },
      { status: 3, metadata: { createdAt: '2026-11-17T12:03:00Z' }, step: { case: 'userInput', value: { query: 'After compact' } } },
      { status: 3, metadata: { createdAt: '2026-11-17T12:04:00Z' }, step: { case: 'plannerResponse', value: { response: 'Compact reply' } } },
    ],
    generatorMetadata: [
      {
        stepIndices: [0, 1],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 4 Argon (High)',
            usage: { inputTokens: '10000', cacheReadTokens: '190000', outputTokens: '5000' },
            streamingDuration: '2.5s',
            timeToFirstToken: '0.5s',
            chatStartMetadata: { checkpointIndex: -1, contextWindowMetadata: { maxContextTokens: 256000 } },
          },
        },
      },
      {
        stepIndices: [3, 4],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 4 Argon (High)',
            usage: { inputTokens: '4000', cacheReadTokens: '26000', outputTokens: '1000' },
            streamingDuration: '1.0s',
            timeToFirstToken: '0.25s',
            chatStartMetadata: { checkpointIndex: 2, contextWindowMetadata: { maxContextTokens: 256000 } },
          },
        },
      },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, { cascadeId: 'compact-1' });
  assert.equal(info.contextUsed, 31000);
  assert.equal(info.lastSpeed, 1000);
  assert.equal(info.lastTtft, 0.25);
  assert.equal(usageCore.durSec('1.5s'), 1.5);
  assert.equal(Math.floor(usageCore.tsSec('2026-11-17T12:00:00Z')), Math.floor(Date.parse('2026-11-17T12:00:00Z') / 1000));

  const rec = usageCore.analyzeTrajectoryForUsage(traj, { stepCount: 5, lastModifiedTime: '2026-11-17T12:04:00Z' }, 'compact-1');
  assert.equal(rec.lastModifiedSec, Math.floor(Date.parse('2026-11-17T12:04:00Z') / 1000));
  assert.equal(rec.calls, 2);
});

test('analyzeActiveConversation merges consecutive user inputs, handles alternate userInput shapes, and avoids counting tool calls as turns', () => {
  assert.equal(usageCore.isUserTurnBoundary({ step: { case: 'userInput' } }), true);
  assert.equal(usageCore.isUserTurnBoundary({ type: 'CORTEX_STEP_TYPE_USER_INPUT' }), true);
  assert.equal(usageCore.isUserTurnBoundary({ type: 'USER_INPUT' }), true);
  assert.equal(usageCore.isUserTurnBoundary({ userInput: { query: 'hi' } }), true);
  assert.equal(usageCore.isUserTurnBoundary({ step: { case: 'plannerResponse' } }), false);

  const cleaned = usageCore.extractUserPromptText({
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    userInput: {
      query: '<CONTEXT_SUMMARY>ignore</CONTEXT_SUMMARY><USER_REQUEST>\nFix turn badge alignment\n</USER_REQUEST><ADDITIONAL_METADATA>ts</ADDITIONAL_METADATA>',
    },
  });
  assert.equal(cleaned, 'Fix turn badge alignment');

  // Consecutive user inputs (cancelled + follow-up + duplicate) before first model response,
  // followed by multi-step tool loop including a call with missing stepIndices: []
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: { seconds: '1700001000' } }, type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { query: 'First question' } },
      { status: 3, metadata: { createdAt: { seconds: '1700001001' } }, step: { case: 'userInput', value: { query: 'First question' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700001002' } }, step: { case: 'userInput', value: { query: 'Extra detail' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700001005' } }, step: { case: 'plannerResponse', value: { response: 'Calling tool' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700001006' }, toolCall: { name: 'read_file' } }, step: { case: 'viewFile', value: {} } },
      { status: 3, metadata: { createdAt: { seconds: '1700001010' } }, step: { case: 'plannerResponse', value: { response: 'Turn 1 done' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700002000' } }, type: 'USER_INPUT', userInput: { text: 'Second question' } },
      { status: 3, metadata: { createdAt: { seconds: '1700002005' } }, step: { case: 'plannerResponse', value: { response: 'Turn 2 done' } } },
    ],
    generatorMetadata: [
      {
        stepIndices: [3],
        metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '5000', cacheReadTokens: '10000', outputTokens: '300' } } },
      },
      {
        // Missing stepIndices in the middle of Turn 1 must stay in Turn 1, NOT jump to Turn 2
        stepIndices: [],
        metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '6000', cacheReadTokens: '12000', outputTokens: '400' } } },
      },
      {
        stepIndices: [5],
        metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '7000', cacheReadTokens: '15000', outputTokens: '500' } } },
      },
      {
        stepIndices: [7],
        metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '8000', cacheReadTokens: '20000', outputTokens: '600' } } },
      },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, {
    cascadeId: 'turns-test-1',
    subagents: [
      {
        id: 'sub-turn1',
        createdAtMs: 1700001007000,
        calls: 2,
        totalTokens: 9000,
      },
    ],
  });

  assert.equal(info.turns, 2);
  assert.equal(info.turnDetails.length, 2);
  assert.equal(info.turnDetails[0].turn, 1);
  assert.equal(info.turnDetails[0].calls, 3);
  assert.equal(info.turnDetails[0].output, 1200);
  assert.equal(info.turnDetails[0].toolCalls, 1);
  assert.equal(info.turnDetails[0].userPreview, 'First question / Extra detail');
  assert.equal(info.turnDetails[0].subagentCount, 1);
  assert.equal(info.turnDetails[0].subagentTokens, 9000);
  assert.equal(info.subagents[0].rootTurnIndex, 1);

  assert.equal(info.turnDetails[1].turn, 2);
  assert.equal(info.turnDetails[1].calls, 1);
  assert.equal(info.turnDetails[1].output, 600);
  assert.equal(info.turnDetails[1].userPreview, 'Second question');
  assert.equal(info.turnDetails[1].subagentCount, 0);

  // When ALL generatorMetadata lack stepIndices, 1 user turn with 3 model calls still counts as 1 turn
  const noIndicesTraj = {
    steps: [
      { status: 3, step: { case: 'userInput', value: { query: 'Single turn tool loop' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'Step 1' } } },
      { status: 3, step: { case: 'viewFile', value: {} } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'Step 2' } } },
    ],
    generatorMetadata: [
      { metadata: { value: { usage: { inputTokens: '2000', outputTokens: '200' } } } },
      { metadata: { value: { usage: { inputTokens: '4000', outputTokens: '300' } } } },
      { metadata: { value: { usage: { inputTokens: '6000', outputTokens: '400' } } } },
    ],
  };
  const noIdxInfo = usageCore.analyzeActiveConversation(noIndicesTraj);
  assert.equal(noIdxInfo.turns, 1);
  assert.equal(noIdxInfo.turnDetails.length, 1);
  assert.equal(noIdxInfo.turnDetails[0].calls, 3);
  assert.equal(noIdxInfo.turnDetails[0].output, 900);
});

test('streaming new turn closes previous turn boundary and prevents tool/badge bleed, plus alternate userInput pending estimation', () => {
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: { seconds: '1700001000' } }, type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { query: 'Turn 1' } },
      { status: 3, metadata: { createdAt: { seconds: '1700001005' } }, step: { case: 'plannerResponse', value: { response: 'Done 1' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700002000' } }, type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { query: 'Turn 2 streaming prompt with detail' } },
      { status: 3, metadata: { createdAt: { seconds: '1700002001' }, toolCall: { name: 'read_file' } }, step: { case: 'viewFile', value: { content: 'abc' } } },
      { status: 2, metadata: { createdAt: { seconds: '1700002002' } }, step: { case: 'plannerResponse', value: { response: 'Streaming...' } } },
    ],
    generatorMetadata: [
      {
        stepIndices: [1],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 4 Neon',
            usage: { inputTokens: '4000', cacheReadTokens: '6000', outputTokens: '500' },
          },
        },
      },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, { cascadeId: 'streaming-boundary-1' });
  assert.equal(info.turns, 1);
  assert.equal(info.turnDetails.length, 1);
  assert.equal(info.turnDetails[0].userStepIdx, 0);
  assert.equal(info.turnDetails[0].nextUserStepIdx, 2, 'Turn 1 must be closed at Turn 2 user boundary');
  assert.equal(info.turnDetails[0].nextStartTimeSec, 1700002000);
  assert.equal(info.turnDetails[0].toolCalls, 0, 'Turn 2 tool call must not leak into Turn 1');
  assert.ok(info.contextUsed > 10500, 'Pending Turn 2 userInput/tool/streaming tokens should increment contextUsed');
});

test('analyzeTrajectoryForUsage avoids double-counting when generatorMetadata omits stepIndices and normalizes numeric epoch seconds', () => {
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: 1700001000 }, step: { case: 'userInput', value: { query: 'Q1' } } },
      {
        status: 3,
        metadata: {
          createdAt: 1700001005,
          modelUsage: { modelDisplayName: 'Gemini 4 Neon', inputTokens: '3000', outputTokens: '400' },
        },
        step: { case: 'plannerResponse', value: { response: 'A1' } },
      },
      { status: 3, metadata: { createdAt: 1700002000 }, step: { case: 'userInput', value: { query: 'Q2' } } },
      {
        status: 3,
        metadata: {
          createdAt: 1700002005,
          modelUsage: { modelDisplayName: 'Gemini 4 Neon', inputTokens: '5000', outputTokens: '600' },
        },
        step: { case: 'plannerResponse', value: { response: 'A2' } },
      },
    ],
    generatorMetadata: [
      {
        metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '3000', outputTokens: '400' } } },
      },
      {
        metadata: { value: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: '5000', outputTokens: '600' } } },
      },
    ],
  };

  const rec = usageCore.analyzeTrajectoryForUsage(traj, { stepCount: 4, lastModifiedTime: 1700002005 }, 'no-idx-usage');
  assert.equal(rec.calls, 2, 'Must not double-count step modelUsage when generatorMetadata lacks stepIndices');
  const dayKeys = Object.keys(rec.days);
  assert.equal(dayKeys.length, 1);
  assert.ok(/^2023-11-1[45]$/.test(dayKeys[0]), `Expected numeric epoch seconds to normalize to 2023-11-14/15, got ${dayKeys[0]}`);
  assert.equal(rec.days[dayKeys[0]].total, 9000);
});

test('timestamp-fallback turn bucketing does not let a 0-timestamp call swallow later user turns', () => {
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: { seconds: '1700001000' } }, step: { case: 'userInput', value: { query: 'First' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700001005' } }, step: { case: 'plannerResponse', value: { response: 'R1' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700002000' } }, step: { case: 'userInput', value: { query: 'Second' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700002005' } }, step: { case: 'plannerResponse', value: { response: 'R2' } } },
    ],
    generatorMetadata: [
      { metadata: { value: { usage: { inputTokens: '1000', outputTokens: '100' } } } },
      { metadata: { value: { createdAt: { seconds: '1700001005' }, usage: { inputTokens: '2000', outputTokens: '200' } } } },
      { metadata: { value: { createdAt: { seconds: '1700002005' }, usage: { inputTokens: '3000', outputTokens: '300' } } } },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, { cascadeId: 'zero-ts-fallback' });
  assert.equal(info.turns, 2);
  assert.equal(info.turnDetails[0].calls, 2);
  assert.equal(info.turnDetails[0].userPreview, 'First');
  assert.equal(info.turnDetails[1].calls, 1);
  assert.equal(info.turnDetails[1].userPreview, 'Second');
});

test('analyzeActiveConversation and analyzeTrajectoryForUsage parse remote/cloud AgentState step modelUsage, timings, prompts, and modelInfo limits', () => {
  const remoteAgentState = {
    conversationId: '9108d632-06be-4d5d-8338-3e81f464fbfd',
    status: 1,
    fullyIdle: true,
    turns: [
      { startStepIndex: 0, startTimeMs: 1795180381431 },
      { startStepIndex: 4, startTimeMs: 1795181503618 },
    ],
    trajectorySlice: {
      conversationId: '9108d632-06be-4d5d-8338-3e81f464fbfd',
      totalStepsLength: 6,
      stepsSlice: { startIndex: 0 },
      stepsInSlice: [
        {
          status: 3,
          metadata: {
            createdAt: { seconds: '1795180381', nanos: 0 },
            sourceTrajectoryStepInfo: { stepIndex: 0, cascadeId: 'v1/default/jetski_remote_agents_3p/9108d632-06be-4d5d-8338-3e81f464fbfd' },
          },
          step: {
            case: 'userInput',
            value: {
              query: '',
              userResponse: '看看 issue #4',
              items: [{ chunk: { case: 'text', value: '看看 issue #4' } }],
            },
          },
        },
        {
          status: 3,
          metadata: {
            createdAt: { seconds: '1795180385', nanos: 0 },
            viewableAt: { seconds: '1795180388', nanos: 0 },
            finishedGeneratingAt: { seconds: '1795180390', nanos: 0 },
            modelUsage: {
              inputTokens: '16834',
              cacheReadTokens: '0',
              cacheWriteTokens: '0',
              outputTokens: '200',
              thinkingOutputTokens: '120',
              responseOutputTokens: '80',
            },
            modelInfo: {
              displayName: 'Gemini 4 Neon (High)',
              modelName: 'gemini-4-neon-high',
              maxTokens: 1048576,
              maxOutputTokens: 262144,
            },
            sourceTrajectoryStepInfo: { stepIndex: 1 },
          },
          step: { case: 'plannerResponse', value: { response: '' } },
        },
        {
          status: 3,
          metadata: {
            createdAt: { seconds: '1795180390', nanos: 500000000 },
            toolSummary: 'Read inject.js',
            sourceTrajectoryStepInfo: { stepIndex: 2 },
          },
          step: {
            case: 'viewFile',
            value: { absolutePathUri: 'file:///home/antigravity/repo/inject.js', content: '', lineRangeBytes: 8372 },
          },
        },
        {
          status: 3,
          metadata: {
            createdAt: { seconds: '1795180392', nanos: 0 },
            viewableAt: { seconds: '1795180395', nanos: 0 },
            finishedGeneratingAt: { seconds: '1795180400', nanos: 0 },
            modelUsage: {
              inputTokens: '5000',
              cacheReadTokens: '16834',
              cacheWriteTokens: '0',
              outputTokens: '1000',
              thinkingOutputTokens: '400',
              responseOutputTokens: '600',
            },
            modelInfo: {
              displayName: 'Gemini 4 Neon (High)',
              modelName: 'gemini-4-neon-high',
              maxTokens: 1048576,
            },
            sourceTrajectoryStepInfo: { stepIndex: 3 },
          },
          step: { case: 'plannerResponse', value: { response: '分析完成。' } },
        },
        {
          status: 3,
          metadata: {
            createdAt: { seconds: '1795181503', nanos: 0 },
            sourceTrajectoryStepInfo: { stepIndex: 4 },
          },
          step: {
            case: 'userInput',
            value: {
              query: '',
              userResponse: '@[Quote] 就这个计划回复建议',
              items: [
                { chunk: { case: 'item', value: { scopeItem: { case: 'textBlock', value: { content: '方案 A' } } } } },
                { chunk: { case: 'text', value: ' 就这个计划回复建议' } },
              ],
            },
          },
        },
        {
          status: 3,
          metadata: {
            createdAt: { seconds: '1795181510', nanos: 0 },
            viewableAt: { seconds: '1795181513', nanos: 0 },
            finishedGeneratingAt: { seconds: '1795181515', nanos: 0 },
            modelUsage: {
              inputTokens: '2345',
              cacheReadTokens: '22434',
              cacheWriteTokens: '0',
              outputTokens: '400',
              thinkingOutputTokens: '100',
              responseOutputTokens: '300',
            },
            modelInfo: {
              displayName: 'Gemini 4 Hydrogen (High)',
              modelName: 'gemini-4-hydrogen-high',
              maxTokens: 1048576,
            },
            sourceTrajectoryStepInfo: { stepIndex: 5 },
          },
          step: { case: 'plannerResponse', value: { response: '已回复 Issue #4。' } },
        },
      ],
      // Remote/Cloud mode populates generatorMetadatasInSlice with empty metadata: {} stubs
      generatorMetadatasInSlice: [0, 1, 2, 3, 4, 5].map((i) => ({
        stepIndices: [i],
        metadata: {},
        plannerConfig: { modelName: i < 4 ? 'Gemini 4 Neon (High)' : 'Gemini 4 Hydrogen (High)' },
      })),
    },
  };

  const info = usageCore.analyzeActiveConversation(remoteAgentState, { cascadeId: remoteAgentState.conversationId });
  assert.equal(info.calls, 3, 'Must count real model calls, not empty generatorMetadata stubs');
  assert.equal(info.totalCalls, 3);
  assert.equal(info.turns, 2);
  assert.equal(info.steps, 6);
  assert.equal(info.lastModel, 'Gemini 4 Hydrogen (High)');
  assert.equal(info.maxContextTokens, 1048576);
  assert.equal(info.hasActiveLimits, true);
  assert.equal(info.hasExactContextLimits, false);
  assert.equal(info.contextUsed, 2345 + 22434 + 300);
  assert.equal(
    info.sysTokens + info.toolsTokens + info.chatMsgTokens + info.toolResultsTokens + info.overheadTokens,
    info.contextUsed
  );
  assert.ok(info.sysTokens > 15000, 'Should attribute Call 0 base prompt to sysTokens when tokenBreakdown is absent');
  assert.equal(info.displaySpeed, 200);
  assert.equal(info.avgTtft, 3);
  assert.equal(info.turnDetails.length, 2);
  assert.equal(info.turnDetails[0].userPreview, '看看 issue #4');
  assert.equal(info.turnDetails[0].toolCalls, 1);
  assert.equal(info.turnDetails[1].userPreview, '方案 A 就这个计划回复建议');
  assert.equal(info.turnDetails[1].model, 'Gemini 4 Hydrogen (High)');
  assert.equal(info.toolBreakdown[0].name, 'read_file');

  const rollup = usageCore.analyzeTrajectoryForUsage(
    remoteAgentState,
    { stepCount: 0, cloud: true, lastModifiedTime: { seconds: '1795181515' } },
    remoteAgentState.conversationId
  );
  assert.equal(rollup.calls, 3);
  assert.equal(rollup.summaryStepCount, 0);
  assert.equal(rollup.stepCount, 6);
  const day = Object.values(rollup.days)[0];
  assert.ok(day.models['Gemini 4 Neon (High)']);
  assert.ok(day.models['Gemini 4 Hydrogen (High)']);
  assert.equal(day.models.unknown, undefined);
});

test('normalizeAgentStateToTrajectory handles sliced steps, contextWindowUsage tokenGroups, and model slug prettification', () => {
  const slicedState = {
    conversationId: 'sliced-remote-1',
    status: 1,
    fullyIdle: true,
    contextWindowUsage: {
      estimatedTokensUsed: 290000,
      maxContextTokens: 734000,
      tokenGroups: [
        { name: 'System Prompt', type: 1, numTokens: 4000, children: [] },
        { name: 'Skills', type: 5, numTokens: 5000, children: [] },
        { name: 'Plugins', type: 9, numTokens: 1000, children: [] },
        { name: 'Tools', type: 2, numTokens: 8000, children: [] },
        { name: 'Mcp Tools', type: 4, numTokens: 2000, children: [] },
        { name: 'Chat Messages', type: 7, numTokens: 270000, children: [] },
      ],
    },
    trajectorySlice: {
      conversationId: 'sliced-remote-1',
      totalStepsLength: 250,
      stepsSlice: { startIndex: -2 },
      stepsInSlice: [
        {
          status: 3,
          metadata: { createdAt: { seconds: '1795180000' }, sourceTrajectoryStepInfo: { stepIndex: 248 } },
          step: { case: 'userInput', value: { userResponse: 'Continue' } },
        },
        {
          status: 3,
          metadata: {
            createdAt: { seconds: '1795180005' },
            modelUsage: { inputTokens: '5000', cacheReadTokens: '280000', outputTokens: '600', thinkingOutputTokens: '100', responseOutputTokens: '500' },
            modelInfo: { displayName: 'gemini-4-hydrogen-xhigh', modelName: 'gemini-4-hydrogen-xhigh', maxTokens: 1000000 },
            sourceTrajectoryStepInfo: { stepIndex: 249 },
          },
          step: { case: 'plannerResponse', value: { response: 'Done' } },
        },
      ],
      generatorMetadatasInSlice: [
        { stepIndices: [249], metadata: {}, plannerConfig: { modelName: 'Gemini 4 Hydrogen (XHigh)' } },
      ],
    },
  };

  const info = usageCore.analyzeActiveConversation(slicedState);
  assert.equal(info.steps, 250);
  assert.equal(info.totalSteps, 250);
  assert.equal(info.maxContextTokens, 734000);
  assert.equal(info.hasExactContextLimits, true);
  assert.equal(info.sysTokens, 10000);
  assert.equal(info.toolsTokens, 10000);
  assert.equal(info.lastModel, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(info.turnDetails.length, 1);
  assert.equal(info.turnDetails[0].userStepIdx, 248);
  assert.equal(info.turnDetails[0].lastStepIdx, 249);
  assert.equal(info.turnDetails[0].inProgress, false);
});

test('analyzeActiveConversation skips 0-token generatorMetadata startup stubs from callList and marks thinking turns as inProgress', () => {
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: { seconds: '1700001000' } }, step: { case: 'userInput', value: { query: 'Turn 1' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700001005' } }, step: { case: 'plannerResponse', value: { response: 'Turn 1 done' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700002000' } }, step: { case: 'userInput', value: { query: 'Turn 2 with tool then thinking' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700002002' } }, step: { case: 'plannerResponse', value: { response: '' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700002003' } }, step: { case: 'viewFile', value: { content: 'abc' } } },
      { status: 1, metadata: { createdAt: { seconds: '1700002005' } }, step: { case: 'plannerResponse', value: { thinking: 'Still thinking...', response: '' } } },
    ],
    generatorMetadata: [
      {
        stepIndices: [0, 1],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 3.8 Flash',
            usage: { inputTokens: '4000', cacheReadTokens: '100000', outputTokens: '98' },
            chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 104098, maxContextTokens: 256000 } },
          },
        },
      },
      {
        stepIndices: [2, 3],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 3.8 Flash',
            usage: { inputTokens: '500', cacheReadTokens: '104000', outputTokens: '40' },
          },
        },
      },
      {
        // In-progress call startup metadata with chatStartMetadata but no usage tokens yet
        stepIndices: [4, 5],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 3.8 Flash',
            usage: {},
            chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 112000, maxContextTokens: 256000 } },
          },
        },
      },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, { cascadeId: 'thinking-in-progress' });
  assert.equal(info.calls, 2, 'In-progress generatorMetadata without usage tokens must not inflate callList');
  assert.ok(info.contextUsed >= 112000, 'chatStartMetadata on in-progress call should still update live contextUsed');
  assert.equal(info.turnDetails.length, 2);
  assert.equal(info.turnDetails[0].turn, 1);
  assert.equal(info.turnDetails[0].inProgress, false, 'Completed Turn 1 must have inProgress=false');
  assert.equal(info.turnDetails[1].turn, 2);
  assert.equal(info.turnDetails[1].inProgress, true, 'Turn 2 with active thinking step (status=1) must have inProgress=true');
});

test('computeRingTelemetry dual mode and evaluateCostGuard detect draft/turn spikes accurately', () => {
  const dualTel = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 51200, maxContextTokens: 256000 },
    quotaInfo: { effectiveRemainingPct: 18 },
    ringMode: 'dual',
  });
  assert.equal(dualTel.mode, 'dual');
  assert.equal(dualTel.contextPctRound, 80);
  assert.equal(dualTel.quotaPctRound, 18);
  assert.equal(dualTel.pctRound, 18, 'Dual ring urgency tracks the lower of context or quota remaining');
  assert.equal(dualTel.level, 'warn');

  const calm = usageCore.evaluateCostGuard({
    draftTokens: 800,
    activeInfo: { turnDetails: [{ turn: 1, ctxDelta: 3200 }] },
  });
  assert.equal(calm.active, false);

  const spiked = usageCore.evaluateCostGuard({
    draftTokens: 5200,
    activeInfo: { turnDetails: [{ turn: 3, ctxDelta: 21000 }] },
  });
  assert.equal(spiked.active, true);
  assert.equal(spiked.kind, 'both');
  assert.equal(spiked.hasDraftWarn, true);
  assert.equal(spiked.hasSpikeWarn, true);
  assert.equal(spiked.spikeTurn, 3);
  assert.equal(spiked.spikeTokens, 21000);
});
