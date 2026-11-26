import { useT } from './i18n';
import type {
  AgentViewTab,
  Message,
  MessageAttachment,
  ModelEntry,
  ModelProvider,
  PortEntry,
  ReasoningEffort,
  TaskStatus,
  WorkspaceTab,
} from '@atelier/contracts';
import { Download, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { FloatingComposer } from './components/FloatingComposer';
import { FilePreviewProvider } from './components/FilePreviewModal';
import { setBootStage } from './components/BootLoader';
import { MeetingAppPrompt } from './components/MeetingAppPrompt';
import { MeetingRecorder } from './components/MeetingRecorder';
import { MeetingRecordingPill } from './components/MeetingRecordingPill';
import { PermissionApprovalModal } from './components/PermissionApprovalModal';
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
import { MeetingReadyCard, MeetingsView } from './views/MeetingsView';
import { PluginsView } from './views/PluginsView';
import { PreviewView } from './views/PreviewView';
import { RoomView } from './views/RoomView';
import { SettingsView, type SettingsTab } from './views/SettingsView';
import { TasksView } from './views/TasksView';

/**
 * Band behind the chat column: fully solid across the column itself (so cables never run behind
 * message text), then an eased (smoothstep) fade that always reaches nothing at <main>'s edges.
 *
 * The fade is placed relative to the band's own width: it starts at the edge and ends `solidHalf`
 * px from the centre, but is never longer than `maxFade`. On a narrow window the fade gets shorter
 * instead of being cut off mid-way, which used to leave a hard vertical edge on both sides.
 */
const CHAT_BAND_GRADIENT = (() => {
  const solidHalf = 350; // px from the centre that stay fully solid (chat column is 650px wide + padding)
  const maxFade = 340; // longest fade on each side, px
  const steps = 16;
  // Where the solid part begins / where the fade begins, measured from the left edge.
  const solidAt = `max(50% - ${solidHalf}px, 0px)`;
  const fadeAt = `max(50% - ${solidHalf + maxFade}px, 0px)`;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps; // 0 = edge (transparent), 1 = solid
    const alpha = t * t * (3 - 2 * t);
    const color = `rgba(13, 13, 17, ${alpha.toFixed(3)})`;
    const fromEdge = `(${fadeAt} + (${solidAt} - ${fadeAt}) * ${t.toFixed(4)})`;
    left.push(`${color} calc${fromEdge}`);
    right.unshift(`${color} calc(100% - ${fromEdge})`);
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
    cliApprovals,
    browserFrames,
    browserTakeovers,
    sttDownload,
    activeMeeting,
    meetingApp,
    dismissMeetingApp,
    meetingReady,
    dismissMeetingReady,
    appUpdate,
  } = useWorkspace();
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);

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
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [modal, setModal] = useState<ActiveModal>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  /** Meeting notes page; `meetingId` null shows the list. */
  const [meetingsPage, setMeetingsPage] = useState<{ meetingId: string | null; naming?: boolean } | null>(null);
  const pageOpen = pluginsOpen || meetingsPage !== null;
  const openPlugins = () => {
    setModal(null);
    setMeetingsPage(null);
    setPluginsOpen(true);
  };
  const openMeetings = (meetingId: string | null = null, naming = false) => {
    setModal(null);
    setPluginsOpen(false);
    setMeetingsPage({ meetingId, naming });
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
  const groupChatEnabled = state.settings.groupChat !== false;
  const activeProjectRoom = useMemo(
    () =>
      scopedProject && groupChatEnabled
        ? (state.channels?.find((c) => c.projectId === scopedProject.id && c.kind === 'room') ?? null)
        : null,
    [scopedProject, groupChatEnabled, state.channels],
  );
  const activeAgentDm = useMemo(
    () =>
      activeAgent
        ? ((state.channels ?? []).find((c) => c.kind === 'dm' && c.agentId === activeAgent.id) ?? null)
        : null,
    [state.channels, activeAgent],
  );
  const activeAgentDmSessions = useMemo(
    () => (activeAgentDm ? (state.roomSessions ?? []).filter((s) => s.channelId === activeAgentDm.id) : []),
    [state.roomSessions, activeAgentDm],
  );
  const activeRoomSessions = useMemo(
    () =>
      activeProjectRoom
        ? (state.roomSessions ?? []).filter((s) => s.channelId === activeProjectRoom.id)
        : [],
    [state.roomSessions, activeProjectRoom],
  );
  const activeRoomQueue = activeProjectRoom ? state.roomQueues?.[activeProjectRoom.id] ?? null : null;
  const defaultResponderAgent = useMemo(() => {
    if (!activeProjectRoom) return null;
    return (
      projectAgents.find((a) => a.id === activeProjectRoom.defaultResponderAgentId) ??
      projectAgents.find((a) => /chief of staff/i.test(a.role)) ??
      projectAgents[0] ??
      null
    );
  }, [activeProjectRoom, projectAgents]);

  useEffect(() => {
    if (scopedProject && groupChatEnabled && !activeProjectRoom) {
      void api.getProjectRoom(scopedProject.id).catch(() => undefined);
    }
  }, [scopedProject, groupChatEnabled, activeProjectRoom]);

  const handleSelectProject = (projectId: string) => {
    setViewMode('project');
    setActiveProjectId(projectId);
    setReplyTo(null);
    setReplyToMessageId(null);
    const proj = state.projects.find((p) => p.id === projectId);
    const firstAssignedId = proj?.agentIds?.[0] ?? state.agents.find((a) => a.projectId === projectId)?.id ?? null;
    setActiveAgentId(firstAssignedId);
  };

  const handleSelectProjectAgent = (agentId: string) => {
    setViewMode('project');
    setActiveAgentId(agentId);
    setReplyTo(null);
    setReplyToMessageId(null);
    setActiveTab('chat');
  };

  const handleSelectDirectAgent = (agentId: string) => {
    setViewMode('agent');
    setActiveDirectAgentId(agentId);
    setReplyTo(null);
    setReplyToMessageId(null);
    setAgentTab('chat');
  };

  const handleSend = async (
    text: string,
    attachments?: MessageAttachment[],
    skillIds?: string[],
    mentionAgentIds?: string[],
  ) => {
    if (!activeAgent) return;
    const quoted = replyTo?.replace(/\s+/g, ' ').trim().slice(0, 400);
    const quotedMsgId = replyToMessageId;
    setReplyTo(null);
    setReplyToMessageId(null);

    if (scopedProject && activeProjectRoom && groupChatEnabled) {
      await api.sendChannelMessage(activeProjectRoom.id, {
        text,
        mentionAgentIds,
        attachmentIds: attachments?.map((a) => a.id),
        skillIds,
        replyToMessageId: quotedMsgId ?? undefined,
      });
      return;
    }

    const payload = quoted && text ? `Replying to: "${quoted}"\n\n${text}` : text;
    await api.sendMessage(
      activeAgent.id,
      payload,
      scopedProject?.id ?? null,
      attachments?.map((a) => a.id),
      skillIds,
      mentionAgentIds,
    );
  };

  const handleForwardDmToProject = async (msg: Message, projectId: string) => {
    const dmChannel = state.channels?.find((c) => c.kind === 'dm' && c.agentId === msg.agentId);
    let roomChannel = state.channels?.find((c) => c.kind === 'room' && c.projectId === projectId);
    if (!roomChannel) {
      const res = await api.getProjectRoom(projectId);
      roomChannel = res.channel;
    }
    if (!dmChannel || !roomChannel) return;
    await api.forwardToChannel(roomChannel.id, dmChannel.id, [msg.id]);
    const proj = state.projects.find((p) => p.id === projectId);
    toast.success(tr('Forwarded to {name}', { name: proj?.name ?? 'project room' }));
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
    if (activeAgent) {
      await api.updateAgent(activeAgent.id, {
        providerOverride: entry.provider,
        modelOverride: entry.id,
      });
      if (activeAgent.status === 'working') {
        toast.info(
          tr('{agent} switched to {model} — applies next turn', {
            agent: activeAgent.name,
            model: entry.label,
          }),
        );
      } else {
        toast.success(
          tr('{agent} now using {model}', {
            agent: activeAgent.name,
            model: entry.label,
          }),
        );
      }
      return;
    }
    await api.updateSettings({
      provider: entry.provider,
      model: entry.id,
    });
  };

  const handleResetAgentModel = async () => {
    if (!activeAgent) return;
    await api.updateAgent(activeAgent.id, {
      providerOverride: null,
      modelOverride: null,
    });
    toast.info(tr('{agent} reset to workspace default model', { agent: activeAgent.name }));
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

  // Workspace state is in: let the start-up screen fade out.
  useEffect(() => {
    if (!loading) setBootStage('ready');
  }, [loading]);

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

  // Full pages (Plugins, Meetings) keep the cables and sit on the faded band like the chat does.
  const dimmedBackground =
    !pageOpen &&
    ((viewMode === 'project' && (activeTab === 'tasks' || activeTab === 'preview' || activeTab === 'library' || activeTab === 'browser')) ||
      (viewMode === 'agent' && (agentTab === 'reports' || agentTab === 'library' || agentTab === 'browser')));

  return (
    <FilePreviewProvider>
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
        onOpenMeetings={() => openMeetings(null)}
        meetingsActive={meetingsPage !== null}
        recording={activeMeeting?.meeting.status === 'recording'}
        updateAvailable={appUpdate?.state === 'available' || appUpdate?.state === 'downloading'}
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
        {appUpdate &&
          appUpdate.supported &&
          (appUpdate.state === 'available' || appUpdate.state === 'downloading') &&
          appUpdate.availableVersion !== dismissedUpdateVersion && (
            <div
              style={{
                alignSelf: 'center',
                width: '100%',
                maxWidth: 650,
                marginBottom: 8,
                padding: '8px 12px',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--surface-2)',
                border: '1px solid var(--agent-green)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <span style={{ color: 'var(--text-primary)', minWidth: 0 }}>
                {appUpdate.state === 'downloading'
                  ? `Mengunduh update Atelier v${appUpdate.availableVersion ?? ''}… ${appUpdate.progressPercent ?? 0}%`
                  : `Update Atelier v${appUpdate.availableVersion ?? ''} tersedia (terpasang v${appUpdate.currentVersion}).`}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={appUpdate.state === 'downloading'}
                  onClick={() => void api.installAppUpdate()}
                  style={{
                    height: 28,
                    padding: '0 11px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--action-primary)',
                    color: 'var(--action-primary-fg)',
                    fontSize: 12,
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    opacity: appUpdate.state === 'downloading' ? 0.7 : 1,
                  }}
                >
                  <Download size={13} strokeWidth={1.75} />
                  {appUpdate.state === 'downloading'
                    ? `${appUpdate.progressPercent ?? 0}%`
                    : 'Klik untuk Update'}
                </button>
                {appUpdate.state === 'available' && appUpdate.availableVersion && (
                  <button
                    type="button"
                    aria-label="Dismiss update banner"
                    onClick={() => setDismissedUpdateVersion(appUpdate.availableVersion)}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 'var(--radius-sm)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    <X size={14} strokeWidth={1.5} />
                  </button>
                )}
              </div>
            </div>
          )}
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
            {/* While a full page (Plugins, Meetings) is open the chat stays mounted but hidden, so
                the page can sit on the same faded band instead of a solid block with hard edges. */}
            <div style={{ display: 'contents', visibility: pageOpen ? 'hidden' : 'visible' }}>
            <ThreadHeader
              mode={viewMode}
              project={scopedProject}
              activeAgent={activeAgent}
              roomChannel={activeProjectRoom}
              roomAgents={projectAgents}
              roomQueue={activeRoomQueue}
              activeTab={activeTab}
              agentTab={agentTab}
              hasActiveBrowserSession={Boolean(
                activeAgent &&
                  browserSessions.some((s) => s.agentId === activeAgent.id && s.status !== 'closed'),
              )}
              onChangeTab={setActiveTab}
              onChangeAgentTab={setAgentTab}
              onSelectRoomAgent={(id) => setActiveAgentId(id)}
              onNewRoomSession={(carryover) => {
                if (!activeProjectRoom) return;
                void api
                  .startRoomSession(activeProjectRoom.id, carryover)
                  .then(() => toast.info(tr('Started new room session')));
              }}
              onStopRoom={() => {
                if (activeProjectRoom) void api.stopRoom(activeProjectRoom.id);
              }}
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
                    channel={activeAgentDm}
                    sessions={activeAgentDmSessions}
                    agent={activeAgent}
                    agents={state.agents}
                    projects={visibleProjects}
                    messages={state.messages}
                    activities={state.activities}
                    tasks={state.tasks}
                    settings={state.settings}
                    discoveredModels={discoveredModels}
                    onSelectAgent={handleSelectDirectAgent}
                    onReplyText={(quote) => setReplyTo(quote)}
                    onQuickSend={handleSend}
                    onForwardToProject={handleForwardDmToProject}
                    onRetryAgent={handleRetryAgent}
                    onDismissFallback={handleDismissFallback}
                    onOpenTask={(task) => setModal({ type: 'edit-task', taskId: task.id })}
                    onOpenEditAgent={() => setModal({ type: 'edit-agent', agentId: activeAgent.id })}
                    browserApprovals={browserApprovals}
                    cliApprovals={cliApprovals}
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
            ) : projectAgents.length > 0 && activeProjectRoom && groupChatEnabled ? (
              <RoomView
                project={activeProject}
                channel={activeProjectRoom}
                agents={projectAgents}
                messages={state.messages}
                sessions={activeRoomSessions}
                queue={activeRoomQueue}
                activities={state.activities}
                tasks={projectTasks}
                settings={state.settings}
                discoveredModels={discoveredModels}
                onReplyMessage={(m) => {
                  setReplyTo(m.text.slice(0, 120));
                  setReplyToMessageId(m.id);
                }}
                onQuickSend={(text) => handleSend(text)}
                onSkipTurn={async () => {
                  await api.skipRoomTurn(activeProjectRoom.id);
                }}
                onStopRoom={async () => {
                  await api.stopRoom(activeProjectRoom.id);
                }}
                onReorderQueue={async (order) => {
                  await api.reorderRoomQueue(activeProjectRoom.id, order);
                }}
                onApproveAction={async (messageId) => {
                  await api.approveRoomAction(activeProjectRoom.id, messageId);
                }}
                onContinueChain={async (rootMessageId) => {
                  await api.continueRoomChain(activeProjectRoom.id, rootMessageId);
                }}
                onRetryAgent={async (agentId, opts) => {
                  await api.retryAgent(agentId, opts);
                }}
                onCreateTaskFromReply={(description) =>
                  setModal({ type: 'new-task', description })
                }
                onOpenTask={(task) => setModal({ type: 'edit-task', taskId: task.id })}
                browserApprovals={browserApprovals}
                cliApprovals={cliApprovals}
                browserTakeovers={browserTakeovers}
                browserSessions={browserSessions}
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
                cliApprovals={cliApprovals}
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
              projectAgents={scopedProject ? projectAgents : undefined}
              roomMode={Boolean(scopedProject && activeProjectRoom && groupChatEnabled)}
              defaultResponderName={defaultResponderAgent?.name ?? null}
              settings={state.settings}
              discoveredModels={discoveredModels}
              draftText={draftText}
              replyTo={replyTo}
              onClearReply={() => {
                setReplyTo(null);
                setReplyToMessageId(null);
              }}
              onChangeDraft={setDraftText}
              onSend={handleSend}
              onStop={handleStop}
              onUpdateReasoning={handleUpdateReasoning}
              onSelectModel={handleSelectModel}
              onResetAgentModel={handleResetAgentModel}
              onNewTask={() => setModal({ type: 'new-task' })}
              onCompactContext={() => void handleCompactContext()}
              onOpenLinkRepo={() => setModal({ type: 'link-repo' })}
              onOpenModels={() => setModal({ type: 'settings', initialTab: 'providers' })}
              onOpenUsage={() => setModal({ type: 'usage' })}
              onOpenSettings={() => setModal({ type: 'settings', initialTab: 'general' })}
              onOpenPlugins={openPlugins}
              onOpenBrowserSettings={() => setModal({ type: 'settings', initialTab: 'browser' })}
            />
            </div>

            {/* While recording: the recorder floats at the bottom centre of the window, above every
                page; on the chat it sits just above the composer so typing stays possible. */}
            {activeMeeting?.meeting.status === 'recording' && (
              <MeetingRecorder
                event={activeMeeting}
                bottomOffset={pageOpen ? 24 : 112}
                onOpenSettings={() => setModal({ type: 'settings', initialTab: 'meeting' })}
              />
            )}

            {/* After Stop: a small status pill at the top, also above full pages. */}
            {activeMeeting && activeMeeting.meeting.status !== 'recording' && (
              <div
                style={{
                  position: 'absolute',
                  top: 54,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 35,
                }}
              >
                <MeetingRecordingPill event={activeMeeting} />
              </div>
            )}

            {meetingApp && (
              <MeetingAppPrompt
                event={meetingApp}
                settings={state.settings}
                onDismiss={dismissMeetingApp}
                onOpenSettings={() => setModal({ type: 'settings', initialTab: 'meeting' })}
              />
            )}

            {meetingReady && !meetingApp && (
              <MeetingReadyCard
                meeting={meetingReady}
                onOpen={() => openMeetings(meetingReady.id)}
                onNameSpeakers={() => openMeetings(meetingReady.id, true)}
                onDismiss={dismissMeetingReady}
              />
            )}

            {pageOpen && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 30,
                  display: 'flex',
                  flexDirection: 'column',
                  paddingTop: 4,
                }}
              >
                {pluginsOpen ? (
                  <PluginsView settings={state.settings} onBack={() => setPluginsOpen(false)} />
                ) : meetingsPage ? (
                  <MeetingsView
                    settings={state.settings}
                    activeMeeting={activeMeeting}
                    selectedId={meetingsPage.meetingId}
                    naming={meetingsPage.naming}
                    onSelect={(meetingId) => setMeetingsPage({ meetingId })}
                    onBack={() => setMeetingsPage(null)}
                    onOpenSettings={() => setModal({ type: 'settings', initialTab: 'meeting' })}
                  />
                ) : null}
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
          onDiscoveredModelsChange={setDiscoveredModels}
          sttDownload={sttDownload}
          appUpdate={appUpdate}
          initialTab={modal.initialTab ?? 'general'}
          onOpenMcp={openPlugins}
          onClose={() => setModal(null)}
        />
      )}

      {cliApprovals.length > 0 && <PermissionApprovalModal approvals={cliApprovals} />}
    </div>
    </FilePreviewProvider>
  );
}

export default App;
