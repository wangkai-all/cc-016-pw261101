// 必须在任何 playwright import 之前执行（ESM 按导入顺序求值）
import path from 'node:path';
import fs from 'node:fs';

// 浏览器二进制放在工作区内，避免依赖会被清理的用户缓存目录
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(process.cwd(), '.playwright-browsers');

// 本环境无 root，浏览器所需的系统库解包在 .syslibs/，注入 LD_LIBRARY_PATH 供浏览器子进程使用
const syslibDirs = [
  path.resolve(process.cwd(), '.syslibs/usr/lib/x86_64-linux-gnu'),
  path.resolve(process.cwd(), '.syslibs/lib/x86_64-linux-gnu'),
].filter(d => fs.existsSync(d));
if (syslibDirs.length > 0) {
  process.env.LD_LIBRARY_PATH = [...syslibDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

// 本环境没有系统字体，fontconfig 找不到字体会让浏览器渲染表单控件时崩溃
const fontsConf = path.resolve(process.cwd(), '.syslibs/fonts.conf');
if (fs.existsSync(fontsConf)) {
  process.env.FONTCONFIG_FILE ??= fontsConf;
}
