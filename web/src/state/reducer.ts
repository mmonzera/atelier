import {
  DEFAULT_AUTO_COMPACT_SETTINGS,
  type Activity,
  type Agent,
  type Message,
  type PortEntry,
  type Project,
  type ServerEvent,
  type Settings,
  type Task,
  type WorkspaceState,
} from '@atelier/contracts';

const DEFAULT_SETTINGS: Settings = {
  provider: 'claude',
  model: 'sonnet',
  reasoningEffort: 'High',
  customModels: [],
  cliPaths: {},
  mcpServers: [],
  onboardingCompleted: true,
  autoCompact: DEFAULT_AUTO_COMPACT_SETTINGS,
};

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  projects: [],
  agents: [],
  messages: [],
  tasks: [],
  activities: [],
  ports: [],
  settings: DEFAULT_SETTINGS,
};

function upsertById<T extends { id: string }>(list: T[], item: T, prepend = false): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) {
    return prepend ? [item, ...list] : [...list, item];
  }
  const copy = list.slice();
  copy[idx] = item;
  return copy;
}

export function workspaceReducer(state: WorkspaceState, event: ServerEvent): WorkspaceState {
  switch (event.type) {
    case 'snapshot':
      return event.payload;
    case 'project-upserted':
      return { ...state, projects: upsertById<Project>(state.projects, event.payload) };
    case 'project-deleted':
      return {
        ...state,
        projects: state.projects.filter((p) => p.id !== event.payload.id),
        canon: state.canon?.filter((entry) => entry.projectId !== event.payload.id),
        messages: state.messages.filter((m) => m.projectId !== event.payload.id),
        tasks: state.tasks.filter((t) => t.projectId !== event.payload.id),
        activities: state.activities.filter((a) => a.projectId !== event.payload.id),
        ports: state.ports.filter((p) => p.projectId !== event.payload.id),
      };
    case 'agent-upserted':
      return { ...state, agents: upsertById<Agent>(state.agents, event.payload) };
    case 'agent-deleted':
      return {
        ...state,
        agents: state.agents.filter((a) => a.id !== event.payload.id),
        messages: state.messages.filter((m) => m.agentId !== event.payload.id),
        activities: state.activities.filter((a) => a.agentId !== event.payload.id),
      };
    case 'message-upserted':
      return { ...state, messages: upsertById<Message>(state.messages, event.payload) };
    case 'canon-upserted':
      return { ...state, canon: upsertById(state.canon ?? [], event.payload, true) };
    case 'canon-deleted':
      return { ...state, canon: state.canon?.filter((entry) => entry.id !== event.payload.id) };
    case 'message-delta': {
      const idx = state.messages.findIndex((m) => m.id === event.payload.id);
      if (idx === -1) return state;
      const copy = state.messages.slice();
      copy[idx] = { ...copy[idx], text: copy[idx].text + event.payload.delta };
      return { ...state, messages: copy };
    }
    case 'task-upserted':
      return { ...state, tasks: upsertById<Task>(state.tasks, event.payload, true) };
    case 'task-deleted':
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== event.payload.id),
      };
    case 'activity-added':
      return { ...state, activities: upsertById<Activity>(state.activities, event.payload) };
    case 'port-upserted':
      return { ...state, ports: upsertById<PortEntry>(state.ports, event.payload) };
    case 'settings-changed':
      return { ...state, settings: event.payload };
    default:
      return state;
  }
}
