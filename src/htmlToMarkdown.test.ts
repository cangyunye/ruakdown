import { describe, expect, it } from "vitest";
import { convertPasteHtml } from "./htmlToMarkdown";

describe("convertPasteHtml — block structure", () => {
  it("ATX headings", () => {
    expect(convertPasteHtml("<h1>标题</h1><h3>子标题</h3>").markdown).toBe(
      "# 标题\n\n### 子标题",
    );
  });

  it("paragraph, blockquote and hr", () => {
    expect(
      convertPasteHtml("<p>一段</p><blockquote><p>引用</p></blockquote><hr>").markdown,
    ).toBe("一段\n\n> 引用\n\n---");
  });

  it("nested lists", () => {
    const md = convertPasteHtml(
      "<ul><li>外层<ul><li>内层</li></ul></li><li>第二项</li></ul>",
    ).markdown;
    expect(md).toBe("- 外层\n    - 内层\n- 第二项");
  });

  it("ordered list keeps explicit numbering", () => {
    const md = convertPasteHtml(
      "<ol start=\"3\"><li>三</li><li>四</li></ol>",
    ).markdown;
    expect(md).toBe("3. 三\n4. 四");
  });

  it("fenced code block keeps the language class", () => {
    expect(
      convertPasteHtml(
        "<pre><code class=\"language-js\">const a = 1;</code></pre>",
      ).markdown,
    ).toBe("```js\nconst a = 1;\n```");
  });

  it("GFM table with a pipe inside a cell", () => {
    expect(
      convertPasteHtml(
        "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
          "<tbody><tr><td>1</td><td>x|y</td></tr></tbody></table>",
      ).markdown,
    ).toBe("| a | b |\n| --- | --- |\n| 1 | x\\|y |");
  });

  it("table cell <br> flattens instead of breaking the row", () => {
    const md = convertPasteHtml(
      "<table><thead><tr><th>k</th></tr></thead>" +
        "<tbody><tr><td>行一<br>行二</td></tr></tbody></table>",
    ).markdown;
    expect(md).toContain("| 行一<br>行二 |");
    expect(md.split("\n")).toHaveLength(3);
  });

  it("a table without thead promotes its first row to the header", () => {
    const md = convertPasteHtml(
      "<table><tbody><tr><td>阶段</td><td>状态</td></tr>" +
        "<tr><td>P1</td><td>完成</td></tr></tbody></table>",
    ).markdown;
    expect(md).toBe("| 阶段 | 状态 |\n| --- | --- |\n| P1 | 完成 |");
  });

  it("task list items", () => {
    expect(
      convertPasteHtml(
        "<ul>" +
          "<li><input type=\"checkbox\" checked>完成</li>" +
          "<li><input type=\"checkbox\">待办</li></ul>",
      ).markdown,
    ).toBe("- [x] 完成\n- [ ] 待办");
  });
});

describe("convertPasteHtml — inline content", () => {
  it("emphasis stays intact when adjacent to CJK characters", () => {
    expect(
      convertPasteHtml(
        "<p>中文<strong>粗体</strong>与<em>斜体</em>混排</p>",
      ).markdown,
    ).toBe("中文**粗体**与*斜体*混排");
  });

  it("inline link", () => {
    expect(
      convertPasteHtml(
        "<p><a href=\"https://example.com/a?b=1\">示例</a></p>",
      ).markdown,
    ).toBe("[示例](https://example.com/a?b=1)");
  });

  it("strikethrough uses double tildes", () => {
    expect(convertPasteHtml("<p><del>删了</del>和<s>删了</s></p>").markdown).toBe(
      "~~删了~~和~~删了~~",
    );
  });

  it("inline code escapes backticks by lengthening the fence", () => {
    // Content does not start/end with a backtick, so no space padding is
    // needed — the doubled fence alone keeps the inner backtick literal.
    expect(convertPasteHtml("<p><code>含`反引号</code></p>").markdown).toBe(
      "``含`反引号``",
    );
  });

  it("hard breaks from <br>", () => {
    expect(convertPasteHtml("<p>行一<br>行二</p>").markdown).toBe("行一\\\n行二");
  });

  it("ruakdown-native inline syntax: u / kbd / mark / sup", () => {
    expect(
      convertPasteHtml(
        "<p><u>下划</u><kbd>Ctrl</kbd><mark>高亮</mark>上<sup>标</sup></p>",
      ).markdown,
    ).toBe("<u>下划</u><kbd>Ctrl</kbd>==高亮==上<sup>标</sup>");
  });
});

describe("convertPasteHtml — safety and cleanup", () => {
  it("strips scripts, styles and event-bearing cruft", () => {
    const md = convertPasteHtml(
      "<p>正文</p><script>alert(1)</script><style>.x{}</style>",
    ).markdown;
    expect(md).toBe("正文");
  });

  it("javascript: links keep only the text", () => {
    expect(
      convertPasteHtml("<p><a href=\"javascript:alert(1)\">点</a></p>").markdown,
    ).toBe("点");
  });

  it("nbsp and zero-width characters normalize to plain text", () => {
    expect(convertPasteHtml("<p>a\u00A0b\u200Bc</p>").markdown).toBe("a bc");
  });

  it("Office StartFragment comments are removed", () => {
    const md = convertPasteHtml(
      "<!--StartFragment--><p>内容</p><!--EndFragment-->",
    ).markdown;
    expect(md).toBe("内容");
  });
});

describe("convertPasteHtml — images", () => {
  it("http images stay as markdown images", () => {
    expect(
      convertPasteHtml("<p><img src=\"https://e.com/a.png\" alt=\"图\"></p>").markdown,
    ).toBe("![图](https://e.com/a.png)");
  });

  it("base64 data images become archive placeholders with payloads", () => {
    // 4 bytes: 0x89 0x50 0x4E 0x47 (\x89PNG)
    const png = "iVBORw0KGgo=";
    const conv = convertPasteHtml(
      `<p><img src="data:image/png;base64,${png}"></p>`,
    );
    expect(conv.isMarkup).toBe(true);
    expect(conv.images).toHaveLength(1);
    expect(conv.images[0].mime).toBe("image/png");
    expect(conv.images[0].filename).toBe("image.png");
    expect(conv.images[0].placeholder).toBe("__rk_paste_0__.png");
    expect(conv.markdown).toBe(`![image.png](${conv.images[0].placeholder})`);
    expect(conv.images[0].bytes).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("an alt that already looks like a filename wins", () => {
    const conv = convertPasteHtml(
      "<p><img src=\"data:image/jpeg;base64,AA==\" alt=\"截图.jpg\"></p>",
    );
    expect(conv.images[0].filename).toBe("截图.jpg");
    expect(conv.images[0].mime).toBe("image/jpeg");
  });

  it("placeholder survives a full table context and is replaceable", () => {
    const conv = convertPasteHtml(
      "<table><thead><tr><th>图</th></tr></thead>" +
        "<tbody><tr><td><img src=\"data:image/png;base64,AA==\"></td></tr></tbody></table>",
    );
    const replaced = conv.markdown.split(conv.images[0].placeholder).join("assets/x.png");
    expect(replaced).toContain("assets/x.png");
    expect(replaced).not.toContain("__rk_paste_");
  });
});

describe("convertPasteHtml — fallback decisions", () => {
  it("plain-text HTML (editor copies) reports isMarkup=false", () => {
    const conv = convertPasteHtml(
      "<div style=\"color:#fff\"><span>hello</span></div><span>world</span>",
    );
    expect(conv.isMarkup).toBe(false);
    expect(conv.markdown).toBe("hello\nworld");
    expect(conv.images).toHaveLength(0);
  });

  it("VS Code style highlighted copies stay plain (native paste)", () => {
    const conv = convertPasteHtml(
      "<div class=\"line\"><span style=\"color:#569cd6\">const</span> a = 1;</div>",
    );
    expect(conv.isMarkup).toBe(false);
  });

  it("an empty body is not markup", () => {
    expect(convertPasteHtml("<html><body></body></html>").isMarkup).toBe(false);
  });
});
