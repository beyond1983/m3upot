import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// vite.config.ts 在 Node 环境运行，这里显式声明 process 类型，
// 避免在未安装 @types/node 时触发 TS2580 类型检查错误。
declare const process: { env: Record<string, string | undefined> }

// GitHub Pages 项目页地址形如 https://<user>.github.io/<repo>/，
// 静态资源需带 /<repo>/ 前缀才能正确加载；本地开发则保持根路径 '/'。
// 这两个值由 CI 在构建时通过环境变量注入（见 .github/workflows/deploy.yml）。
// 若使用自定义域名（顶级域名），请将 base 固定为 '/'，并删除 REPO_NAME 注入。
const isGitHubPages = process.env.GITHUB_PAGES === 'true'
const repoName = process.env.REPO_NAME || ''
const base = isGitHubPages ? `/${repoName}/` : '/'

export default defineConfig({
  base,
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    open: true,
    hmr: {
      clientPort: 5173
    }
  }
})
