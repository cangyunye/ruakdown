# 主题开发指南(自用方案)

> 目的:新增主题时**只做两步**,不再重新排查"要动哪些地方"。
> 主题相关的全部要素都已收敛为一批配置与自动机制,主题本身只是这批配置的一份风格取值。

## 一、架构:为什么只需要两步

主题 = 一份 JSON(中文名 + 明暗标志 + CSS 变量表),由 Rust 编译期内嵌(`include_str!`)。

```
resources/themes/<id>.json          ← 主题的唯一"实体"
        │  BUILTINS 注册表(theme.rs,一行一个)
        ▼
get(id) → apply_theme 命令 ─┬─ 前端 applyTheme():变量写入 :root,
                            │  打 data-theme / data-scheme 两个钩子
                            └─ 窗口标题栏明暗(tauri::Theme)
list() → list_themes 命令 ─── 前端主题选择器(id → 显示名,
                               取自 JSON 的 name 字段,前端零硬编码)
```

自动跟随、**永不接线**的部分:

| 消费方 | 机制 |
|--------|------|
| 全部 UI 样式(index.css) | 只依赖 CSS 变量,组件层没有按主题的规则 |
| 语法高亮 `--syn-*` | `data-scheme` 两套取值,随 `dark` 字段自动切换 |
| Mermaid | `dark ? "dark" : "default"`,随 `data-scheme` |
| 导出 HTML / 局域网分享 | 后端读同一份 JSON,内联同样的变量 |
| 专注模式遮罩 | `--reader-overlay-rgb` |
| frontmatter 标签色板 | `--chip-0…7` |
| 主题选择器标签 | `list_themes` 下发 JSON 的 `name`,前端无字典 |
| 样式槽位的默认值 | `core/style.rs` 契约测试:无 fallback 的 `var(--slot)` 必须三端均有供给 |
| 测试 | 全部遍历 `BUILTINS`,新主题自动纳入校验 |

## 二、新增主题:两步

1. **复制一份现成 JSON** → `src-tauri/resources/themes/<id>.json`
   - `id` = 文件名,kebab-case,**定下后不再改**(`config.json` 的 `theme` 存的是 id);
   - `name` 填中文名(它会直接出现在选择器里);
   - `dark`:深色 `true` / 浅色 `false`;
   - `vars` 必须包含下方清单的全部变量(缺了 `cargo test` 直接红)。
2. **在 `src-tauri/src/core/theme.rs` 的 `BUILTINS` 表加一行**
   ```rust
   ("<id>", include_str!("../../resources/themes/<id>.json")),
   ```
   注意:**数组顺序 = 选择器里的显示顺序**(浅色/暗色在最前)。

然后跑 `cargo test`(在 `src-tauri/` 下):`builtin_themes_parse` 与
`builtin_themes_define_all_required_vars` 会自动遍历 `BUILTINS` 校验新主题。
前端无需任何改动。

## 三、样式槽位的拓展(注册新样式)

主题变量是**槽位**,主题 JSON 是**取值**。加主题 = 加一行取值(上节);
给主题系统增加一个可定制的样式点(如给 h6 独立配色) = **注册一个新槽位**,
方向相反、流程不同。

### 先分清两类改动

- **复用现有槽位**:新元素直接吃已有变量(`--accent`、`--code-bg`…)
  → 无需任何注册,写 CSS 即可;
- **注册新槽位**:出现一个新的可主题化样式点(如 `--heading-6`)
  → 走下面的流程。

### 槽位三分类(现状即规范)

| 类别 | 判定 | 例子 | 新槽位落点 |
|------|------|------|------------|
| 核心槽位 | JSON 必填,进 `REQUIRED_VARS` | `--bg`、`--accent`、`--chip-*` | 仅当所有主题都该有个性值时才升级到这类 |
| 可选槽位 | 消费处带 fallback,JSON 不填自动继承 | `--reader-bg-blur`、`--zen-dim` | ✅ 新槽位一律先落这里 |
| chrome 派生 | 不进 JSON,CSS 从其他槽位派生 | `--hover`(color-mix 自 `--text`) | — |

### 注册一个新槽位(以 `--heading-6` 为例)

1. **消费侧写 fallback**:
   - 正文样式 → `src-tauri/resources/md-content.css`:
     `.md-body h6 { color: var(--heading-6, var(--heading)); }`
     —— 阅读视图 / 导出 HTML / 局域网分享**三端同时生效,零接线**;
   - 应用 chrome → `src/index.css` 同理。
   fallback 必须指向"最近的语义父槽位"(`--heading-6 → --heading`),
   保证没填值的主题观感完全不变。
2. **登记**:本文档「四、变量清单」表格加一行(文档即槽位注册表):
   名字、作用、fallback、覆盖它的主题。
3. **按需取值**:想差异化的主题在 JSON `vars` 里加一行;不填 = 继承 fallback。
4. **护栏测试自动把关**:`core/style.rs` 的槽位契约测试断言两个样式引擎里
   每个 `var(--slot)` 要么有静态定义、要么消费处带 fallback,且
   `md-content.css` 的消费在导出页与分享页均有供给 —— 新槽位漏写
   fallback 会直接红(实测有效,报错精确到槽位名)。
5. **升级为核心槽位**(可选):当所有主题都应有独立取值时——
   12 个 JSON 补上该变量、加进 `REQUIRED_VARS`、消费处去掉 fallback;
   若正文样式消费它,**serve.rs 的 light/dark 静态块也必须补值**
   (分享页不读主题 JSON)。

### 什么时候才需要动 serve.rs / export.rs

- `export.rs` 永远不用动:它内联主题 JSON 全部变量 + `md-content.css`,
  fallback 链自动落地;
- `serve.rs` 只在两种情况要动:① 新槽位升级为核心且被正文样式消费
  (给 light/dark 两套静态块补值);② fallback 链的根不在已有核心槽位里
  (不该发生——fallback 一律指向既有槽位)。

### 关键纪律

- fallback 是可选槽位的**默认实现**,主题没填 = 设计里想好的继承值,不是事故
  (真实案例:`kbd` 曾无 fallback 地消费 app 专属的 `--hover`,导致导出/分享页
  键帽丢底色——现已修复为 `var(--hover, var(--panel))`);
- 不确定要不要新槽位?先问:这个样式点是否需要**跨主题差异**。
  不需要 → 复用现有槽位。

## 四、变量清单(即 `theme.rs` 的 `REQUIRED_VARS`)

| 变量 | 作用 | 取值建议 |
|------|------|----------|
| `--bg` | 全局底色 | 主题基调;深色主题 luma < 0.1,浅色 > 0.9 |
| `--panel` | 面板/侧栏/输入框底 | 比 `--bg` 高/低半档 |
| `--border` | 通用描边 | 与 `--panel` 拉开但不宜过强 |
| `--text` | 正文 | 与 `--bg` 对比度拉满(深色主题 luma > 0.6) |
| `--muted` | 次要文本/占位符 | `--text` 与 `--bg` 之间靠 `--bg` 一侧 |
| `--heading` | 标题色 | 主题的"主色相" |
| `--link` | 链接 | 通常与 `--accent` 同色 |
| `--accent` | 强调(选中/按钮/光标) | 主色相的高饱和取值 |
| `--accent-soft` | 强调底色 | `rgba(<accent>, 0.12–0.16)` |
| `--code-bg` / `--code-text` | 行内代码 | 底色与 `--panel` 区分,文字可偏主题色系 |
| `--pre-bg` / `--pre-border` | 代码块 | `--pre-bg` 应比 `--bg` **再深(深色)/再浅(浅色)一档**,做出嵌入感 |
| `--quote-border` / `--quote-text` | 引用块 | 边框可用主色相 |
| `--table-border` | 表格线 | 同 `--border` 或略深 |
| `--mermaid-bg` | 图表底色 | 与 `--bg`/`--panel` 协调,勿与连线色冲突 |
| `--reader-overlay-rgb` | 专注模式遮罩 | **`--bg` 的 `R, G, B` 三元组**(逗号+空格分隔) |
| `--chip-0…--chip-7` | frontmatter 标签 8 色循环 | 唯一允许"艳"的地方:8 个色相彼此可辨、在底色上可读 |

## 五、设计基准

- `dark` 字段决定 `data-scheme`,进而联动语法高亮、Mermaid、窗口标题栏——按真实观感填写,不要为了别的效果乱标。
- 深浅主题都保证:**正文对比度 > 标题/强调 > 弱化文本**,层级靠亮度而不是纯灰堆砌。
- 色彩个性放进 `--heading` / `--link` / `--accent` / `--quote-border` 和 chip 色板;底色三件套(bg/panel/border)保持克制。
- 想好一句话的设计基调,写成特征测试(见下节),先定断言再调色,调完即"验收通过"。

## 六、可选:主题级 CSS 覆盖块

仅当变量表达不了结构差异时,在 `src/index.css` 加 `[data-theme="<id>"]` 覆盖块
(先例:wudang 的表格表头/引用/hr/reader-wrap)。规则:

- 集中放在既有覆盖块相邻区域,块前注释说明动机;
- 能用变量解决的**一律用变量**,覆盖块数量保持个位数;
- 新主题默认**零覆盖块**。

## 七、特征测试(建议,非必需)

参照 `theme.rs` 里的 `wudang_is_ink_on_paper_weave`、`cyberpunk_is_neon_on_void`:
用现成的 `luma()` 断言锁定设计基调(底色明暗、强调色系、`--link == --accent` 之类的约定、
`--accent-soft` 的 rgba 前缀)。作用是防止后人无意改坏主题气质;调色时它就是验收标准。

## 八、发版前检查清单

- [ ] JSON:`REQUIRED_VARS` 全齐、`--reader-overlay-rgb` 与 `--bg` 同底色、chips 8 色
- [ ] `BUILTINS` 注册一行,位置符合期望的显示顺序
- [ ] `cargo test`(src-tauri/)、`npx tsc --noEmit`、`npx vitest run` 全绿
- [ ] (可选)特征测试、CSS 覆盖块
- [ ] CHANGELOG 留到发版时统一写
