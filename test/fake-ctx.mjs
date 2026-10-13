// 离线假上下文：记录 apply() 注册了什么，不启动任何服务。
// 参考 .refs/DeepSeek-Bot/ds-bot/test/fake-ctx.js 的做法，全部用内存实现。
export function fakeContext({ services = {}, disable = [], storage = true } = {}) {
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
    // cordis 运行期可选依赖：到齐即执行，缺失则记录并跳过（不抛错）
    inject(names, callback) {
      const missing = names.filter((n) => services[n] === undefined)
      if (missing.length > 0) {
        calls.push(`inject skip [${names.join(',')}] missing=[${missing.join(',')}]`)
        return
      }
      const got = {}
      for (const n of names) got[n] = services[n]
      calls.push(`inject attach [${names.join(',')}]`)
      callback(got)
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

  // ---- P1 服务 mock（票 #6，签名对齐 0.2.1-alpha.2）----
  let selectModelCalls = 0
  services.sessionController = services.sessionController ?? {
    async selectModel(req) {
      selectModelCalls += 1
      calls.push(`selectModel provider=${req.provider} model=${req.model} session=${req.sessionId}`)
      return { selected: { provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort } }
    },
    calls: () => selectModelCalls,
  }
  services.llm = services.llm ?? {
    listProviders: () => [{ name: 'openai' }, { name: 'deepseek' }],
    listModels: async (provider) => [{ id: `${provider}-a` }, { id: `${provider}-b` }],
  }
  const registeredTools = new Map()
  services.tools = services.tools ?? {
    register(definition) {
      calls.push(`tool register ${definition.name}`)
      registeredTools.set(definition.name, definition)
      return () => {
        calls.push(`tool dispose ${definition.name}`)
        registeredTools.delete(definition.name)
      }
    },
  }
  ctx.registeredTools = registeredTools
  const credStore = services.__credStore ?? new Map()
  ctx.credStore = credStore
  services.credentials = services.credentials ?? {
    async resolve(ref) {
      calls.push(`cred resolve ${ref}`)
      const value = credStore.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    async describe(ref) {
      return { configured: credStore.has(ref), source: credStore.has(ref) ? 'test' : undefined }
    },
    async set(ref, value) {
      calls.push(`cred set ${ref}`)
      if (typeof value !== 'string' || value.trim() === '') throw new Error('credential value must be non-empty')
      credStore.set(ref, value)
    },
    async unset(ref) {
      credStore.delete(ref)
    },
    async listRecords() {
      return [...credStore.entries()].map(([ref, value]) => ({ ref, configured: true }))
    },
  }
  let answererAvailable = services.__answererAvailable ?? true
  ctx.setAnswererAvailable = (v) => { answererAvailable = v }
  services.approval = services.approval ?? {
    async request(req) {
      calls.push(`approval request ${req.toolName}`)
      // fail-closed：策略 'ask' 且无 answerer → 'unavailable'
      return answererAvailable ? 'allowed-once' : 'unavailable'
    },
    setPolicy() {},
  }
  services.permissionPresets = services.permissionPresets ?? {
    async catalog() {
      return [{ name: 'default' }, { name: 'safe' }, { name: 'trusted' }]
    },
    async current() {
      return { name: 'default' }
    },
    async set(_session, name) {
      calls.push(`preset set ${name}`)
      return name
    },
  }
  ctx.permissionPresets = services.permissionPresets
  let scheduleSeq = 0
  const schedules = []
  ctx.schedules = schedules
  services.schedule = services.schedule ?? {
    async create(sessionId, request) {
      scheduleSeq += 1
      calls.push(`schedule create ${request.title} session=${sessionId}`)
      const record = { id: `sch-${scheduleSeq}`, kind: 'recurring', title: request.title, prompt: request.prompt }
      schedules.push(record)
      return record
    },
    async list({ sessionId }) {
      calls.push(`schedule list session=${sessionId}`)
      return [...schedules]
    },
    async delete({ id }) {
      calls.push(`schedule delete ${id}`)
      const index = schedules.findIndex((s) => s.id === id)
      if (index < 0) return false
      schedules.splice(index, 1)
      return true
    },
  }

  // ---- connection mock（票 #12）：抓出 fetch.register 的路由，测试直接打 route.fetch ----
  const registeredRoutes = new Map()
  ctx.registeredRoutes = registeredRoutes
  services.connection = services.connection ?? {
    fetch: {
      register(route) {
        calls.push(`fetch register ${route.path}`)
        registeredRoutes.set(route.path, route)
        return () => {
          calls.push(`fetch unregister ${route.path}`)
          registeredRoutes.delete(route.path)
        }
      },
    },
  }
  ctx.connection = services.connection

  // disable：显式去掉某服务（模拟宿主未挂载，inject 走 skip 分支）
  for (const name of disable) delete services[name]

  if (storage) ctx.storage = { backend: { register(name, backend) { return () => {} }, get(name) { if (name !== 'json') throw new Error(`unknown backend: ${name}`); return kvBackend }, names() { return ['json'] } } }
  return ctx
}
