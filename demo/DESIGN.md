# Design System: 陪跑智能体 Demo (Companion Agent Chat)

**Scope:** `demo/` web interface. Source of truth for all demo UI work; the design judge and any generation prompts read from here.

## 1. Visual Theme & Atmosphere

**"A patient colleague's desk, not an AI dashboard."** The interface should feel like sitting across from an experienced teaching-research mentor at a warm wooden desk with good stationery: calm, literate, unhurried, quietly Lingnan (岭南). Nothing about it should smell of bureaucracy (no form grids, no wizard steppers, no progress percentage bars) and nothing should smell of generic AI product (no neon gradients, no glassmorphism, no floating orbs, no emoji as icons).

Density is **airy but purposeful** — generous paper-like whitespace around a single conversation column, with structured artifacts (cards) that appear *within* the conversation like handouts passed across the desk. Motion is gentle and physical: things settle onto the page; they never bounce, spin, or pulse for attention.

Light mode only for this phase. The overall temperature is warm: paper, ink, tea.

## 2. Color Palette & Roles

| Name | Hex | Role |
|---|---|---|
| Rice-Paper Warm White | `#FAF6EF` | Page background. Slightly warm, never pure white. |
| Ink Brown-Black | `#2D2A26` | Primary text. Softer than black; reads as ink, not pixels. |
| Faded Ink | `#6B645B` | Secondary text, timestamps, captions, placeholder copy. |
| Banyan Deep Green | `#2F5D50` | Primary brand color: agent identity, primary buttons, links, focused states. The green of banyan shade and river water — steady, trustworthy. |
| Banyan Wash | `#E8EFEB` | Tinted background for agent message blocks and selected chips. |
| Lion-Dance Persimmon | `#C96A3B` | Single warm accent: tappable example-answer chips (border/text), small highlights, the "one question" marker. Used sparingly — it is the color of *invitations to act*. |
| Osmanthus Gold | `#B8923E` | Reserved exclusively for the closure-loop card (border + section icons). Its scarcity makes round-endings visually unmistakable. |
| Question-Wall Cream | `#F3EAD8` | Background of artifact cards (切口卡, 问题池, 访谈卡) — the color of manila card stock. |
| Muted Brick | `#A8503C` | Errors, harness-blocked notices, destructive actions. Serious without alarm-red. |
| Study-Lamp Slate | `#23282E` | Debug drawer background (developer surface — deliberately cooler and darker than the teacher-facing paper world). |
| Slate Text | `#C9D1D9` | Debug drawer text and code. |

Rule: teacher-facing surfaces use only the warm family; the cool slate pair is quarantined to the debug drawer. Green and persimmon never sit at equal visual weight in one component — green leads, persimmon accents.

## 3. Typography Rules

- **Display / headings / artifact-card titles:** Noto Serif SC (思源宋体), weight 600–700. A literary serif keys the whole product to 课程故事 culture — teacherly, bookish, dignified.
- **Body / chat / UI controls:** system sans stack — `"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`, weight 400; 500 for emphasis and button labels. Body size 16px (15px minimum on mobile), line-height 1.75 for Chinese prose comfort.
- **Code / state fields / debug:** `"JetBrains Mono", Consolas, monospace`, 13px, used only in the debug drawer and for `course_state` field names.
- Letter-spacing: default for Chinese; +0.02em on serif display lines. Never letter-space Chinese body text.
- Chinese punctuation is full-width; line lengths capped at ~38 CJK characters for readability.

## 4. Component Stylings

* **Chat — agent messages:** not bubbles. Full-width blocks on Banyan Wash with a 3px Banyan Deep Green left rule, generously padded (20px), subtly rounded (8px). Reads as a colleague's written note, not a chat app.
* **Chat — teacher messages:** right-aligned soft rectangles (12px radius) on white with a hairline warm border (`#E5DED2`), max-width 75%.
* **Example-answer chips (the anti-form-filling workhorse):** pill-shaped (fully rounded), white fill, 1.5px Lion-Dance Persimmon border, persimmon text; on hover/tap fill warms to `#FBEFE7`; on selection the chip's text is inserted into the input for editing (never submitted directly — the teacher always keeps the pen). Chips wrap in a row beneath the agent's question, staggering in.
* **Artifact cards (切口卡 / 问题池 / 访谈卡 / 目标轴心):** Question-Wall Cream stock, 10px radius, whisper-soft diffused shadow (`0 2px 12px rgba(45,42,38,0.08)`), serif title with a small persimmon seal-style tag for the card type (e.g. 切口卡), body in labeled sections. 待现场确认 items carry a dashed underline and a small faded-ink tag — visibly provisional, not shameful.
* **Closure-loop card:** the round-ending signature. White card, 2px Osmanthus Gold border, four rows each led by a gold number-in-circle: 本轮可以去做 / 建议素材 / 回来告诉我 / 我会继续帮你. Rows reveal sequentially (see §6). No other component may use gold.
* **Harness-refusal notice:** when L3 blocks fabrication or a gate refuses a request (e.g., full plan before evidence), the reply renders normally but carries a slim Muted Brick top rule and a one-line plain-language reason plus the next-evidence task. Courteous, brief, never scolding.
* **Input area:** single rounded field (12px) with warm border, growing to 5 lines; send button is a Banyan Deep Green circle with an ink-brush arrow glyph. A quiet 先跳过 text link sits left of send whenever the agent has asked a question.
* **Settings modal:** settings open as a centered modal (as chat products do), not a side drawer — a paper card (max 720px, 14px radius, soft deep shadow) over a translucent ink scrim. Inside: a slim left nav (通用 / 模型服务 / 教师档案) and one pane at a time; nav items use the rail's row treatment (cream hover, Banyan Wash + green for the active item). Serif title, hairline head rule, close ✕ top-right; Esc and scrim-click dismiss. Below 560px the nav becomes a horizontal row and the card becomes a near-full sheet. The modal stays entirely in the warm family.
* **Settings modal — pane contents.** 通用 owns what a teacher actually decides: the **model choice** (the most important control, so it lives first) plus, when the chosen provider has mainland/international variants, a single 线路 selector — MiniMax and GLM appear once each in the dropdown, and the channel switch picks 国内/国际 underneath (演示模式 stays its own entry). 开发者模式 follows. 模型服务 is purely API plumbing: per-channel keys and model ids, the custom endpoint, and — collapsed at the bottom as 高级 — the 服务器地址 field with an honest explanation: it exists only for static hosting (e.g. GitHub Pages) that must point at a remote proxy; via the tunnel or a local run it stays empty. 教师档案 holds the teacher profile (below). A quiet note records the plan of record: provider choice eventually collapses to 官方服务 (platform-provided, keys server-side) vs 自备密钥 BYOK.
* **Teacher profile (教师档案) fields:** 地区 = 省级 select（31 省市区 + 中国香港 / 中国澳门 / 中国台湾 + 其他）+ 区/县 free text; 年龄段（可选，5 intervals）; 教龄（总）in intervals（0–2 / 3–5 / 6–10 / 11–20 / 20 年以上）; 本园年资 in intervals; 角色 select fitting mainland kindergartens（班主任 / 配班教师 / 保育员 / 年级组长 / 保教主任 / 园内教研员 / 副园长 / 园长 / 实习教师 / 其他）; 任教班级 as checkboxes（小班 / 中班 / 大班 / 混龄 — multiple allowed）; 班额 number; 回应风格 as five fixed choices（简洁要点 / 温和鼓励 / 详细讲解 / 案例参照 / 提问引导）. All optional, local-only in the demo; injected read-only into the prompt, never model-writable. When accounts land this pane graduates into the user console (people icon) alongside password and display-name management.
* **Admin data console (`/admin`):** speaks the same design language as the teacher UI — paper page, serif headings, warm hairlines, cream table-row hovers, green primary actions, brick destructive actions. It is an operations surface, so density is higher (a real table, mono only for the JSON record pane), but nothing slate: the cool palette stays quarantined to the debug drawer. Includes a collapsible 使用指南 for teammates (connect via the wizard, password rules, manage/export/delete) at the top.
* **Debug drawer:** slides from the right, Study-Lamp Slate, monospace; shows stage, state diff (green/red JSON lines), gate checks with pass/fail ticks, provider + token usage. A keyboard shortcut and a tiny wrench icon open it; teachers should never notice it exists.
* **History rail (历史课程侧栏):** the conversation-list surface (as a chat app has a left rail), shown only when server-side history exists (the persistence tier). It defers to the reading experience — collapsed by default so the single centered column stays undisturbed. A narrow (12px) hot-zone at the left edge reveals it on hover (desktop): it slides in over the left margin on a paper surface with a hairline warm right border and the card shadow (never a green fill — the rail is backdrop, not brand), and slides away when the pointer leaves. A pin toggle keeps it open and reflows the column to its right, and that choice persists across reloads; unpinning returns to hover-reveal. On touch, a header 历史 button opens it as a left sheet. Rows: course title in body sans; the active course is marked with a Banyan Deep Green dot and Banyan Wash fill (never persimmon or gold — those stay reserved). Motion matches the drawers: slide 280ms `power2.out`.
* **History rail — manage & delete:** a 管理 text link flips the rows into a multi-select state (a checkbox per row); a footer then offers 删除所选 (N) and 全部删除. Deletion is destructive, so it is always two-step and inline — never a browser modal dialog: the delete control re-labels to a 确定删除 N 个？ confirm and only completes on a second click (取消, or leaving manage mode, aborts). A single row's ✕ (revealed on hover) uses the same inline confirm. Destructive labels use Muted Brick, consistent with harness-refusal and error color.
* **History rail — button custody:** course actions live in the rail, not the chat header. ＋新课程 and 管理 are rail-footer buttons; when the rail exists (persistence tier) the header carries only the 历史 toggle — no duplicate 新课程. The 历史 button is a true toggle (open ↔ close; when pinned, it unpins and closes). Header 新课程 appears only in the offline/static mode where there is no rail.

## 5. Layout Principles

- Single conversation column, max-width **720px**, centered; artifact cards may extend to 800px on desktop for breathing room.
- **8pt spacing grid** throughout; message vertical rhythm 24px; card internal padding 24px.
- Mobile-first: at <480px the column is full-bleed with 16px gutters; chips become a horizontal scroll row; the debug drawer becomes a bottom sheet.
- Touch targets ≥44px everywhere (chips included).
- The page header is minimal: product name in serif, course name in faded ink, and the settings (API key/provider) gear — no navigation chrome to compete with the conversation.
- The history rail is the one permitted left surface, and it earns that by staying hidden until asked for (a hover hot-zone, or pinned by explicit choice). First paint is unchanged — one centered column, no competing chrome (§1). Pinned mode reflows the column to the right of a 260px rail rather than overlapping it; hover-reveal overlays the left margin without moving the column.

## 6. Motion (GSAP)

Character: **settling paper, morning light** — everything eases out, nothing overshoots. Base ease `power2.out`; durations 280–420ms; stagger 60–80ms.

- New message: rise 12px + fade in.
- Artifact card: "dealt onto the desk" — fade + rise 16px with a 0.5° → 0° rotation settle.
- Chips: stagger in left-to-right after the question renders.
- Closure-loop rows: sequential reveal, 90ms stagger, gold circle draws in (SVG stroke).
- Streaming text: no per-token jitter effects; the caret is a quiet fading bar.
- `prefers-reduced-motion`: all of the above collapse to simple fades.

## 7. Voice & Microcopy

UI copy is Simplified Chinese, in the spec's 温和引导 register: warm, concrete, never imperative ("回来时带几句孩子原话和现场照片就很好"). No exclamation marks. No emoji in agent prose. Buttons are verbs (发送 / 先跳过 / 展开卡片). The agent refers to itself as 我, to the teacher as 你, and never says 请注意 or 系统提示.
