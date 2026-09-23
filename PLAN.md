# Ruakdown v0.8.1 开发计划 — 快速打开(Quick Open)

> 状态:已实现并发布 v0.8.1(纯函数 + 组件 TDD,96 测试全绿)· 版本:v0.8.1
> 关联:替换 v0.7.1 引入、v0.8.0 保留的「目录内搜索」模态入口。

## 1. 背景与目标

现有 `Ctrl/Cmd+Shift+F` 打开的是**跨文件正文搜索**(递归扫当前文件夹所有 `.md` 的内容行)。对阅读器而言这是低频需求,却占着「搜索」这个最高频入口。真正高频的是「快速打开某个文件」。

v0.9.0 把它重构为一个 **Quick Open**:

- **空输入** → 列出「最近打开」(历史,最近优先)。
- **输入** → 分区结果:`最近打开` 命中在前 → `当前文件夹文件名` 命中在后;子串匹配、不区分大小写。
- **正文搜索**降级为模态内一个「内容」模式开关,保留能力但不再挡主路径。
- 一个入口、一个模态。

## 2. 已定决策

| 项 | 决定 |
|----|------|
| 形态 | 合并重构为 Quick Open(不新增第二个模态) |
| 快捷键 | 新增 `Ctrl/Cmd+P`;菜单「视图 → 快速打开...」;`Ctrl/Cmd+Shift+F` 保留,直接进入「内容」模式 |
| 匹配 | 不区分大小写的子串匹配(文件名与路径均可匹配) |
| 历史 | 持久化到配置,去重、最近优先、上限 15 |

## 3. 任务拆解

### A. 持久化(最近打开)

1. `src-tauri/src/core/config.rs`:新增 `recent_files: Option<Vec<String>>`(向后兼容追加,缺省为 `None`)。
2. `src/ipc.ts` 的 `AppConfig`:加 `recentFiles: string[] | null`。
3. `src/App.tsx` `openFile` 成功后更新历史:
   `recent = [path, ...prev.filter(p => p !== path)].slice(0, 15)`,并 `persist({ lastFile: path, recentFiles: recent })`;启动恢复时读入 `cfg.recentFiles`。
4. 打开失败(路径已失效)时给出提示,并把该路径从历史中剔除。

### B. 数据源(不新增后端命令)

5. 文件名匹配复用已加载的 `tree: TreeNode[]`(递归取 `!isDir` 的 `name` / `path`)。
6. 「内容」模式复用现有 `api.searchDocs(root, q, cs)`(`src-tauri/src/core/search.rs`),保留不删。

### C. 模态重构

7. `src/components/SearchModal.tsx` → `src/components/QuickOpen.tsx`:
   - 空 query → 「最近打开」列表(最近优先;每项显示文件名 + 父目录)。
   - 非空 query → 分区:
     - 「最近打开」:历史中路径 / 文件名命中。
     - 「文件名」:当前文件夹树中文件名命中,按路径排序。
     - 二者都为空且未开「内容」→ 空状态提示。
   - 「内容」开关(位置类似现有 `Aa` 按钮)→ 切到正文搜索,沿用现有分组渲染与 `api.searchDocs`;命中点击定位到行(保留 `onOpenHit` 逻辑)。
   - 键盘:↑/↓ 选择、Enter 打开、Esc 关闭(沿用)。
8. 快捷键接线:
   - `src/App.tsx` 全局 keydown 增加 `Ctrl/Cmd+P`(在 webview 中拦截打印,`preventDefault`,做法同 `Ctrl+R`),`fireOnce("quick-open", ...)`。
   - 菜单 `src-tauri/src/lib.rs`「视图」新增 `quick-open` 项,加速键 `CmdOrCtrl+P`;`menuRouteRef` 增加对应 case。
   - `Ctrl/Cmd+Shift+F` 保留,打开同一模态并默认激活「内容」模式。

### D. 文档

9. `CHANGELOG.md`:新增 `## [未发布]` 段落,记录 v0.9.0 变更(发版流程要求)。
10. `USAGE.md`:快捷键总表补充 `Ctrl/Cmd+P`;新增「快速打开」小节;修订「目录内搜索」旧描述(入口与行为变化)。

### E. 测试(TDD)

11. 抽纯函数到 `src/quickOpen.ts`:
    - `rankRecent(query: string, recent: string[]): string[]` — 子串过滤 + 保序(最近优先)。
    - `matchTree(query: string, tree: TreeNode[]): { name: string; path: string; dir: string }[]` — 递归收集文件名命中,按路径排序。
    - `upsertRecent(path: string, recent: string[], cap = 15): string[]` — 去重置顶 + 截断。
12. 每个纯函数先写失败测试(`src/quickOpen.test.ts`),再实现。
13. 组件测试(可选):`QuickOpen.test.tsx` 覆盖「空输入显示最近打开」「输入过滤」「Enter 打开」。

## 4. 风险与取舍

- **Ctrl+P 拦截**:webview 中 `Ctrl/Cmd+P` 默认是打印,必须在全局 keydown 捕获并 `preventDefault`;有 `Ctrl+R` 的成功先例。
- **跨文件夹历史**:最近打开是全局历史,可能指向当前文件夹之外;`openFile` 需能接受任意路径(现状支持),失效路径按 A.4 处理。
- **低频能力**:「内容」模式默认不激活;若后续确认从不使用,可整段删除(后端 `search.rs` 一并评估)。
- **分块大文档**:内容模式沿用既有 best-effort 定位;Quick Open 的文件名/最近打开不受影响。

## 5. 验收

- [ ] `Ctrl/Cmd+P` 打开模态,空输入列出最近打开,可子串搜索。
- [ ] 输入时「最近打开」与「文件名」分区正确、排序稳定。
- [ ] 切换「内容」模式后行为与旧「目录内搜索」一致。
- [ ] `Ctrl/Cmd+Shift+F` 仍可用,直接进入内容模式。
- [ ] 历史持久化:重启后保留,去重、上限 15,失效路径可剔除。
- [ ] `pnpm test` / `tsc --noEmit` / `pnpm build` / `cargo check` 全绿。
