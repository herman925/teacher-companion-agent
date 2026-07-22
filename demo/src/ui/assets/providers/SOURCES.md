# Provider brand marks

Static SVG, checked in on purpose: the UI must render the same offline, on
static hosting, and behind the mainland firewall. No icon API, no CDN, no key.

| File | Source | Note |
|---|---|---|
| `glm.svg` | `@lobehub/icons-static-svg` → `zhipu-color` | 智谱 / bigmodel.cn |
| `zai.svg` | `@lobehub/icons-static-svg` → `zai` | serves `zai` and `zai-coding` |
| `qwen.svg` | `@lobehub/icons-static-svg` → `qwen-color` | |
| `minimax.svg` | `@lobehub/icons-static-svg` → `minimax-color` | serves `minimax` and `minimax-intl` |
| `kimi.svg` | `@lobehub/icons-static-svg` → `kimi-color` | |
| `openrouter.svg` | `@lobehub/icons-static-svg` → `openrouter` | |
| `kilocode.svg` | `@lobehub/icons-static-svg` → `kilocode` | |
| `opencode-zen.svg` | `@lobehub/icons-static-svg` → `opencode` | |
| `freemodel.svg` | freemodel.dev favicon (inline `data:` URI on their homepage), decoded | no third-party package carries it |

`lobe-icons` is MIT; the marks themselves stay the trademarks of their owners
and are used here nominatively, to name the service a teacher is connecting to.

Single-colour marks (`zai`, `kilocode`, `opencode-zen`, `openrouter`) shipped
with `fill="currentColor"`. An SVG loaded through `<img>` cannot inherit the
page's colour, so they are pinned to `#8c8c8c` — a neutral that reads on both
the light and the dark theme. The multi-colour marks are untouched.

To refresh one:

```sh
curl -sfL https://unpkg.com/@lobehub/icons-static-svg@latest/icons/<name>.svg -o <file>.svg
# then re-pin the fill if that icon is single-colour
```
