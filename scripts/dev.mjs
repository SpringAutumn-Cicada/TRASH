import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
const env = { ...process.env };
if (branch === 'paper_analyze') {
  env.TRASH_PORT ??= '22225';
  env.TRASH_HOME ??= join(homedir(), '.local', 'share', 'trash-paper-analyze');
}
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}
function run(args) {
  return new Promise((resolve, reject) => {
    child = spawn('pnpm', args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      child = undefined;
      if (stopping) resolve();
      else if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} 已退出（${signal ?? code}）`));
    });
  });
}
try {
  console.log(`TRASH 分支：${branch}，地址：http://127.0.0.1:${env.TRASH_PORT ?? '22223'}`);
  if (env.TRASH_HOME) console.log(`数据目录：${env.TRASH_HOME}`);
  if (!existsSync(join(root, 'node_modules', '.modules.yaml'))) {
    console.log('首次启动：安装锁文件指定的依赖。');
    await run(['install', '--frozen-lockfile']);
  }
  if (!stopping) await run(['build']);
  if (!stopping) await run(['--filter', '@trash/server', 'dev']);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
