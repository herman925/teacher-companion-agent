# 教师资源发展平台

English version: [README.md](README.md)

一个基于网页的AI陪跑智能体，陪伴幼儿园教师完成本土文化主题探究课程——从资源意图出发，经过证据驱动的多轮行动循环，最终沉淀为课程故事。以V1.3集成工作流规范（番禺幼教AI主题探究陪跑智能体集成工作流）为行为契约。

## 一句话命题

工作流规范是严格的；照本宣科的实现会变成填表机器人。本平台把严格对准模型（运行时护栏：证据优先、输出闭环、阶段关卡），把自然对话留给教师（动态识别：先读状态、一次一问、必附示例）。

## 仓库地图

| 路径 | 内容 |
|---|---|
| `source-docs/` | V1.3工作流规范（docx + 忠实的markdown提取）。上游参考——只读。 |
| `docs/` | [PRD（英文）](docs/PRD.md) · [PRD（简中）](docs/PRD.zh-CN.md) · [架构设计](docs/ARCHITECTURE.md) · [模型API调研](docs/MODEL-APIS.md) · [术语表](docs/glossary.json) · 架构决策记录 |
| `harness/` | 开发护栏：提交门禁、术语/双语/风格检查。详见 [AGENTS.md](AGENTS.md)。 |
| `demo/` | 最小闭环网页演示：对话界面 + 运行时护栏 + 模型适配层。 |
| `tests/` | 护栏链路的Node原生测试。 |

## 快速开始

```bash
npm install        # 零依赖；自动安装git钩子
npm run gate       # 运行完整开发护栏门禁
npm test           # 护栏链路测试
```

演示（建成后）：运行 `node demo/serve.mjs`，打开输出的地址，在设置抽屉中粘贴 MiniMax/GLM/Kimi 的 API 密钥。

## 当前状态

第0期——规范、治理、架构调研，以及规范§7的最小闭环演示。AI绘图、微信小程序封装、真实账号系统均有意延后；见 [PRD §5.2](docs/PRD.zh-CN.md)。

## 工作约定

人类与编码智能体共同遵循 [AGENTS.md](AGENTS.md)。术语表就是法律；文档是双语孪生；提交前必须通过门禁；儿童证据绝不编造。
