// 离线假上下文：记录 apply() 注册了什么，不启动任何服务。
// 参考 .refs/DeepSeek-Bot/ds-bot/test/fake-ctx.js 的做法，全部用内存实现。
export function fakeContext({ services = {}, storage = true } = {}) {
  const calls = []
  const warnings = []
  const listeners = new Map()
  const sections = new Map()
  // 内存 KV 后端，实现 dsh-storage 的 KvFacet 切片
  const tables = new Map()
  const openedUnits = []
  const kvBackend = {
    kv: {
      async open(descriptor) {
        openedUnits.push(descriptor)
        if (!tables.has(descriptor.name)) tables.set(descriptor.name, new Map())
        const unitTables = tables.get(descriptor.name)
        return {
          async loadAll() {
            const out = {}
            for (const [name, records] of unitTables) out[name] = Object.fromEntries(records)
            return { tables: out, global: null }
          },
          async putRecord(table, key, value) {
            if (!unitTables.has(table)) unitTables.set(table, new Map())
            unitTables.get(table).set(key, value)
          },
          async deleteRecord(table, key) {
            unitTables.get(table)?.delete(key)
          },
          async close() {},
        }
      },
    },
    async close() {},
  }

  // agentPresets 假体：记录 register 的 definition 与返回的 disposer
  const presets = new Map()
  const agentPresets = {
    async register(definition) {
      calls.push(`preset register ${definition.id}`)
      presets.set(definition.id, definition)
      let disposed = false
      return async () => {
        disposed = true
        presets.delete(definition.id)
      }
    },
    async list() {
      return [...presets.values()].map((d) => ({ id: d.id, name: d.name, description: d.description }))
    },
    async mount(ctx, id) {
      calls.push(`preset mount ${id ?? '(default)'}`)
      return { id: id ?? Object.keys(presets)[0] }
    },
    async select(agent, id) {
      calls.push(`preset select ${id}`)
      return id
    },
  }

  const ctx = {
    calls,
    warnings,
    listeners,
    sections,
    presets,
    kvBackend,
    openedUnits,
    logger: {
      warn(message) {
        warnings.push(message)
      },
      info() {},
    },
    get(name) {
      return services[name]
    },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    effect(execute, label) {
      calls.push(`effect ${label}`)
      return execute()
    },
    agentPresets,
    systemPrompt: {
      section(section) {
        calls.push(`prompt ${section.name} ${section.order}`)
        sections.set(section.name, section)
        return () => {}
      },
    },
  }
  if (storage) ctx.storage = { backend: { register(name, backend) { return () => {} }, get(name) { if (name !== 'json') throw new Error(`unknown backend: ${name}`); return kvBackend }, names() { return ['json'] } } }
  return ctx
}
