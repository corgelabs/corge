import {
  stepCountIs,
  streamText,
  tool as aiTool,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet
} from 'ai'
import { registerAttachmentTypes } from '../attachments'
import { CORE_CONFIG } from '../config'
import type { EntryId } from '../db'
import { Core } from '../index'
import { ChatContextEngine } from './context'
import {
  ReasoningExpertInputDto,
  ReasoningExpertOutputDto,
  webSearchInput,
  type AgentConfig,
  type AskAgentOptions,
  type ChatMessagePublic,
  type ContextEntry,
  type ContextItemSpec,
  type GetContextOptions,
  type HybridRetrievalOptions,
  type HybridRetrievalResult,
  type ListChatMessagesOptions,
  type RunAgentOptions,
  type VerifiedAgentToolContext,
  type WorkflowToolSpec
} from './schema'
import { ChatStreamEngine } from './stream'
import {
  buildDynamicContextBlock,
  extractLatestUserPrompt,
  FORBIDDEN_TOOL_SCHEMA_KEYS,
  isSafePublicUrl,
  sanitizeToolInputSchema
} from './utils'

const toolRegistry = new Map<string, WorkflowToolSpec>()
const agentRegistry = new Map<string, AgentConfig>()

export class ChatService {
  readonly #core: Core
  readonly #contextEngine: ChatContextEngine
  readonly #streamEngine: ChatStreamEngine

  constructor(coreClient: Core) {
    this.#core = coreClient
    this.#contextEngine = new ChatContextEngine(coreClient)
    this.#streamEngine = new ChatStreamEngine(coreClient, agentRegistry)
  }

  #registerWorkflowTool = (name: string, spec: WorkflowToolSpec): void => {
    toolRegistry.set(name, {
      ...spec,
      mcp: spec.mcp === true,
      tool: spec.tool !== false,
      input: sanitizeToolInputSchema(spec.input)
    })
  }

  #clearWorkflowTools = (): void => {
    toolRegistry.clear()
  }

  #getMcpTools = (): Map<string, WorkflowToolSpec> =>
    new Map([...toolRegistry.entries()].filter(([, spec]) => spec.mcp === true))

  #registerAgents = (defs: Record<string, AgentConfig>, reset = false): void => {
    if (reset) {
      agentRegistry.clear()
      registerAttachmentTypes(undefined, true)
    }
    for (const [id, cfg] of Object.entries(defs)) {
      agentRegistry.set(id, { ...cfg, name: cfg.name ?? id })
      if (cfg.attachmentTypes) registerAttachmentTypes(cfg.attachmentTypes)
    }
  }

  #getRegisteredAgents = (): Record<string, AgentConfig> => Object.fromEntries(agentRegistry)

  #getAgentRegistry = (): Map<string, AgentConfig> => agentRegistry

  getContext = (
    prompt: string,
    catalog?: readonly ContextItemSpec[],
    options?: GetContextOptions
  ): Promise<ContextEntry[]> => this.#contextEngine.getContext(prompt, catalog, options)

  retrieveContext = (opts: HybridRetrievalOptions): Promise<HybridRetrievalResult> =>
    this.#contextEngine.retrieveContext(opts)

  messages = (chatId: EntryId, opts?: ListChatMessagesOptions): Promise<ChatMessagePublic[]> =>
    this.#streamEngine.messages(chatId, opts)

  cancel = (chatId: EntryId): Promise<{ chatId: string; cancelled: true }> =>
    this.#streamEngine.cancel(chatId)

  #webSearchTool = (abortSignal?: AbortSignal) =>
    aiTool({
      description: 'Search the web (DuckDuckGo) or open a URL and read it as markdown. Use for current information.',
      inputSchema: webSearchInput,
      execute: async ({ query, url }) => {
        const useUrl = isSafePublicUrl(url)
        const target = useUrl ? url! : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query ?? url ?? '')}`
        const maxChars = useUrl ? 6000 : 4000
        try {
          const timeoutSignal = AbortSignal.timeout(20_000)
          const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal
          const jinaKey = this.#core.env.JINA_API_KEY
          const res = await fetch(`https://r.jina.ai/${target}`, {
            headers: {
              Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.8',
              ...(jinaKey ? { Authorization: `Bearer ${jinaKey}` } : {})
            },
            signal
          })
          if (!res.ok) return { text: `Web ${useUrl ? 'page' : 'search'} failed (HTTP ${res.status}).` }
          const reader = res.body?.getReader()
          if (!reader) return { text: '' }
          const decoder = new TextDecoder()
          let text = ''
          while (text.length < maxChars + 256) {
            const { done, value } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
          }
          await reader.cancel().catch(() => {})
          return { text: text.slice(0, maxChars).replace(/\s+\S*$/, '') }
        } catch {
          return { text: 'Web search failed.' }
        }
      }
    })

  #createReasoningExpertTool = (ctx: VerifiedAgentToolContext) =>
    aiTool({
      description:
        'Delegate complex architectural, legal, financial, or multi-constraint reasoning problems to a frontier reasoning model. Use only when standard analysis is insufficient.',
      inputSchema: ReasoningExpertInputDto,
      execute: async ({ problemStatement, constraintsAndContext }) => {
        const result = await ctx.core.ai.generate(
          `Problem:\n${problemStatement}\n\nConstraints & Context:\n${constraintsAndContext}`,
          {
            schema: ReasoningExpertOutputDto,
            model: CORE_CONFIG.models.vertexExpert ?? 'claude-sonnet-4-5',
            signal: ctx.abortSignal
          }
        )
        return result.output
      }
    })

  #buildAgentToolsForTurn = (toolKeys: string[] = [], ctx: VerifiedAgentToolContext): ToolSet => {
    const tools: ToolSet = {}
    const { core: turnCore, abortSignal } = ctx
    const coreState = {
      env: turnCore.env,
      userId: turnCore.userId,
      role: turnCore.role,
      step: turnCore.step
    }

    for (const name of toolKeys) {
      if (name === 'web_search') {
        tools[name] = this.#webSearchTool(abortSignal)
      } else if (name === 'consult_reasoning_expert') {
        tools[name] = this.#createReasoningExpertTool(ctx)
      } else {
        const wf = toolRegistry.get(name)
        if (wf && wf.tool !== false) {
          tools[name] = aiTool({
            description: wf.description,
            inputSchema: sanitizeToolInputSchema(wf.input),
            execute: (rawInput) =>
              this.#core.internals.context.run(coreState, async () => {
                const safeInput =
                  rawInput && typeof rawInput === 'object'
                    ? Object.fromEntries(
                        Object.entries(rawInput as Record<string, unknown>).filter(
                          ([k]) => !FORBIDDEN_TOOL_SCHEMA_KEYS.has(k)
                        )
                      )
                    : rawInput
                return wf.execute(safeInput, turnCore.userId)
              })
          })
        }
      }
    }
    return tools
  }

  #resolveStaticSystemPrompt = async (agent: AgentConfig): Promise<string> => {
    const raw =
      typeof agent.systemPrompt === 'function'
        ? await agent.systemPrompt({
            today: 'see dynamic context',
            userId: 'authenticated-user',
            env: this.#core.env
          })
        : agent.systemPrompt
    return raw
      .replace(/\s*Today is \{\{today\}\}\.?/gi, '')
      .replace(/\s*Current userId is \{\{userId\}\}\.?/gi, '')
      .replaceAll('{{today}}', 'see dynamic context')
      .replaceAll('{{userId}}', 'authenticated-user')
      .trim()
  }

  #resolveStepActiveTools = (agent: AgentConfig, allToolNames: string[], stepNumber: number): string[] => {
    if (allToolNames.length === 0) return []
    const presets = agent.toolPresets
    if (!presets) return allToolNames
    if (stepNumber === 0 && presets.discovery?.length && presets.workflow?.length) {
      return [...new Set([...presets.discovery, ...presets.workflow])].filter((k) => allToolNames.includes(k))
    }
    if (stepNumber > 0 && presets.workflow?.length) {
      return presets.workflow.filter((k) => allToolNames.includes(k))
    }
    return allToolNames
  }

  stream = async (
    agent: AgentConfig,
    messages: ModelMessage[],
    userId: EntryId = this.#core.userId,
    opts?: RunAgentOptions
  ): Promise<ReturnType<typeof streamText>> => {
    await this.#core.internals.payments.enforceAiQuota(userId)
    const [, staticCoreAgentInstructions] = await Promise.all([
      this.#core.internals.resilience.acquireLimit('ai'),
      this.#resolveStaticSystemPrompt(agent)
    ])

    const role = opts?.core?.role ?? this.#core.internals.auth.resolveUserRole(userId, this.#core.role)
    const verifiedCore = opts?.core ?? new Core({ env: this.#core.env, userId, role })
    const tools = this.#buildAgentToolsForTurn(agent.tools ?? [], {
      core: verifiedCore,
      chatId: opts?.chatId,
      abortSignal: opts?.abortSignal
    })
    const allToolNames = Object.keys(tools)

    const dynamicBlock = buildDynamicContextBlock({
      currentTimeIso: opts?.dynamicContext?.currentTimeIso ?? new Date().toISOString(),
      recalledMemories: opts?.dynamicContext?.recalledMemories,
      infobaseContextEntries: opts?.dynamicContext?.infobaseContextEntries,
      stagedAttachmentSummaries: opts?.dynamicContext?.stagedAttachmentSummaries,
      userContext: opts?.dynamicContext?.userContext
    })

    const systemInstructions: SystemModelMessage[] = [
      {
        role: 'system',
        content: staticCoreAgentInstructions,
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
          vertex: { cacheControl: { type: 'ephemeral' } }
        }
      },
      {
        role: 'system',
        content: dynamicBlock
      }
    ]

    const messagesForLlm: ModelMessage[] = messages.filter((m) => m.role !== 'system')
    const selectedModel = opts?.modelOverride || agent.model || CORE_CONFIG.models.vertex

    return streamText({
      model: this.#core.ai.languageModel(selectedModel),
      system: systemInstructions,
      messages: messagesForLlm,
      tools,
      ...(allToolNames.length > 0
        ? {
            activeTools: allToolNames,
            prepareStep: ({ stepNumber, messages: stepMessages }) => ({
              activeTools: this.#resolveStepActiveTools(agent, allToolNames, stepNumber),
              ...(stepNumber > 2 && stepMessages.length > CORE_CONFIG.limits.chatMessagesLimit
                ? { messages: stepMessages.slice(-CORE_CONFIG.limits.chatMessagesLimit) }
                : {})
            })
          }
        : {}),
      stopWhen: stepCountIs(agent.maxSteps ?? CORE_CONFIG.models.defaultAgentMaxSteps),
      ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      onFinish: async (event) => {
        const usageObj = (event as { totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).totalUsage ?? event.usage
        await this.#core.internals.payments.trackAiUsage({
          userId,
          model: selectedModel,
          inputTokens: usageObj?.inputTokens ?? 0,
          outputTokens: usageObj?.outputTokens ?? 0,
          ...(typeof usageObj?.totalTokens === 'number' ? { totalTokens: usageObj.totalTokens } : {}),
          source: 'chat'
        })
        await opts?.onFinish?.(event)
      }
    })
  }

  ask = async (
    agentOrId: string | AgentConfig,
    prompt: string | ModelMessage[],
    options?: AskAgentOptions
  ): Promise<{ text: string; messages: ModelMessage[] }> => {
    const agent = typeof agentOrId === 'string' ? agentRegistry.get(agentOrId) : agentOrId
    if (!agent) return this.#core.errors.httpError(404, `Unknown agent: ${String(agentOrId)}`, 'NOT_FOUND')

    const userId = options?.userId ?? this.#core.userId ?? CORE_CONFIG.auth.adminUserId
    const rawMessages: ModelMessage[] =
      typeof prompt === 'string' ? [{ role: 'user', content: [{ type: 'text', text: prompt }] }] : [...prompt]
    const latestPrompt = typeof prompt === 'string' ? prompt : extractLatestUserPrompt(rawMessages)

    const hybrid =
      options?.includeContext !== false
        ? await this.retrieveContext({
            userId,
            prompt: latestPrompt,
            useContext: agent.useContext !== false,
            agent,
            abortSignal: options?.abortSignal
          })
        : { recalledMemories: [], infobaseContextEntries: [], userContext: undefined }

    const turn = await this.stream(agent, rawMessages.slice(-15), userId, {
      abortSignal: options?.abortSignal,
      dynamicContext: {
        recalledMemories: hybrid.recalledMemories,
        infobaseContextEntries: hybrid.infobaseContextEntries,
        userContext: hybrid.userContext
      }
    })
    const [text, res] = await Promise.all([turn.text, turn.response])
    return {
      text,
      messages: [...rawMessages, ...(res.messages as unknown as ModelMessage[])]
    }
  }

  get internals() {
    return {
      registerWorkflowTool: this.#registerWorkflowTool,
      clearWorkflowTools: this.#clearWorkflowTools,
      getMcpTools: this.#getMcpTools,
      registerAgents: this.#registerAgents,
      getRegisteredAgents: this.#getRegisteredAgents,
      getAgentRegistry: this.#getAgentRegistry,
      registerContextCatalog: this.#contextEngine.registerContextCatalog,
      enforceAgentAccess: this.#streamEngine.enforceAgentAccess,
      stageAndScanAttachments: this.#streamEngine.stageAndScanAttachments,
      startChatStreamTurn: this.#streamEngine.startChatStreamTurn,
      saveChat: this.#streamEngine.saveChat,
      streamChatSse: this.#streamEngine.streamChatSse
    }
  }
}
