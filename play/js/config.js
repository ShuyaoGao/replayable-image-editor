/* =====================================================================
 * 名称与可替换文字集中在这里（第三方商标一律不出现在页面上）
 * 改名只改这一个文件；署名 / 学校 / 许可证在 credits.js（由 credits.json 生成）。
 * ===================================================================== */
window.APP_CONFIG = {
  APP_NAME: "可回放图像编辑器",
  APP_NAME_EN: "Replayable Image Editor",
  TAGLINE: "每一次修图操作都是一条数据：可导出、可回放、可逐像素复现",

  // 操作日志 session_start.params.app 写入的标识；导入时也接受旧版本写的标识
  LOG_APP_ID: "replayable-image-editor",
  LEGACY_APP_IDS: ["WebPS"],
  LOG_VERSION: 1,

  EXPORT_PREFIX: "replayable",             // 导出文件名前缀：<前缀>_ops_<时间>.jsonl / <前缀>_export.png
  DEFAULT_TEXT: "你好，可回放",
  // 文字工具可选字体：通用字体族放前面（跨系统更稳定）；后面是常见系统字体，只按名字引用、不随包分发
  FONTS: ["sans-serif", "serif", "monospace", "Microsoft YaHei", "SimSun", "SimHei", "PingFang SC",
          "Arial", "Georgia", "Consolas"],
};
