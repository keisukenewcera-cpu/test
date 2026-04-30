import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

const isProdBuild = process.argv.includes('build')
const appBuildId = isProdBuild ? `b${Date.now()}-${Math.random().toString(36).slice(2, 10)}` : 'dev'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    isProdBuild && {
      name: 'workvision-version-json',
      closeBundle() {
        const dir = path.resolve(process.cwd(), 'dist')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ id: appBuildId }, null, 0))
      },
    },
  ].filter(Boolean),
  define: {
    __APP_BUILD_ID__: JSON.stringify(appBuildId),
  },
})
