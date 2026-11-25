# 第三方声明

本项目包含以下第三方作品或其改编。

## Visual Studio Code（Code - OSS）

- 来源：<https://github.com/microsoft/vscode>
- 使用范围：
  - `sidecars/panel/public/modules/graph-layout.js`：泳道布局与图形绘制移植自 `src/vs/workbench/contrib/scm/browser/scmHistory.ts`，引用徽标归组移植自同目录 `scmHistoryViewPane.ts`；改为输出图形描述，并修改了根提交处的泳道保留规则（见文件头注释）。文件头内嵌下方许可全文，随插件安装分发。
  - `sidecars/panel/public/styles.css`：尺寸、间距与颜色取值参照 `scm.css`、`paneview.css`、`tree.css`、`actionbar.css`、`button.css`、`iconlabel.css`、`countBadge.css` 以及默认主题 `dark_modern.json`、`light_modern.json`。
  - `sidecars/panel/public/modules/file-icon-map.js`：部分映射取自 `extensions/*/package.json` 中内置语言声明的扩展名与文件名（提交 `25e7ea7b8ff47efaf5dd69ee2645f1ed1962ed2c`）。
  - `sidecars/panel/public/modules/markdown.js` 与 `graph-view.js` 的提交详情卡：分区结构、提交说明逐行分块规则与改动统计文案参照 `extensions/git/src/hover.ts`（同一提交），代码为重新实现。

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## VS Code Codicons

- 来源：<https://github.com/microsoft/vscode-codicons>，提交 `8d1826a9bce0a52283ecaeb63499c149e97a4f14`，作者 Microsoft Corporation
- 使用范围：`sidecars/panel/public/modules/codicons.js` 中的图标路径，由 `scripts/gen-codicons.mjs` 从 `src/icons/*.svg` 源文件提取 `path` 数据生成，图形未作修改；文件头注明作者与许可链接。插件图标 `assets/logo.svg` 使用其中的 `git-branch` 字形并改为灰色填充。
- 许可：Creative Commons Attribution 4.0 International（CC BY 4.0），<https://creativecommons.org/licenses/by/4.0/>

## vscode-icons

- 来源：<https://github.com/vscode-icons/vscode-icons>，提交 `dc003f665c8d91ee9ffb821b9064c6a79cff09c0`
- 使用范围：
  - `sidecars/panel/public/file-icons/*.svg`：文件类型与文件夹图标原样复制，只包含映射表用到的图标及其浅色变体。同目录的 `LICENSE` 为下方许可原文，随插件安装分发。
  - `sidecars/panel/public/modules/file-icon-map.js`：由 `scripts/gen-file-icons.mjs` 从 `src/iconsManifest/supportedExtensions.ts`、`languages.ts` 与 `supportedFolders.ts` 生成的文件名、扩展名与文件夹名映射。

```
The MIT License (MIT)

Copyright The vscode-icons Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
