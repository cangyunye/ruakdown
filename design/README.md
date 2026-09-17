# Ruakdown 应用图标

母版为 `app-icon.png`(1024×1024,RGBA),来源是 `icon2-source.png`(豆包 AI 生成稿)。
处理方式:裁出图标盘面(约 1200×1200)、按盘面真实圆角(r≈205/1200)加透明通道、重采样到 1024。
无矢量主稿;`app-icon.svg`(旧 R↓ 方案)已随设计变更删除。

修改图标后重新生成全套尺寸(`src-tauri/icons/`):

```sh
pnpm tauri icon design/app-icon.png
```

`preview-sizes.png` 为 256/128/64/32/20 尺寸在浅色/深色底上的可读性预览。
