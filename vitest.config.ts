import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)

const cjsPackages =
    /^(?:koishi|koishi-plugin-chatluna(?:\/.*)?|@langchain\/core(?:\/.*)?|zod)$/u

export default defineConfig({
    plugins: [
        {
            name: 'resolve-test-cjs-dependencies',
            enforce: 'pre',
            resolveId(source) {
                return cjsPackages.test(source) ? require.resolve(source) : null
            }
        }
    ],
    test: {
        include: ['tests/**/*.spec.ts'],
        globals: true,
        environment: 'node',
        pool: 'forks',
        fileParallelism: true,
        maxWorkers: 4,
        server: {
            deps: {
                external: [/node_modules/u]
            }
        },
        globalSetup: ['./tests/vitest-global-setup.ts'],
        testTimeout: 30_000,
        hookTimeout: 30_000
    }
})
