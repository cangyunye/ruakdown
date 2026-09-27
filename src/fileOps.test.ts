import { describe, expect, it } from "vitest";
import type { TreeNode } from "./ipc";
import {
  assetDestDir,
  assetsRelDir,
  assetBaseName,
  entryNameError,
  ensureMdExt,
  findTreeNode,
  isImagePath,
  isInsideRoot,
  linkLabel,
  mdImageTag,
  mdLinkTag,
  pathBasename,
  pathDirname,
  pathJoin,
  relativeLinkHref,
  relativePathInRoot,
  stemOf,
  tsToken,
} from "./fileOps";

describe("path helpers", () => {
  it("basename/dirname handle both separators", () => {
    expect(pathBasename("F:\\vault\\sub\\a.md")).toBe("a.md");
    expect(pathBasename("/home/vault/a.md")).toBe("a.md");
    expect(pathDirname("F:\\vault\\a.md")).toBe("F:\\vault");
    expect(pathDirname("F:\\vault\\sub\\a.md")).toBe("F:\\vault\\sub");
  });

  it("join uses the directory separator", () => {
    expect(pathJoin("F:\\vault", "a.md")).toBe("F:\\vault\\a.md");
    expect(pathJoin("F:\\vault\\", "a.md")).toBe("F:\\vault\\a.md");
    expect(pathJoin("/vault", "a.md")).toBe("/vault/a.md");
    expect(pathJoin("", "a.md")).toBe("a.md");
  });

  it("isInsideRoot accepts only strict descendants", () => {
    expect(isInsideRoot("F:\\vault", "F:\\vault\\a.md")).toBe(true);
    expect(isInsideRoot("F:\\vault", "F:\\vault\\sub\\a.md")).toBe(true);
    expect(isInsideRoot("F:\\vault", "F:\\vault")).toBe(false);
    expect(isInsideRoot("F:\\vault", "F:\\vault2\\a.md")).toBe(false);
  });

  it("relativePathInRoot strips the root prefix", () => {
    expect(relativePathInRoot("F:\\vault", "F:\\vault\\a.md")).toBe("a.md");
    expect(relativePathInRoot("F:\\vault", "F:\\vault\\sub\\a.md")).toBe("sub\\a.md");
    // Outside the root (standalone file): fall back to the basename.
    expect(relativePathInRoot("F:\\vault", "C:\\other\\a.md")).toBe("a.md");
  });
});

describe("name helpers", () => {
  it("ensureMdExt appends .md once", () => {
    expect(ensureMdExt("笔记")).toBe("笔记.md");
    expect(ensureMdExt("笔记.md")).toBe("笔记.md");
    expect(ensureMdExt("笔记.MARKDOWN")).toBe("笔记.MARKDOWN");
  });

  it("stemOf strips the markdown suffix", () => {
    expect(stemOf("笔记.md")).toBe("笔记");
    expect(stemOf("a.b.markdown")).toBe("a.b");
    expect(stemOf("notes.txt")).toBe("notes.txt");
  });

  it("entryNameError mirrors the Rust rules and sibling check", () => {
    const siblings = ["a.md", "sub"];
    expect(entryNameError("新笔记", siblings)).toBeNull();
    expect(entryNameError("a.md", siblings)).toBe("已存在同名文件或文件夹");
    expect(entryNameError("A.MD", siblings)).toBe("已存在同名文件或文件夹");
    expect(entryNameError("", siblings)).not.toBeNull();
    expect(entryNameError("a/b", siblings)).not.toBeNull();
    expect(entryNameError("a:b", siblings)).not.toBeNull();
    expect(entryNameError("con", siblings)).not.toBeNull();
    expect(entryNameError("com1.md", siblings)).not.toBeNull();
    expect(entryNameError("console.md", siblings)).toBeNull();
  });
});

describe("findTreeNode", () => {
  const tree: TreeNode[] = [
    {
      name: "sub",
      path: "F:\\v\\sub",
      isDir: true,
      children: [{ name: "a.md", path: "F:\\v\\sub\\a.md", isDir: false, children: [] }],
    },
    { name: "b.md", path: "F:\\v\\b.md", isDir: false, children: [] },
  ];

  it("finds files in nested directories", () => {
    expect(findTreeNode(tree, "F:\\v\\sub\\a.md")?.name).toBe("a.md");
    expect(findTreeNode(tree, "F:\\v\\b.md")?.isDir).toBe(false);
    expect(findTreeNode(tree, "F:\\v\\missing.md")).toBeNull();
  });
});

describe("pasted-asset naming", () => {
  const noon = new Date(2026, 4, 4, 12, 0, 0); // local 2026-05-04 12:00:00

  it("tsToken formats local time zero-padded", () => {
    expect(tsToken(noon)).toBe("20260504120000");
    const single = new Date(2026, 0, 2, 3, 4, 5);
    expect(tsToken(single)).toBe("20260102030405");
  });

  it("assetBaseName uses the first 10 chars of the doc name (CJK counts per char)", () => {
    const doc = "F:\\v\\这是一个非常长的中文文档名称要点开.md";
    expect(assetBaseName(doc, "照片.JPG", noon)).toBe("这是一个非常长的中文_20260504120000.jpg");
    expect(assetBaseName("F:\\v\\my long document name.md", "pic.png", noon)).toBe(
      "my long do_20260504120000.png",
    );
  });

  it("assetBaseName cleans illegal chars and falls back without a doc", () => {
    expect(assetBaseName("F:\\v\\a<b>:c?.md", "x.png", noon)).toBe("abc_20260504120000.png");
    expect(assetBaseName(null, "x.webp", noon)).toBe("doc_20260504120000.webp");
    // No extension on the source → no extension on the asset.
    expect(assetBaseName("F:\\v\\a.md", "blob", noon)).toBe("a_20260504120000");
  });

  it("linkLabel prefers the sanitized stem and falls back", () => {
    expect(linkLabel("我的截图.png", "img")).toBe("我的截图");
    expect(linkLabel("a[b].md", "doc")).toBe("ab");
    expect(linkLabel("   .png", "img")).toBe("img");
  });

  it("isImagePath covers the archiveable image extensions", () => {
    expect(isImagePath("a.PNG")).toBe(true);
    expect(isImagePath("b.webp")).toBe(true);
    expect(isImagePath("c.svg")).toBe(true);
    expect(isImagePath("d.pdf")).toBe(false);
    expect(isImagePath("noext")).toBe(false);
  });

  it("assetsRelDir normalizes and defaults", () => {
    expect(assetsRelDir(null)).toBe("assets");
    expect(assetsRelDir("  ")).toBe("assets");
    expect(assetsRelDir("\\my\\assets\\")).toBe("my/assets");
    expect(assetsRelDir("/img")).toBe("img");
  });

  it("assetDestDir uses the workspace assets dir for in-root documents", () => {
    expect(assetDestDir("F:\\v", "F:\\v\\doc.md", null)).toBe("F:\\v\\assets");
    expect(assetDestDir("F:\\v", "F:\\v\\sub\\doc.md", "img")).toBe("F:\\v\\img");
  });

  it("assetDestDir parks next to the document outside the workspace", () => {
    expect(assetDestDir("F:\\v", "F:\\other\\doc.md", null)).toBe("F:\\other\\assets");
    expect(assetDestDir(null, "F:\\other\\doc.md", null)).toBe("F:\\other\\assets");
    expect(assetDestDir(null, null, null)).toBeNull();
  });
});

describe("relativeLinkHref", () => {
  it("stays ./ for documents at the workspace root", () => {
    expect(relativeLinkHref("F:\\v\\doc.md", "F:\\v\\assets\\a.jpg")).toBe("./assets/a.jpg");
    expect(relativeLinkHref("F:\\v\\doc.md", "F:\\v\\sub\\b.md")).toBe("./sub/b.md");
  });

  it("climbs with ../ for documents in subfolders", () => {
    expect(relativeLinkHref("F:\\v\\sub\\doc.md", "F:\\v\\assets\\a.jpg")).toBe("../assets/a.jpg");
    expect(relativeLinkHref("F:\\v\\a\\b\\doc.md", "F:\\v\\x.md")).toBe("../../x.md");
  });

  it("links between siblings and to the doc itself", () => {
    expect(relativeLinkHref("F:\\v\\sub\\a.md", "F:\\v\\sub\\b.md")).toBe("./b.md");
    expect(relativeLinkHref("F:\\v\\doc.md", "F:\\v\\doc.md")).toBe("./doc.md");
  });

  it("percent-encodes unsafe characters but keeps CJK readable", () => {
    expect(relativeLinkHref("F:\\v\\d.md", "F:\\v\\my pic (1).jpg")).toBe("./my%20pic%20%281%29.jpg");
    expect(relativeLinkHref("F:\\v\\d.md", "F:\\v\\笔记.md")).toBe("./笔记.md");
  });

  it("falls back to an absolute forward-slash path across drives", () => {
    expect(relativeLinkHref("F:\\v\\d.md", "C:\\other\\x.png")).toBe("C:/other/x.png");
  });

  it("builds markdown tags", () => {
    expect(mdImageTag("img", "./assets/a.jpg")).toBe("![img](./assets/a.jpg)");
    expect(mdLinkTag("指南", "./sub/guide.md")).toBe("[指南](./sub/guide.md)");
  });
});
