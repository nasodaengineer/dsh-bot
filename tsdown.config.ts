// 双目标打包（照 dsh-mmaping 验证过的形状，research/dsh-plugin-skeleton.md §2.8）：
// host：src/index.ts（+ 各模块单文件产物，供 node --test 按模块导入）→ lib/*.js（esm/node）
// client：src/client/index.ts → lib/client.js（cjs/browser，ModuleLoader 协议包裹）
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/identity.ts',
      'src/roster.ts',
      'src/persona.ts',
      'src/model.ts',
      'src/bot-tools.ts',
      'src/bot-credentials.ts',
      'src/bot-approval.ts',
      'src/schedules.ts',
      'src/agent-teams.ts',
      'src/taskboard.ts',
      'src/jev.ts',
      'src/groupchat.ts',
    ],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    dts: false,
  },
  {
    entry: ['src/client/index.ts'],
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    dts: false,
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: 'window.__ModuleLoader__.load({ id: "dsh-bot", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
