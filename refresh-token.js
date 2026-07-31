#!/usr/bin/env node
'use strict';

/*
 * aiaha-proxy · console_token 一键刷新工具
 * ------------------------------------------------------------
 * 用途: token 到期(约30天)后，快速把新 token 写回 config.json，无需手改文件。
 *
 * 取 token 的方法(任选其一)：
 *   方式A(推荐, 配合"刷新token.bat")：
 *     1) 浏览器打开并登录 https://aiaha.xyz
 *     2) 按 F12 打开开发者工具 → 切到 Console(控制台)
 *     3) 粘贴这行并回车(会把 token 复制到剪贴板)：
 *          copy(localStorage.getItem('console_token'))
 *     4) 回到本工具按回车 —— 它会自动从剪贴板读取并写入
 *
 *   方式B：直接把 token 作为参数： node refresh-token.js <粘贴token>
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('readline');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function decodeJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload;
  } catch (e) { return null; }
}

function readClipboard() {
  try {
    // 固定参数 argv 数组调用，无用户输入拼接，避免 shell 注入
    const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
    return (out || '').trim();
  } catch (e) { return ''; }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve((ans || '').trim()); });
  });
}

function validate(token) {
  if (!token || token.split('.').length !== 3) return { ok: false, reason: '不是有效的 JWT(应包含两个"."号)' };
  const p = decodeJwt(token);
  if (!p) return { ok: false, reason: '无法解析 token 内容' };
  const now = Math.floor(Date.now() / 1000);
  if (p.exp && p.exp < now) return { ok: false, reason: 'token 已过期，请重新提取最新的' };
  const days = p.exp ? ((p.exp - now) / 86400) : null;
  return { ok: true, payload: p, daysLeft: days };
}

(async function main() {
  console.log('');
  console.log('  === aiaha-proxy · 刷新 console_token ===');
  console.log('');

  // 1) 获取 token：命令行参数 > 剪贴板 > 手动粘贴
  let token = (process.argv[2] || '').trim();
  let source = '命令行参数';
  if (!token) {
    token = readClipboard();
    source = '剪贴板';
  }
  if (token && token.split('.').length !== 3) {
    // 剪贴板里不是 token，转手动输入
    token = '';
  }
  if (!token) {
    console.log('  未从剪贴板检测到 token。');
    console.log('  请在浏览器 Console 里执行:  copy(localStorage.getItem(\'console_token\'))');
    console.log('  然后把它粘贴到下面(或直接回车重试读取剪贴板)。');
    console.log('');
    let input = await ask('  粘贴 token > ');
    if (!input) { input = readClipboard(); source = '剪贴板(重试)'; }
    token = input.trim();
  }

  // 2) 校验
  const v = validate(token);
  if (!v.ok) {
    console.log('');
    console.log('  ❌ 刷新失败: ' + v.reason);
    console.log('     token 来源: ' + source);
    console.log('');
    process.exitCode = 1;
    await ask('  按回车退出...');
    return;
  }

  // 3) 写回 config.json(先备份)
  let cfgRaw;
  try { cfgRaw = fs.readFileSync(CONFIG_PATH, 'utf8'); }
  catch (e) { console.log('  ❌ 读取 config.json 失败: ' + e.message); process.exitCode = 1; return; }

  let cfg;
  try { cfg = JSON.parse(cfgRaw); }
  catch (e) { console.log('  ❌ config.json 不是合法 JSON: ' + e.message); process.exitCode = 1; return; }

  const oldExp = validate(cfg.console_token || '');
  fs.writeFileSync(CONFIG_PATH + '.bak', cfgRaw, 'utf8');
  cfg.console_token = token;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('  ✅ token 已更新并写入 config.json (来源: ' + source + ')');
  console.log('     用户ID : ' + (v.payload.user_id || '?'));
  console.log('     新有效期: 约 ' + (v.daysLeft != null ? v.daysLeft.toFixed(1) : '?') + ' 天');
  if (oldExp.ok && oldExp.daysLeft != null) {
    console.log('     旧有效期: 约 ' + oldExp.daysLeft.toFixed(1) + ' 天(已备份为 config.json.bak)');
  }
  console.log('');
  console.log('  下一步: 重新双击 "启动aiaha代理.bat" 即可生效。');
  console.log('');
  await ask('  按回车退出...');
})();
