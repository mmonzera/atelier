import {
  AGENT_TEMPLATES,
  BUILT_IN_SKILLS,
  MCP_PRESETS,
  type Agent,
  type McpServerConfig,
  type Project,
  type Task,
  type ThreadCompaction,
} from '@atelier/contracts';

/**
 * How agents present visual options. The web UI turns this block into clickable preview cards;
 * everything else in the reply stays normal markdown.
 */
const DESIGN_OPTIONS_GUIDE = [
  '',
  'Design options (visual previews in chat):',
  '- When the user asks for design directions, UI/layout options, mockups, logos or "show me options", present 2-4 alternatives as ONE block in your reply. Atelier renders it as preview cards the user can enlarge and pick from. Do not use it for trivial choices.',
  '- Format (not inside a markdown code fence):',
  '  <atelier-design title="Pick a direction" ask="Which one should I build?">',
  '  <atelier-option id="A" label="Scope chip" summary="One line what it is" pros="Short benefit" cons="Short trade-off" width="900" height="560">',
  '  <!doctype html><html>...complete page with inline <style>...</html>',
  '  </atelier-option>',
  '  <atelier-option id="B" label="Filter tabs" kind="svg"><svg viewBox="0 0 400 300">...</svg></atelier-option>',
  '  </atelier-design>',
  '- Each option must be fully self-contained: inline CSS (inline JS allowed), NO external URLs, fonts, CDNs or images (network is blocked in previews). Use realistic placeholder content, not lorem ipsum. Keep each option under ~150 lines.',
  '- kind="html" (default) for UI mockups, kind="svg" for logos/icons/illustrations, kind="image" src="<absolute path>" only for a PNG/JPG/WEBP file that you actually created inside the workspace with a tool (you cannot synthesize raster images yourself; if no image tool exists, use SVG or HTML/CSS instead).',
  '- Attribute values use double quotes and must not contain double quotes. Labels max 5 words; pros/cons one short sentence each.',
  '- After the block, add one short line asking which option to continue with. When the user replies with their choice, proceed with that option only.',
  '',
  'Attached files: user messages may list files under "[Attached files ...]". Open them with your file-reading tool (images can be viewed that way) before answering questions about them.',
].join('\n');

const ATELIER_HARNESS_PROTOCOL = [
  '',
  'Atelier Harness Coordination Protocol:',
  'You operate inside Atelier alongside a team of agents and a Linear-style Tasklist.',
  'When you want to create agents, update the Tasklist, or notify another agent, emit single-line XML action tags at the end of your reply:',
  '- Create or update a specialist bot in this project:',
  '  <atelier-action>{"tool":"create_agent","name":"Content Writer","role":"Copywriting","color":"blue","systemInstructions":"...","skillIds":["skill_ui_design"],"mcpServerNames":["notion"]}</atelier-action>',
  '- Create a new task (optionally dispatching immediately if dispatch=true; assigneeAgentId accepts bot ID or exact bot name):',
  '  <atelier-action>{"tool":"create_task","title":"...","description":"...","priority":"medium","assigneeAgentId":"agt_...","dispatch":true}</atelier-action>',
  '- Update an existing task (status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled"):',
  '  <atelier-action>{"tool":"update_task","taskId":"tsk_...","status":"in_review","branch":"...","prUrl":"https://...","deliverableSummary":"..."}</atelier-action>',
  '- Send a message/question to a teammate agent:',
  '  <atelier-action>{"tool":"message_agent","targetAgentId":"agt_...","message":"..."}</atelier-action>',
  '- Run automated real-browser E2E QA on the project Preview URL (headless by default; captures console errors, HTTP 4xx/5xx, and screenshots):',
  '  <atelier-action>{"tool":"run_browser_qa","url":"http://127.0.0.1:3000","watchLive":false,"steps":[{"action":"click","selector":"#submit"},{"action":"assertText","selector":"#status","value":"Saved"}]}</atelier-action>',
].join('\n');

function buildChiefOfStaffCatalog(allConfiguredMcp: McpServerConfig[]): string {
  const skillsCatalog = BUILT_IN_SKILLS.map((s) => `- ${s.id} (${s.name}): ${s.description}`).join(
    '\n',
  );
  const templatesCatalog = AGENT_TEMPLATES.filter((t) => t.id !== 'tpl_chief_of_staff')
    .map(
      (t) =>
        `- ${t.name} (${t.role}, color=${t.color}, allowShell=${t.allowShell}): defaultSkillIds=${JSON.stringify(t.defaultSkillIds)}`,
    )
    .join('\n');
  const configuredMcpLines =
    allConfiguredMcp.length > 0
      ? allConfiguredMcp
          .map(
            (m) =>
              `- ${m.name} (${m.transport}, enabled=${m.enabled})${m.description ? `: ${m.description}` : ''}`,
          )
          .join('\n')
      : 'No external MCP servers configured yet.';
  const presetsCatalog = MCP_PRESETS.filter(
    (p) => p.id !== 'custom-stdio' && p.id !== 'custom-http',
  )
    .map((p) => {
      const reqs = [
        ...(p.envKeys?.length ? [`env: ${p.envKeys.join(', ')}`] : []),
        ...(p.headerKeys?.length ? [`headers: ${p.headerKeys.join(', ')}`] : []),
        ...(p.argHint ? [`arg: ${p.argHint}`] : []),
      ];
      return `- ${p.name} (${p.transport}): ${p.description}${reqs.length ? ` [needs ${reqs.join('; ')}]` : ''}`;
    })
    .join('\n');

  return [
    '',
    'Chief of Staff Setup Catalog:',
    'Use these exact IDs/names when proposing or emitting `create_agent` actions:',
    '',
    'Built-in Skills (`skillIds`):',
    skillsCatalog,
    '',
    'Reference Bot Templates (customize freely for the user):',
    templatesCatalog,
    '',
    'Already Configured MCP Servers (`mcpServerNames`):',
    configuredMcpLines,
    '',
    'Available MCP Presets to Recommend (tell user to connect tokens in the MCP Connections button; NEVER invent tokens):',
    presetsCatalog,
    '',
    'Example `create_agent` action payload:',
    '<atelier-action>{"tool":"create_agent","name":"Content Writer","role":"Copywriting","color":"blue","systemInstructions":"You draft high-converting product copy aligned with brand voice...","skillIds":["skill_ui_design"],"customSkills":[{"name":"Brand Tone","description":"Voice guidelines","content":"# Brand Tone\\nKeep copy direct and crisp."}],"mcpServerNames":["notion"]}</atelier-action>',
  ].join('\n');
}

export function buildAgentSystemPrompt(
  agent: Agent,
  project: Project | null,
  teamAgents: Agent[],
  projectTasks: Task[],
  attachedMcp: McpServerConfig[] = [],
  allConfiguredMcp: McpServerConfig[] = [],
  agentProjects: Project[] = [],
  compaction?: ThreadCompaction | null,
): string {
  const enabledSkills = agent.skills.filter((s) => s.enabled);
  const skillsSection =
    enabledSkills.length > 0
      ? enabledSkills
          .map((s) => `## Skill: ${s.name}\n${s.content.trim()}`)
          .join('\n\n')
      : 'No extra skills installed.';

  const teamRoster =
    teamAgents.length > 0
      ? teamAgents
          .map(
            (a) =>
              `- ${a.name} (id: ${a.id}, role: ${a.role}, shell: ${a.allowShell ? 'enabled' : 'disabled'})${a.id === agent.id ? ' [YOU]' : ''}`,
          )
          .join('\n')
      : 'No other agents registered.';

  const relevantTasks = project
    ? projectTasks.filter(
        (t) => t.assigneeAgentId === agent.id && t.status !== 'done' && t.status !== 'cancelled',
      )
    : projectTasks.slice(0, 12);

  const projNameById = new Map(agentProjects.map((p) => [p.id, p.name]));
  const taskLines =
    relevantTasks.length > 0
      ? relevantTasks
          .map((t) => {
            const projPrefix = !project && projNameById.has(t.projectId)
              ? `${projNameById.get(t.projectId)} · `
              : '';
            const summary = t.deliverableSummary
              ? ` | Deliverable: ${t.deliverableSummary.slice(0, 120)}`
              : t.description
                ? ` — ${t.description.slice(0, 120)}`
                : '';
            return `- [${projPrefix}${t.identifier}] (${t.id}) [${t.status} | ${t.priority}] ${t.title}${summary}`;
          })
          .join('\n')
      : project
        ? 'No open tasks currently assigned to you.'
        : 'No project tasks assigned yet.';

  const mcpSection =
    attachedMcp.length > 0
      ? attachedMcp
          .map(
            (m) =>
              `- ${m.name} (${m.transport}): ${m.description || m.url || [m.command, ...(m.args ?? [])].join(' ')}`,
          )
          .join('\n')
      : 'No external MCP servers attached to this agent.';

  const headerLines = project
    ? [
        `You are "${agent.name}" (${agent.role}) in project "${project.name}".`,
        project.repo
          ? `Linked repository: ${project.repo.fullName} (default branch: ${project.repo.defaultBranch}, local path: ${project.repo.localPath}).`
          : 'No repository linked yet.',
      ]
    : [
        `You are "${agent.name}" (${agent.role}) in a Direct 1-on-1 conversation (outside any specific project).`,
        'You can help the user directly with ad-hoc requests, discuss status/reports from your projects below, or message any colleague bot directly via `message_agent` (even outside a project).',
        agentProjects.length > 0
          ? `Projects you are assigned to:\n${agentProjects
              .map(
                (p) =>
                  `- ${p.name} (id: ${p.id})${p.repo ? ` · repo: ${p.repo.fullName} (${p.repo.localPath})` : ''}`,
              )
              .join('\n')}`
          : 'Not assigned to any project yet.',
      ];

  const parts = [
    ...headerLines,
    agent.allowShell
      ? 'Shell/file editing tools are enabled in your workspace. Never push directly to the default branch.'
      : 'Shell execution is disabled for this agent; focus on planning, specs, design, or analysis.',
    '',
    'Custom Instructions:',
    agent.systemInstructions?.trim() || 'Follow the user instructions carefully and report concise deliverables.',
    '',
    'Installed Skills:',
    skillsSection,
    '',
    'Connected MCP tools:',
    mcpSection,
    '',
    project ? 'Team Roster:' : 'All Available Teammate Agents (can message_agent directly):',
    teamRoster,
    '',
    project ? 'Your Open Tasks:' : 'Your Project Tasks & Deliverables:',
    taskLines,
    ...(compaction?.summary?.trim()
      ? ['', 'Compacted Conversation Memory (earlier turns):', compaction.summary.trim()]
      : []),
    DESIGN_OPTIONS_GUIDE,
    ATELIER_HARNESS_PROTOCOL,
  ];

  if (/chief of staff/i.test(agent.role)) {
    parts.push(buildChiefOfStaffCatalog(allConfiguredMcp));
  }

  return parts.join('\n');
}
