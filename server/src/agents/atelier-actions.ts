import type { TurnCallbacks } from './runner.js';
import {
  CreateAgentToolSchema,
  CreateTaskToolSchema,
  MEMORY_ACTIONS,
  type MemoryAction,
  MessageAgentToolSchema,
  RunBrowserQaToolSchema,
  type StudioTools,
  UpdateTaskToolSchema,
} from './studio-tools.js';

export const ACTION_TAG_RE = /<atelier-action>\s*([\s\S]*?)\s*<\/atelier-action>/gi;

/**
 * Extracts and executes `<atelier-action>...</atelier-action>` blocks from model text
 * and returns the cleaned user-facing text with those blocks removed.
 */
export function applyAtelierActions(
  rawText: string,
  tools: StudioTools,
  cb: Pick<TurnCallbacks, 'onTool'>,
  opts?: { maxRecall?: number },
): { cleanText: string; actionsExecuted: number; recall: Array<{ tool: string; result: unknown }> } {
  let actionsExecuted = 0;
  const recall: Array<{ tool: string; result: unknown }> = [];
  const maxRecall = opts?.maxRecall ?? 3;

  const cleanText = rawText
    .replace(ACTION_TAG_RE, (_full, jsonPayload: string) => {
      try {
        const obj = JSON.parse(jsonPayload) as Record<string, unknown>;
        const toolName = typeof obj.tool === 'string' ? obj.tool : '';
        if (Object.hasOwn(MEMORY_ACTIONS, toolName)) {
          const isRecall =
            toolName === 'search_history' ||
            toolName === 'get_message' ||
            toolName === 'get_artifact' ||
            toolName === 'get_skill';
          if (isRecall && recall.length >= maxRecall) return '';
          const result = tools.memoryAction(toolName as MemoryAction, obj);
          if (isRecall) recall.push({ tool: toolName, result });
          cb.onTool(`atelier.${toolName}`, { key: obj.key, id: obj.id });
          actionsExecuted += 1;
        } else if (toolName === 'create_agent') {
          const parsed = CreateAgentToolSchema.parse(obj);
          const { agent } = tools.create_agent(parsed);
          cb.onTool('atelier.create_agent', { name: agent.name, role: agent.role });
          actionsExecuted += 1;
        } else if (toolName === 'create_task') {
          const parsed = CreateTaskToolSchema.parse(obj);
          const { task } = tools.create_task(parsed);
          cb.onTool('atelier.create_task', { identifier: task.identifier, title: task.title });
          actionsExecuted += 1;
        } else if (toolName === 'update_task') {
          const parsed = UpdateTaskToolSchema.parse(obj);
          const { task } = tools.update_task(parsed);
          cb.onTool('atelier.update_task', { identifier: task.identifier, status: task.status });
          actionsExecuted += 1;
        } else if (toolName === 'message_agent') {
          const parsed = MessageAgentToolSchema.parse(obj);
          tools.message_agent(parsed);
          cb.onTool('atelier.message_agent', { targetAgentId: parsed.targetAgentId });
          actionsExecuted += 1;
        } else if (toolName === 'run_browser_qa') {
          const parsed = RunBrowserQaToolSchema.parse(obj);
          const { url } = tools.run_browser_qa(parsed);
          cb.onTool('atelier.run_browser_qa', { url, watchLive: parsed.watchLive });
          actionsExecuted += 1;
        }
      } catch {
        // Ignore malformed action blocks
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleanText, actionsExecuted, recall };
}
