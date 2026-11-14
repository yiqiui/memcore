import type { MemoryStore } from "./store.js";

/** 后端工厂:dbPath 的含义由后端自定(文件路径 / 目录 / 连接串)。 */
export type BackendFactory = (dbPath: string) => Promise<MemoryStore> | MemoryStore;

const registry = new Map<string, BackendFactory>();

/**
 * 注册后端。第三方后端发布成 npm 包后,在其入口调用 registerBackend(name, factory),
 * 用户 `mem -b <name>` / MEMCORE_BACKEND=<name> 即可使用,core/CLI 无需任何改动。
 */
export function registerBackend(name: string, factory: BackendFactory): void {
  registry.set(name, factory);
}

export function listBackends(): string[] {
  return [...registry.keys()];
}

/** 判断名字是否像 npm 包名(带 scope 或路径)。 */
function looksLikePackage(name: string): boolean {
  return name.startsWith("npm:") || name.includes("/");
}

/**
 * 按名字打开后端。解析顺序:
 * 1. 已注册的工厂(内嵌 sqlite/file/memory + 各后端包 import 时的自注册)
 * 2. 名字像 npm 包 → 动态 import 该包(第三方后端)
 * 3. 约定名 `@memcore/<backend>` → 动态 import(官方后端包按需加载)
 * 都失败则列出当前可用后端并抛错。
 */
export async function openStore(backend: string, dbPath: string): Promise<MemoryStore> {
  let factory = registry.get(backend);
  if (!factory) {
    const candidates: string[] = [];
    if (looksLikePackage(backend)) {
      candidates.push(backend.startsWith("npm:") ? backend.slice(4) : backend);
    }
    candidates.push(`@memcore/${backend}`);
    for (const mod of candidates) {
      try {
        await import(/* @vite-ignore */ mod);
        factory = registry.get(backend);
        if (factory) break;
      } catch {
        // 模块不存在,继续尝试下一个候选
      }
    }
  }
  if (!factory) {
    throw new Error(
      `unknown backend: ${backend}\n` +
        `available: ${listBackends().join(", ")}\n` +
        `third-party: npm install <backend-package> then -b <package-name>`,
    );
  }
  return factory(dbPath);
}
