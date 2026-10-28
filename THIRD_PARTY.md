# 第三方依赖、素材与来源说明

## 浏览器页面（play/）

| 项目 | 说明 | 许可证 |
|---|---|---|
| 第三方 JavaScript 库 | **无**。`play/` 里的 HTML / CSS / JS 全部为本项目自写，不引用 CDN，不联网。 | — |
| 字体 | **不随包分发任何字体**。界面和文字工具只按名字引用系统已安装的字体（通用字体族 sans-serif / serif / monospace，以及 Microsoft YaHei、PingFang SC 等常见系统字体）；电脑上没有时由浏览器自动替换。 | 各字体归其权利人，本仓库不含字体文件 |
| 图标 | 工具栏图标是 Unicode 字符 / emoji，由操作系统自带字体渲染，本仓库不含图标图片。 | — |
| 示例图 | 「看回放」里的风景图完全由程序绘制（`play/js/demo.js` 里的渐变、形状、笔画、滤镜操作），没有使用任何照片或外部图片。 | 同本仓库（MIT / CC BY 4.0） |
| 截图 | `docs/img/` 下的截图由 `tools/browser_check.py` 用本机浏览器无头截取本页面。 | CC BY 4.0（同文档） |

## 参考的公开算法（只参考公式，没有复制代码）

| 用在哪里 | 出处 |
|---|---|
| 亮度、对比度、饱和度、色相旋转、去色的逐像素公式与颜色矩阵 | W3C *Filter Effects Module Level 1* 中同名滤镜的定义 |
| 高斯模糊：三次盒式模糊近似高斯 | 盒宽公式出自 P. Kovesi, *Fast Almost-Gaussian Filtering* (2010) |
| 画布指纹 | FNV-1a 32 位哈希（Fowler–Noll–Vo，公有领域算法） |
| 画质指标 | PSNR（峰值信噪比）的标准定义 |
| 坐标量化成离散 token | 思路参考 Pix2Seq（Chen et al., 2021）；本项目只用于展示，不含任何模型 |

## 开发与测试工具（不随 play/ 分发）

| 工具 | 用途 | 许可证 |
|---|---|---|
| Python 3 标准库 | `tools/` 构建、截图、打包脚本 | PSF License |
| pytest | 运行 `tests/` | MIT |
| Node.js | 运行 `tests/js/unit_tests.js`、导出示例日志（可选） | MIT（本体） |
| 本机已安装的 Microsoft Edge / Google Chrome | 无头自检与截图（不下载任何浏览器） | 各自的许可 |

## 商标

本项目是一个通用的教学用图像编辑器，与任何商业图像编辑软件及其厂商没有关联，也未获得其认可。
