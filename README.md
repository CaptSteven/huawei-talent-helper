# Huwei_Helper_Plug

[![License](https://img.shields.io/github/license/CaptSteven/Huwei_Helper_Plug)](LICENSE)
[![UserScript](https://img.shields.io/badge/UserScript-Tampermonkey-orange.svg)](https://www.tampermonkey.net/)
[![Version](https://img.shields.io/badge/version-1.3.1-blue.svg)]()

Huwei_Helper_Plug 是一个用于华为人才在线课程页面的 Tampermonkey 脚本插件。它在课程页面注入一个悬浮控制面板，支持视频连播、倍速控制、防挂机弹窗处理，并新增 AI 做题能力。

## 功能

- 自动连播课程视频。
- 调整视频播放倍速。
- 自动处理常见的继续观看、确定、确认类弹窗。
- 跳过或避开课件、测验、考试、作业等非视频节点。
- 支持 AI 做题：识别页面中的单选题、多选题，调用模型 API 分析答案并回填选项。
- 支持手动做题和自动识别做题。
- 支持全自动答题流程：自动进入测验 → 逐题作答 → 检查未作答题目 → 自动交卷 → 进入下一环节（需开启「自动提交」，默认关闭）。

## AI 做题支持

当前默认支持三个官方模型 API：

| 模型源 | 默认模型 | 接口类型 |
| --- | --- | --- |
| DeepSeek 官方 | `deepseek-v4-flash` | OpenAI-compatible Chat Completions |
| Gemini 官方 | `gemini-3.5-flash` | Gemini `generateContent` |
| Qwen 官方 | `qwen-plus` | OpenAI-compatible Chat Completions |

使用方式：

1. 打开课程或测验页面。
2. 在右侧悬浮面板中找到「AI 做题」区域。
3. 选择模型源。
4. 填写对应平台的 API Key。
5. 点击「保存」。
6. 点击「识别做题」，脚本会扫描当前页面和 iframe 中的题目并尝试回填答案。

可选项：

| 配置项 | 说明 |
| --- | --- |
| 启用 | 开启后允许脚本调用模型 API。 |
| 自动识别 | 每 5 秒扫描一次页面，发现新题目后自动请求模型。 |
| 自动提交 | 开启后接管整套答题流程：自动进入测验、逐题作答并推进、答完检查未作答题目、自动交卷、并进入下一环节。关闭时仅回填答案、不做任何点击导航。 |
| 模型名 | 可按自己的账号权限改成其他可用模型。 |
| API Key | 仅保存在本地浏览器脚本存储中，不会提交到仓库。 |

## 安装

先安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)。

安装脚本：

[点击安装 Huwei_Helper_Plug](https://raw.githubusercontent.com/CaptSteven/Huwei_Helper_Plug/main/src/huawei-talent-helper.user.js)

也可以复制 [src/huawei-talent-helper.user.js](src/huawei-talent-helper.user.js) 的完整内容，在 Tampermonkey 中新建脚本并粘贴保存。

## 权限说明

脚本需要以下 Tampermonkey 权限：

| 权限 | 用途 |
| --- | --- |
| `GM_xmlhttpRequest` | 跨域请求 DeepSeek、Gemini、Qwen API。 |
| `GM_setValue` / `GM_getValue` | 在本地保存 AI 配置。 |
| `@connect` | 允许访问模型 API 域名。 |

更新脚本后，如果 Tampermonkey 提示新增权限，请确认后再使用 AI 做题功能。

## 注意事项

- AI 结果可能出错，提交前建议自行确认答案。
- 自动提交默认关闭，建议确认脚本识别效果后再开启。
- API Key 请妥善保管，不要写入代码或公开提交。
- 本项目仅用于脚本开发和自动化能力学习，请遵守目标网站规则及相关法律法规。

## License

MIT License
