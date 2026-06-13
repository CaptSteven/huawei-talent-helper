# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A single-file Tampermonkey/Greasemonkey userscript that augments the Huawei Talent Online
course site (`e.huawei.com/cn/talent/*`). It injects a floating control panel that auto-plays
course videos (continuous playback, playback-speed override, anti-idle popup dismissal) and adds
AI-assisted quiz answering via DeepSeek / Gemini / Qwen APIs.

There is no build, no test runner, no package manager, and no dependencies. The entire program is
`src/huawei-talent-helper.user.js`. README.md and code comments are in Chinese.

## Developing / testing

- **Run**: install [Tampermonkey](https://www.tampermonkey.net/), then create a script and paste
  the full contents of `src/huawei-talent-helper.user.js`, or install via the `@downloadURL` in the
  metadata block. There is no local dev server — testing happens live against the Huawei site.
- **Edit loop**: change the file, paste/reload it in Tampermonkey, reload the course page.
- **Versioning**: bump `@version` in the `==UserScript==` block AND the version strings in
  `@name` / `@description` / README badge together; Tampermonkey uses `@version` for update checks.
- The `@updateURL` / `@downloadURL` point at `github.com/CaptSteven/Huwei_Helper_Plug`. Keep them
  consistent with the actual publish target if the repo moves.

## Architecture

The script runs in **every frame** of the page (`@run-at document-end`). The single top-level
`if (IS_TOP) {...} else {...}` split (`IS_TOP = window.top === window`) is the core architectural
divide — the same file behaves as two cooperating programs:

- **Architecture A — top window (the "brain")**: owns the UI panel, fuses state, drives navigation.
  Builds and renders `#hw-global-panel`, holds the canonical `CONFIG` (autoNext, playbackSpeed,
  delays) and `AI_CONFIG`, runs the autoplay countdown, and decides when to jump to the next lesson.
- **Architecture B — child iframes (the "executors")**: the actual `<video>` and course catalog
  live inside iframes. Each iframe scans every 500ms (`pureIframeScanner`), enforces playback speed,
  auto-resumes paused video, and reports state up.

The two halves communicate **only** via `window.postMessage`, never shared globals (each frame has
its own JS context). Message protocol:

- `HW_FRAME_REPORT` (iframe → top): video progress / ended / paused / catalog title.
- `HW_CONFIG_SYNC` (top → iframe): pushes current `CONFIG` so iframes match the panel.
- `HW_COMMAND_JUMP` (top → iframe): tells the catalog iframe to advance to the next lesson.

### Navigation / autoplay flow

When an iframe reports `ended`, the top window starts a countdown (`startCentralCountdown`) guarded
by `jumpLock` to prevent double-advances, then broadcasts `HW_COMMAND_JUMP`. The iframe's `doJumpV21`
walks the catalog tree (`.el-tree` etc.), finds the current node, and clicks the next playable row,
falling back to a generic "next" button if the tree isn't found.

Two defensive mechanisms handle non-video nodes (courseware, quizzes, exams — `BLACKLIST_KEYWORDS`):
the script fakes an `ended` + `isEscape` state so the brain "escapes" past nodes that have no video
and would otherwise stall autoplay.

### AI quiz solving

The shixizhi (`sxz`) quiz shows **one question per page**; `collectSxzQuizQuestions` always returns a
single-element array. The full flow advances through questions one at a time.

`runAutoAiCycle` (the 5s loop, runs in every frame) is the auto-quiz state driver. Two toggles gate it:
- **`autoSolve`** ("自动识别") — fill answers automatically. Per-question: `solveQuestionsWithAi('auto')`.
- **`autoSubmit`** ("自动提交") — also *navigate*: click 开始测验 to enter, 下一题 to advance,
  check the answer card for unanswered items, click 交卷, then proceed to the next stage. With both
  on you get the full hands-off flow: enter → answer each → verify → submit → next stage.

Quiz-flow helpers are keyword/selector-based on top of the sxz classes (`.start-test`, `.subject-btn`,
`.submit-btn`, `.test-content`): `findQuizStartButton`, `findQuizNextButton`, `findQuizSubmitButton`,
`findUnansweredCardItem`, `finalizeQuiz`, `tryProceedToNextStage`. The 交卷 confirm dialog is clicked by
the existing `handlePopups` loop (it auto-confirms 确定/确认/继续).

**Escape suppression**: 测验/考试 are in `BLACKLIST_KEYWORDS`, so the iframe blackhole-escape would
normally skip a quiz node. `shouldHoldForQuiz()` gates that escape — while auto-solving a not-yet-
submitted quiz, escape is held so the script doesn't jump away mid-answer. After 交卷 (`quizSubmittedAt`
set), the hold lifts within 60s so navigation to the next stage can proceed.

Single-question entry point `solveQuestionsWithAi(trigger)` (`trigger` = `'manual'` from the button,
`'auto'` from the loop). Pipeline: `collectQuestionGroups` → `askAiForAnswers` → `applyAiAnswers` →
optional `trySubmitAnswer`. Concerns to preserve when editing:

- **Question collection is heuristic and selector-fragile.** It first tries the site-specific
  `.test-content` / sxz quiz layout (`collectSxzQuizQuestions`), then falls back to generic
  radio/checkbox scanning with `findQuestionContainer` climbing the DOM. The site's markup changes,
  so these selectors are the main maintenance surface.
- **Providers** are described declaratively in `AI_PROVIDERS` (`type: 'openai' | 'gemini'`). OpenAI-
  compatible providers (DeepSeek, Qwen) share `callOpenAiCompatibleApi`; Gemini uses `callGeminiApi`.
  Adding a provider = add an entry + matching `@connect` host in the metadata block.
- All network calls go through `GM_xmlhttpRequest` (`gmRequestJson`) to bypass CORS; any new API host
  **must** be added to `@connect` or requests are blocked.
- Re-solve guard: `auto` triggers are deduped via `buildQuestionSignature` + a 120s cooldown, and
  `aiSolveLock` prevents concurrent solves.

### State / config

- `AI_CONFIG` is persisted with `GM_setValue`/`GM_getValue` under `HW_TALENT_HELPER_AI_CONFIG`;
  `loadAiConfig` merges stored values over `DEFAULT_AI_CONFIG`. API keys live only in this local store.
- `CONFIG` (playback behavior) is **not** persisted — it resets per page load and is the source of
  truth pushed to iframes.
- `autoSubmit` defaults off by design (AI answers can be wrong); be deliberate about changing defaults.
