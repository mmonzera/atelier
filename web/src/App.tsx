import { useT } from './i18n';
import type {
  AgentViewTab,
  MessageAttachment,
  ModelEntry,
  ModelProvider,
  PortEntry,
  ReasoningEffort,
  TaskStatus,
  WorkspaceTab,
} from '@atelier/contracts';
import { Plus, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { FloatingComposer } from './components/FloatingComposer';
import { MeetingRecordingPill } from './components/MeetingRecordingPill';
import { PatternBackground } from './components/PatternBackground';
import { LeftRail } from './components/LeftRail';
import { RightPanel } from './components/RightPanel';
import { ThreadHeader } from './components/ThreadHeader';
import { toast } from './components/Toast';
import { AgentModal } from './components/modals/AgentModal';
import { TaskModal } from './components/modals/TaskModal';
import { UsageModal } from './components/modals/UsageModal';
import {
  LinkRepoModal,
  NewProjectModal,
  ProjectManageModal,
} from './components/modals/WorkspaceModals';
import { setLang } from './i18n';
import { useWorkspace } from './state/useWorkspace';
import { AgentReportsView } from './views/AgentReportsView';
import { BrowserView } from './views/BrowserView';
import { ChatView } from './views/ChatView';
import { LibraryView } from './views/LibraryView';
import { OnboardingView } from './views/OnboardingView';
import { PluginsView } from './views/PluginsView';
import { PreviewView } from './views/PreviewView';
import { SettingsView, type SettingsTab } from './views/SettingsView';
import { TasksView } from './views/TasksView';

/**
 * Band behind the chat column: fully solid across the column itself (so cables never run behind
 * message text), then an eased (smoothstep) fade to nothing on both sides so there is no visible edge.
 */
const CHAT_BAND_GRADIENT = (() => {
  const solidHalf = 350; // px from the centre that stay fully solid (chat column is 650px wide + padding)
  const fade = 340; // px over which the band melts away on each side
  const steps = 16;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps; // 0 = solid edge, 1 = fully transparent
    const alpha = 1 - t * t * (3 - 2 * t);
    const color = `rgba(13, 13, 17, ${alpha.toFixed(3)})`;
    const d = solidHalf + t * fade;
    left.unshift(`${color} calc(50% - ${d.toFixed(0)}px)`);
    right.push(`${color} calc(50% + ${d.toFixed(0)}px)`);
  }
  return `linear-gradient(to right, ${[...left, ...right].join(', ')})`;
})();

type ActiveModal =
  | { type: 'new-project' }
  | { type: 'link-repo' }
  | { type: 'new-agent' }
  | { type: 'new-global-agent' }
  | { type: 'edit-agent'; agentId: string }
  | { type: 'new-task'; status?: TaskStatus; assigneeAgentId?: string | null; description?: string }
  | { type: 'edit-task'; taskId: string }
  | { type: 'manage-project' }
  | { type: 'usage' }
  | { type: 'settings'; initialTab?: SettingsTab }
  | null;

export function App() {
  const tr = useT();
  const {
    state,
    connected,
    loading,
    browserSessions,
    browserApprovals,
    browserFrames,
    browserTakeovers,
    sttDownload,
    activeMeeting,
  } = useWorkspace();

  // the saved interface language (when one was chosen) follows the user across devices
  useEffect(() => {
    if (state.settings.language) setLang(state.settings.language);
  }, [state.settings.language]);

  const [viewMode, setViewMode] = useState<'project' | 'agent'>('project');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeDirectAgentId, setActiveDirectAgentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [agentTab, setAgentTab] = useState<AgentViewTab>('chat');
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [draftText, setDraftText] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [modal, setModal] = useState<ActiveModal>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const openPlugins = () => {
    setModal(null);
    setPluginsOpen(true);
  };
  const [discoveredModels, setDiscoveredModels] = useState<ModelEntry[]>([]);
  const [hostname, setHostname] = useState('Local Workstation');
  const [creatingSample, setCreatingSample] = useState(false);

  const visibleProjects = useMemo(
    () => state.projects.filter((p) => !p.archived),
    [state.projects],
  );

  const activeProject = useMemo(
    () => visibleProjects.find((p) => p.id === activeProjectId) ?? visibleProjects[0] ?? null,
    [visibleProjects, activeProjectId],
  );

  useEffect(() => {
    if (activeProject && activeProject.id !== activeProjectId) {
      setActiveProjectId(activeProject.id);
    } else if (!activeProject && activeProjectId) {
      setActiveProjectId(null);
    }
  }, [activeProject, activeProjectId]);

  const projectAgents = useMemo(() => {
    if (!activeProject) return [];
    const ids = activeProject.agentIds ?? [];
    if (ids.length > 0) {
      const byId = new Map(state.agents.map((a) => [a.id, a]));
      return ids.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
    }
    return state.agents.filter((a) => a.projectId === activeProject.id);
  }, [state.agents, activeProject]);

  const projectTasks = useMemo(
    () => (activeProject ? state.tasks.filter((t) => t.projectId === activeProject.id) : []),
    [state.tasks, activeProject],
  );

  const activeProjectAgent = useMemo(() => {
    if (!activeProject) return null;
    const found = projectAgents.find((a) => a.id === activeAgentId);
    if (found) return found;
    return projectAgents[0] ?? null;
  }, [activeProject, projectAgents, activeAgentId]);

  const activeDirectAgent = useMemo(() => {
    const found = state.agents.find((a) => a.id === activeDirectAgentId);
    return found ?? state.agents[0] ?? null;
  }, [state.agents, activeDirectAgentId]);

  useEffect(() => {
    if (activeProjectAgent && activeProjectAgent.id !== activeAgentId) {
      setActiveAgentId(activeProjectAgent.id);
    }
  }, [activeProjectAgent, activeAgentId]);

  useEffect(() => {
    if (activeDirectAgent && activeDirectAgent.id !== activeDirectAgentId) {
      setActiveDirectAgentId(activeDirectAgent.id);
    }
  }, [activeDirectAgent, activeDirectAgentId]);

  // If no projects exist yet but global agents do, default into Direct Agent view gracefully
  useEffect(() => {
    if (viewMode === 'project' && !activeProject && state.agents.length > 0) {
      setViewMode('agent');
    }
  }, [viewMode, activeProject, state.agents.length]);

  useEffect(() => {
    api
      .getOnboardingStatus()
      .then((s) => {
        if (s.hostname) setHostname(s.hostname);
      })
      .catch(() => null);
    api
      .getProvidersStatus()
      .then((res) => {
        if (res.discoveredModels) setDiscoveredModels(res.discoveredModels);
      })
      .catch(() => null);
  }, [state.settings.provider]);

  const activeAgent = viewMode === 'agent' ? activeDirectAgent : activeProjectAgent;
  const scopedProject = viewMode === 'project' ? activeProject : null;

  const handleSelectProject = (projectId: string) => {
    setViewMode('project');
    setActiveProjectId(projectId);
    setReplyTo(null);
    const proj = state.projects.find((p) => p.id === projectId);
    const firstAssignedId = proj?.agentIds?.[0] ?? state.agents.find((a) => a.projectId === projectId)?.id ?? null;
    setActiveAgentId(firstAssignedId);
  };

  const handleSelectProjectAgent = (agentId: string) => {
    setViewMode('project');
    setActiveAgentId(agentId);
    setReplyTo(null);
    setActiveTab('chat');
  };

  const handleSelectDirectAgent = (agentId: string) => {
    setViewMode('agent');
    setActiveDirectAgentId(agentId);
    setReplyTo(null);
    setAgentTab('chat');
  };

  const handleSend = async (text: string, attachments?: MessageAttachment[], skillIds?: string[]) => {
    if (!activeAgent) return;
    const quoted = replyTo?.replace(/\s+/g, ' ').trim().slice(0, 400);
    setReplyTo(null);
    const payload = quoted && text ? `Replying to: "${quoted}"\n\n${text}` : text;
    await api.sendMessage(
      activeAgent.id,
      payload,
      scopedProject?.id ?? null,
      attachments?.map((a) => a.id),
      skillIds,
    );
  };

  const handleStop = async () => {
    if (!activeAgent) return;
    await api.stopAgent(activeAgent.id);
  };

  const handleRetryAgent = async (opts?: {
    provider?: ModelProvider;
    model?: string;
    makeDefault?: boolean;
  }) => {
    if (!activeAgent) return;
    await api.retryAgent(activeAgent.id, opts);
  };

  const handleDismissFallback = async () => {
    if (!activeAgent) return;
    await api.dismissFallback(activeAgent.id);
  };

  const handleCompactContext = async () => {
    if (!activeAgent) return;
    try {
      const res = await api.compactAgent(activeAgent.id, scopedProject?.id ?? null);
      if (res.compacted) {
        toast.success(
          tr('Context compacted · {compactedCount} message{v1} summarized', { compactedCount: res.compactedCount, v1: res.compactedCount === 1 ? '' : 's' }),
        );
      } else {
        toast.info(tr('Nothing to compact yet — keep chatting first.'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tr('Failed to compact context'));
    }
  };

  const handleUpdateReasoning = async (reasoningEffort: ReasoningEffort) => {
    await api.updateSettings({ reasoningEffort });
  };

  const handleSelectModel = async (entry: ModelEntry) => {
    await api.updateSettings({
      provider: entry.provider,
      model: entry.id,
    });
  };

  const handleSavePreviewUrl = async (previewUrl: string | null) => {
    if (!activeProject) return;
    await api.updateProject(activeProject.id, { previewUrl });
  };

  const handleOpenPortPreview = async (port: PortEntry) => {
    if (!activeProject) return;
    if (activeProject.previewUrl !== port.url) {
      await api.updateProject(activeProject.id, { previewUrl: port.url });
    }
    setViewMode('project');
    setActiveTab('preview');
  };

  const handleAssignAgent = async (projectId: string, agentId: string) => {
    await api.assignAgentToProject(projectId, agentId);
    toast.success(tr('Agent assigned to project'));
  };

  const handleUnassignAgent = async (projectId: string, agentId: string) => {
    await api.unassignAgentFromProject(projectId, agentId);
    toast.info(tr('Agent unassigned from project'));
  };

  const handleOpenChiefOfStaff = async () => {
    if (!activeProject) {
      const res = await api.startChiefOfStaff();
      setViewMode('project');
      setActiveProjectId(res.project.id);
      setActiveAgentId(res.agent.id);
      setActiveTab('chat');
      return;
    }
    const existing =
      projectAgents.find((a) => /chief of staff/i.test(a.role)) ??
      state.agents.find((a) => /chief of staff/i.test(a.role));
    if (existing) {
      if (!activeProject.agentIds.includes(existing.id)) {
        await api.assignAgentToProject(activeProject.id, existing.id);
      }
      setViewMode('project');
      setActiveAgentId(existing.id);
      setActiveTab('chat');
      return;
    }
    const res = await api.startChiefOfStaff(activeProject.id);
    setViewMode('project');
    setActiveAgentId(res.agent.id);
    setActiveTab('chat');
  };

  const showOnboarding = !loading && state.settings.onboardingCompleted === false;

  const handleCreateSampleProject = async () => {
    setCreatingSample(true);
    try {
      const res = await api.createProject({ name: 'Atelier Workspace' });
      const proj = res.project;
      const firstAgentId = res.agents[0]?.id ?? state.agents[0]?.id ?? null;
      if (firstAgentId && !proj.agentIds.includes(firstAgentId)) {
        await api.assignAgentToProject(proj.id, firstAgentId);
      }
      await api.createTask(proj.id, {
        title: tr('Audit starter bots & plan first deliverable'),
        description:
          tr('Review each agent’s enabled skills and instructions, then break down the first milestone into actionable tasks.'),
        status: 'todo',
        priority: 'high',
        assigneeAgentId: firstAgentId,
      });
      setViewMode('project');
      setActiveProjectId(proj.id);
      if (firstAgentId) setActiveAgentId(firstAgentId);
      toast.success(tr('Sample workspace created'));
    } finally {
      setCreatingSample(false);
    }
  };

  const modalEditAgent =
    modal?.type === 'edit-agent'
      ? state.agents.find((a) => a.id === modal.agentId) ?? null
      : null;

  const modalEditTask =
    modal?.type === 'edit-task'
      ? state.tasks.find((t) => t.id === modal.taskId) ?? null
      : null;

  const modalEditTaskProject = modalEditTask
    ? state.projects.find((p) => p.id === modalEditTask.projectId) ?? activeProject
    : activeProject;

  const modalEditTaskAgents = modalEditTaskProject
    ? state.agents.filter((a) => modalEditTaskProject.agentIds.includes(a.id))
    : state.agents;

  const dimmedBackground =
    pluginsOpen ||
    (viewMode === 'project' && (activeTab === 'tasks' || activeTab === 'preview' || activeTab === 'library' || activeTab === 'browser')) ||
    (viewMode === 'agent' && (agentTab === 'reports' || agentTab === 'library' || agentTab === 'browser'));

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        padding: 12,
        gap: 12,
        background: 'var(--bg-base)',
      }}
    >
      <PatternBackground dimmed={dimmedBackground} />

      <LeftRail
        projects={state.projects}
        agents={state.agents}
        activeMode={viewMode}
        activeProjectId={activeProject?.id ?? null}
        activeDirectAgentId={activeDirectAgent?.id ?? null}
        rightPanelOpen={rightPanelOpen}
        onSelectProject={handleSelectProject}
        onSelectDirectAgent={handleSelectDirectAgent}
        onToggleRightPanel={() => setRightPanelOpen((v) => !v)}
        onOpenNewProject={() => setModal({ type: 'new-project' })}
        onOpenNewGlobalAgent={() => setModal({ type: 'new-global-agent' })}
        onOpenUsage={() => setModal({ type: 'usage' })}
        onOpenSettings={() => setModal({ type: 'settings' })}
        onOpenPlugins={openPlugins}
      />

      <main
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          zIndex: 10,
        }}
      >
        {/* Solid band behind the chat column, fading out sideways, so background cables never run
            behind message text. Sits at z-index -1 inside <main>'s own stacking context. */}
        {!dimmedBackground && !showOnboarding && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: -12,
              bottom: -12,
              left: '50%',
              width: '100%',
              transform: 'translateX(-50%)',
              zIndex: -1,
              pointerEvents: 'none',
              background: CHAT_BAND_GRADIENT,
            }}
          />
        )}
        {showOnboarding ? (
          <OnboardingView
            activeProject={activeProject}
            onStarted={(proj, agt) => {
              setViewMode('project');
              setActiveProjectId(proj.id);
              setActiveAgentId(agt.id);
              setActiveTab('chat');
            }}
            onDismissed={() => {
              // state updates via settings-changed WS broadcast
            }}
          />
        ) : (
          <>
            <ThreadHeader
              mode={viewMode}
              project={scopedProject}
              activeAgent={activeAgent}
              activeTab={activeTab}
              agentTab={agentTab}
              hasActiveBrowserSession={Boolean(
                activeAgent &&
                  browserSessions.some((s) => s.agentId === activeAgent.id && s.status !== 'closed'),
              )}
              onChangeTab={setActiveTab}
              onChangeAgentTab={setAgentTab}
              onEditAgent={() => {
                if (activeAgent) setModal({ type: 'edit-agent', agentId: activeAgent.id });
              }}
              onNewTask={() => setModal({ type: 'new-task' })}
              onCompactContext={() => void handleCompactContext()}
              onOpenChiefOfStaff={() => void handleOpenChiefOfStaff()}
              onOpenMcp={openPlugins}
              onOpenLinkRepo={() => setModal({ type: 'link-repo' })}
              onOpenProjectManage={() => setModal({ type: 'manage-project' })}
            />

            {viewMode === 'agent' ? (
              activeAgent ? (
                agentTab === 'library' ? (
                  <LibraryView projectId={null} agentId={activeAgent.id} refreshKey={state.messages.length} />
                ) : agentTab === 'browser' ? (
                  <BrowserView
                    agent={activeAgent}
                    sessions={browserSessions}
                    frames={browserFrames}
                    onOpenBrowserSettings={() => setModal({ type: 'settings', initialTab: 'browser' })}
                  />
                ) : agentTab === 'reports' ? (
                  <AgentReportsView
                    agent={activeAgent}
                    projects={state.projects}
                    tasks={state.tasks}
                    activities={state.activities}
                    onOpenTask={(task) => setModal({ type: 'edit-task', taskId: task.id })}
                    onOpenProject={(projId) => handleSelectProject(projId)}
                    onOpenAgentChat={() => setAgentTab('chat')}
                  />
                ) : (
                  <ChatView
                    project={null}
                    agent={activeAgent}
                    agents={state.agents}
                    messages={state.messages}
                    activities={state.activities}
                    tasks={state.tasks}
                    settings={state.settings}
                    discoveredModels={discoveredModels}
                    onSelectAgent={handleSelectDirectAgent}
                    onReplyText={(quote) => setReplyTo(quote)}
                    onQuickSend={handleSend}
                    onRetryAgent={handleRetryAgent}
                    onDismissFallback={handleDismissFallback}
                    onOpenTask={(task) => setModal({ type: 'edit-task', taskId: task.id })}
                    onOpenEditAgent={() => setModal({ type: 'edit-agent', agentId: activeAgent.id })}
                    browserApprovals={browserApprovals}
                    browserTakeovers={browserTakeovers}
                    browserSessions={browserSessions}
                    onOpenBrowserTab={() => setAgentTab('browser')}
                  />
                )
              ) : (
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    maxWidth: 650,
                    width: '100%',
                    margin: '0 auto',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    gap: 14,
                    padding: '0 16px',
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>{tr('No agents created yet')}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 440 }}>{tr('Create your first global agent to chat directly or assign it across multiple projects.')}
                  </div>
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'new-global-agent' })}
                    style={{
                      height: 34,
                      padding: '0 14px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--action-primary)',
                      color: 'var(--action-primary-fg)',
                      fontSize: 12.5,
                      fontWeight: 500,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Plus size={14} strokeWidth={1.75} />{tr('Add global agent')}
                  </button>
                </div>
              )
            ) : !activeProject ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  maxWidth: 650,
                  width: '100%',
                  margin: '0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                  gap: 16,
                  padding: '0 16px',
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {loading ? tr('Connecting to Atelier harness…') : tr('Welcome to Atelier')}
                </div>
                <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 480, lineHeight: '20px' }}>{tr('Create global agents you can chat with directly or assign across multiple projects, install markdown skills & MCP tools, and track every deliverable in a Linear-style tasklist.')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'new-project' })}
                    style={{
                      height: 36,
                      padding: '0 16px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--action-primary)',
                      color: 'var(--action-primary-fg)',
                      fontSize: 12.5,
                      fontWeight: 500,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Plus size={14} strokeWidth={1.75} />{tr('Create project')}
                  </button>

                  <button
                    type="button"
                    onClick={() => setModal({ type: 'new-global-agent' })}
                    style={{
                      height: 36,
                      padding: '0 16px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-1)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                      fontSize: 12.5,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Plus size={14} strokeWidth={1.5} />{tr('Add global agent')}
                  </button>

                  <button
                    type="button"
                    disabled={creatingSample}
                    onClick={() => void handleCreateSampleProject()}
                    style={{
                      height: 36,
                      padding: '0 16px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-1)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                      fontSize: 12.5,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Sparkles size={14} strokeWidth={1.5} />
                    {creatingSample ? tr('Creating…') : tr('Create sample workspace')}
                  </button>
                </div>
                {!connected && !loading && (
                  <div style={{ fontSize: 12, color: 'var(--agent-amber)' }}>{tr('Reconnecting to local WebSocket (/ws)…')}
                  </div>
                )}
              </div>
            ) : activeTab === 'tasks' ? (
              <TasksView
                project={activeProject}
                agents={projectAgents}
                tasks={projectTasks}
                onOpenNewTask={(opts) =>
                  setModal({
                    type: 'new-task',
                    status: opts?.status,
                    assigneeAgentId: opts?.assigneeAgentId,
                  })
                }
                onOpenTask={(task) => setModal({ type: 'edit-task', taskId: task.id })}
                onJumpToAgent={handleSelectProjectAgent}
              />
            ) : activeTab === 'library' ? (
              <LibraryView projectId={activeProject.id} refreshKey={state.messages.length} />
            ) : activeTab === 'browser' ? (
              <BrowserView
                agent={activeProjectAgent}
                sessions={browserSessions}
                frames={browserFrames}
                onOpenBrowserSettings={() => setModal({ type: 'settings', initialTab: 'browser' })}
              />
            ) : activeTab === 'preview' ? (
              <PreviewView
                project={activeProject}
                onSavePreviewUrl={handleSavePreviewUrl}
                onOpenTasks={() => setActiveTab('tasks')}
                onSendQaToAgent={(run) => {
                  const targetAgent = activeProjectAgent ?? projectAgents[0] ?? null;
                  if (!targetAgent) {
                    toast.info(tr('Assign an agent to this project first.'));
                    return;
                  }
                  const prompt = [
                    `Fix the issues detected by Browser QA on ${run.url}:`,
                    run.summary,
                    ...run.pageErrors.map((e) => `- PageError: ${e}`),
                    ...run.consoleErrors.map((e) => `- ConsoleError: ${e}`),
                    ...run.failedRequests.map((r) => `- HTTP ${r.status}: ${r.method} ${r.url}`),
                  ].join('\n');
                  setActiveTab('chat');
                  void api.sendMessage(targetAgent.id, prompt, activeProject.id);
                }}
              />
            ) : activeProjectAgent ? (
              <ChatView
                project={activeProject}
                agent={activeProjectAgent}
                agents={projectAgents}
                messages={state.messages}
                activities={state.activities}
                tasks={projectTasks}
                settings={state.settings}
                discoveredModels={discoveredModels}
                onSelectAgent={handleSelectProjectAgent}
                onReplyText={(quote) => setReplyTo(quote)}
                onQuickSend={handleSend}
                onRetryAgent={handleRetryAgent}
                onDismissFallback={handleDismissFallback}
                onCreateTaskFromReply={(description) =>
                  setModal({ type: 'new-task', description })
                }
                onOpenTask={(task) => setModal({ type: 'edit-task', taskId: task.id })}
                onOpenEditAgent={() =>
                  setModal({ type: 'edit-agent', agentId: activeProjectAgent.id })
                }
                browserApprovals={browserApprovals}
                browserTakeovers={browserTakeovers}
                browserSessions={browserSessions}
                onOpenBrowserTab={() => setActiveTab('browser')}
              />
            ) : (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  maxWidth: 650,
                  width: '100%',
                  margin: '0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                  gap: 14,
                  padding: '0 16px',
                }}
              >
                <div style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--text-primary)' }}>{tr('No agents assigned to')} {activeProject.name}{tr('yet')}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 460 }}>
                  {state.agents.length > 0 ? tr('Assign an existing global agent from the Agent team panel on the right, or create a brand new bot for this project.') : tr('Install your first custom bot from a template or define your own role, model override, and markdown skills.')}
                </div>
                <button
                  type="button"
                  onClick={() => setModal({ type: 'new-agent' })}
                  style={{
                    height: 34,
                    padding: '0 14px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--action-primary)',
                    color: 'var(--action-primary-fg)',
                    fontSize: 12.5,
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Plus size={14} strokeWidth={1.75} />{tr('Add custom agent')}
                </button>
              </div>
            )}

            <FloatingComposer
              project={scopedProject}
              agent={activeAgent}
              settings={state.settings}
              discoveredModels={discoveredModels}
              draftText={draftText}
              replyTo={replyTo}
              onClearReply={() => setReplyTo(null)}
              onChangeDraft={setDraftText}
              onSend={handleSend}
              onStop={handleStop}
              onUpdateReasoning={handleUpdateReasoning}
              onSelectModel={handleSelectModel}
              onNewTask={() => setModal({ type: 'new-task' })}
              onCompactContext={() => void handleCompactContext()}
              onOpenLinkRepo={() => setModal({ type: 'link-repo' })}
              onOpenModels={() => setModal({ type: 'settings', initialTab: 'providers' })}
              onOpenUsage={() => setModal({ type: 'usage' })}
              onOpenSettings={() => setModal({ type: 'settings', initialTab: 'general' })}
              onOpenPlugins={openPlugins}
              onOpenBrowserSettings={() => setModal({ type: 'settings', initialTab: 'browser' })}
            />

            {activeMeeting && (
              <div
                style={{
                  position: 'absolute',
                  top: 54,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 25,
                }}
              >
                <MeetingRecordingPill event={activeMeeting} />
              </div>
            )}

            {pluginsOpen && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 30,
                  display: 'flex',
                  flexDirection: 'column',
                  background: 'var(--bg-base)',
                  paddingTop: 4,
                }}
              >
                <PluginsView settings={state.settings} onBack={() => setPluginsOpen(false)} />
              </div>
            )}
          </>
        )}
      </main>

      {!showOnboarding && rightPanelOpen && (
        <RightPanel
          canon={(state.canon ?? []).filter((entry) => entry.projectId === (scopedProject?.id ?? null))}
          mode={viewMode}
          project={scopedProject}
          allProjects={state.projects}
          agents={projectAgents}
          allAgents={state.agents}
          activeAgent={activeAgent}
          tasks={state.tasks}
          ports={state.ports}
          settings={state.settings}
          hostname={hostname}
          onSelectProject={handleSelectProject}
          onSelectAgent={handleSelectProjectAgent}
          onSelectDirectAgent={handleSelectDirectAgent}
          onAddAgent={() => setModal({ type: 'new-agent' })}
          onAddGlobalAgent={() => setModal({ type: 'new-global-agent' })}
          onEditAgent={(agent) => setModal({ type: 'edit-agent', agentId: agent.id })}
          onAssignAgent={handleAssignAgent}
          onUnassignAgent={handleUnassignAgent}
          onNewTask={() => setModal({ type: 'new-task' })}
          onSelectTask={(task) => setModal({ type: 'edit-task', taskId: task.id })}
          onOpenReports={() => {
            setViewMode('agent');
            setAgentTab('reports');
          }}
          onOpenPortPreview={(p) => void handleOpenPortPreview(p)}
          onOpenLinkRepo={() => setModal({ type: 'link-repo' })}
          onOpenModels={() => setModal({ type: 'settings', initialTab: 'providers' })}
          onOpenMcp={openPlugins}
          onOpenSettings={() => setModal({ type: 'settings', initialTab: 'general' })}
        />
      )}

      {modal?.type === 'new-project' && (
        <NewProjectModal
          onClose={() => setModal(null)}
          onCreated={(p) => handleSelectProject(p.id)}
        />
      )}

      {modal?.type === 'link-repo' && activeProject && (
        <LinkRepoModal project={activeProject} onClose={() => setModal(null)} />
      )}

      {modal?.type === 'new-agent' && activeProject && (
        <AgentModal
          project={activeProject}
          existingAgent={null}
          settings={state.settings}
          discoveredModels={discoveredModels}
          onClose={() => setModal(null)}
          onSaved={(saved) => handleSelectProjectAgent(saved.id)}
          onOpenMcp={openPlugins}
          onOpenBrowserSettings={() => setModal({ type: 'settings', initialTab: 'browser' })}
        />
      )}

      {modal?.type === 'new-global-agent' && (
        <AgentModal
          project={null}
          existingAgent={null}
          settings={state.settings}
          discoveredModels={discoveredModels}
          onClose={() => setModal(null)}
          onSaved={(saved) => handleSelectDirectAgent(saved.id)}
          onOpenMcp={openPlugins}
          onOpenBrowserSettings={() => setModal({ type: 'settings', initialTab: 'browser' })}
        />
      )}

      {modal?.type === 'edit-agent' && modalEditAgent && (
        <AgentModal
          project={scopedProject}
          existingAgent={modalEditAgent}
          settings={state.settings}
          discoveredModels={discoveredModels}
          onClose={() => setModal(null)}
          onSaved={(saved) => {
            if (viewMode === 'agent') setActiveDirectAgentId(saved.id);
            else setActiveAgentId(saved.id);
          }}
          onDeleted={() => {
            if (viewMode === 'agent') setActiveDirectAgentId(null);
            else setActiveAgentId(null);
          }}
          onOpenMcp={openPlugins}
          onOpenBrowserSettings={() => setModal({ type: 'settings', initialTab: 'browser' })}
        />
      )}

      {modal?.type === 'new-task' && activeProject && (
        <TaskModal
          project={activeProject}
          agents={projectAgents.length > 0 ? projectAgents : state.agents}
          existingTask={null}
          defaultStatus={modal.status}
          defaultAssigneeId={
            modal.assigneeAgentId !== undefined
              ? modal.assigneeAgentId
              : (activeProjectAgent?.id ?? null)
          }
          defaultDescription={modal.description}
          onClose={() => setModal(null)}
          onJumpToAgent={handleSelectProjectAgent}
        />
      )}

      {modal?.type === 'edit-task' && modalEditTaskProject && modalEditTask && (
        <TaskModal
          project={modalEditTaskProject}
          agents={modalEditTaskAgents.length > 0 ? modalEditTaskAgents : state.agents}
          existingTask={modalEditTask}
          onClose={() => setModal(null)}
          onJumpToAgent={(id) => {
            if (modalEditTaskProject) {
              setViewMode('project');
              setActiveProjectId(modalEditTaskProject.id);
              setActiveAgentId(id);
              setActiveTab('chat');
            }
          }}
        />
      )}

      {modal?.type === 'manage-project' && activeProject && (
        <ProjectManageModal
          project={activeProject}
          onClose={() => setModal(null)}
          onDeleted={() => setActiveProjectId(null)}
        />
      )}

      {modal?.type === 'usage' && <UsageModal onClose={() => setModal(null)} />}

      {modal?.type === 'settings' && (
        <SettingsView
          settings={state.settings}
          activeProject={activeProject}
          discoveredModels={discoveredModels}
          sttDownload={sttDownload}
          initialTab={modal.initialTab ?? 'general'}
          onOpenMcp={openPlugins}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default App;
