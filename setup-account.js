#!/usr/bin/env node
'use strict';

/*
 * aiaha 账号设置工具（用于"自动登录续期"）
 * ------------------------------------------------------------
 * 双击"设置aiaha账号.bat"运行：按提示输入邮箱 + 密码。
 * 工具会先调用官方登录接口验证账号，成功才写入 config.json。
 * 你的密码只保存在本机 config.json，不会发送到除风月官方接口以外的任何地方。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_DOMAINS = ['https://aiaha.xyz', 'https://aipornhub.ltd'];

// 可见输入
function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve((a || '').trim())));
}

// 隐藏输入（密码不回显）
function askHidden(rl, q) {
  return new Promise((resolve) => {
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(q, (a) => {
      rl._writeToOutput = (s) => rl.output.write(s);
      process.stdout.write('\n');
      resolve((a || '').trim());
    });
    muted = true;
  });
}

function tokenDays(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    if (p.exp) return ((p.exp - Date.now() / 1000) / 86400).toFixed(1);
  } catch (e) {}
  return '?';
}

// 依次尝试各域名登录，成功返回 token
async function tryLogin(domains, email, password) {
  let lastMsg = '所有域名均无法连接';
  for (const base of domains) {
    try {
      const r = await fetch(base + '/console/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Accept': 'application/json',
          'Origin': base, 'Referer': base + '/', 'x-language': 'zh-Hans'
        },
        body: JSON.stringify({ email, password, remember_me: true, interface_language: 'zh-Hans' })
      });
      const j = await r.json().catch(() => null);
      const tok = j && (typeof j.data === 'string' ? j.data : (j.data && j.data.access_token) || j.access_token);
      if (tok && String(tok).split('.').length === 3) return { ok: true, token: tok, base };
      lastMsg = (j && (j.message || (typeof j.data === 'string' ? j.data : null))) || ('HTTP ' + r.status);
    } catch (e) { lastMsg = e.message; }
  }
  return { ok: false, msg: lastMsg };
}

(async function main() {
  console.log('');
  console.log('  === aiaha 账号设置（自动登录续期）===');
  console.log('  提示：密码只会保存在你本机的 config.json，用于 token 到期时自动续期。');
  console.log('');

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    console.log('  ❌ 读取 config.json 失败: ' + e.message);
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    await ask(rl0, '  按回车退出...'); rl0.close(); process.exitCode = 1; return;
  }

  const domains = (Array.isArray(cfg.domains) && cfg.domains.length) ? cfg.domains : DEFAULT_DOMAINS;
  const defEmail = cfg.email || '';

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const emailIn = await ask(rl, `  邮箱${defEmail ? '（直接回车用 ' + defEmail + '）' : ''}: `);
  const email = emailIn || defEmail;
  if (!email) { console.log('  未输入邮箱，已取消。'); rl.close(); return; }
  const password = await askHidden(rl, '  密码（输入时不显示，输完回车）: ');
  if (!password) { console.log('  未输入密码，已取消。'); rl.close(); return; }

  console.log('');
  console.log('  正在验证账号（' + domains[0] + ' 等镜像）...');
  const res = await tryLogin(domains, email, password);

  if (!res.ok) {
    console.log('  ❌ 验证失败: ' + res.msg);
    console.log('     账号未保存。请确认邮箱/密码正确后重试。');
    await ask(rl, ''); rl.close(); process.exitCode = 1; return;
  }

  // 备份并保存
  try { fs.writeFileSync(CONFIG_PATH + '.bak', fs.readFileSync(CONFIG_PATH)); } catch (e) {}
  cfg.email = email;
  cfg.password = password;
  cfg.auto_login = true;
  cfg.console_token = res.token; // 顺便把 token 也刷新了
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('  ✅ 账号已验证并保存成功（登录域名: ' + res.base + '）');
  console.log('     token 已顺带刷新，有效期约 ' + tokenDays(res.token) + ' 天。');
  console.log('     今后 token 到期会自动用此账号续期，无需再手动操作。');
  console.log('');
  console.log('  下一步：重新双击 “启动aiaha代理.bat” 即可生效。');
  console.log('');
  await ask(rl, '  按回车退出...'); rl.close();
})();
