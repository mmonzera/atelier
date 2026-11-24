import {
  AGENT_COLORS,
  AGENT_TEMPLATES,
  BUILT_IN_MODELS,
  BUILT_IN_SKILLS,
  type Agent,
  type AgentAvatarShape,
  type AgentColor,
  type AgentSkill,
  type ModelEntry,
  type ModelProvider,
  type ModelRef,
  type Project,
  type Settings,
} from '@atelier/contracts';
import { Check, FileText, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { shownModels } from '../../state/models';
import { api } from '../../api';
import { BotMascot } from '../mascot/BotMascot';
import { MASCOT_COLORS, MASCOT_SHAPES, resolveMascotColor, resolveMascotShape } from '../mascot/mascotConfig';
import { Select } from '../Select';
import { toast } from '../Toast';
import {
  ModalShell,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './ModalShell';
import { McpIcon } from './McpIcon';

export function AgentModal({
  project = null,
  existingAgent,
  settings,
  discoveredModels = [],
  onClose,
  onSaved,
  onDeleted,
  onOpenMcp,
}: {
  project?: Project | null;
  existingAgent?: Agent | null;
  settings: Settings;
  discoveredModels?: ModelEntry[];
  onClose: () => void;
  onSaved: (agent: Agent) => void;
  onDeleted?: () => void;
  onOpenMcp?: () => void;
}) {
  const isEdit = Boolean(existingAgent);

  const [name, setName] = useState(existingAgent?.name ?? '');
  const [role, setRole] = useState(existingAgent?.role ?? '');
  const [color, setColor] = useState<AgentColor>(existingAgent?.color ?? 'blue');
  const [avatarShape, setAvatarShape] = useState<AgentAvatarShape>(
    existingAgent?.avatarShape ??
      (existingAgent ? resolveMascotShape(undefined, existingAgent.id) : 'triangle'),
  );
  const [allowShell, setAllowShell] = useState(existingAgent?.allowShell ?? true);
  const [systemInstructions, setSystemInstructions] = useState(
    existingAgent?.systemInstructions ?? '',
  );
  const [skills, setSkills] = useState<AgentSkill[]>(existingAgent?.skills ?? []);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>(existingAgent?.mcpServerIds ?? []);
  const [providerOverride, setProviderOverride] = useState<ModelProvider | ''>(
    existingAgent?.providerOverride ?? '',
  );
  const [modelOverride, setModelOverride] = useState<string>(existingAgent?.modelOverride ?? '');
  const [fallbackChain, setFallbackChain] = useState<ModelRef[]>(existingAgent?.fallbackChain ?? []);

  // Skill installer states
  const [localSkillPath, setLocalSkillPath] = useState('');
  const [importingFile, setImportingFile] = useState(false);
  const [writingCustomSkill, setWritingCustomSkill] = useState(false);
  const [customSkillName, setCustomSkillName] = useState('');
  const [customSkillDesc, setCustomSkillDesc] = useState('');
  const [customSkillContent, setCustomSkillContent] = useState('');

  const [activeTpl, setActiveTpl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allModels = useMemo(() => {
    const merged: ModelEntry[] = [];
    const seen = new Set<string>();
    for (const m of [...BUILT_IN_MODELS, ...discoveredModels, ...(settings.customModels ?? [])]) {
      const key = `${m.provider}:${m.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(m);
      }
    }
    return merged;
  }, [discoveredModels, settings.customModels]);

  const applyTemplate = (tplId: string) => {
    const tpl = AGENT_TEMPLATES.find((t) => t.id === tplId);
    if (!tpl) return;
    setName(tpl.name);
    setRole(tpl.role);
    setColor(tpl.color);
    setAvatarShape(tpl.avatarShape);
    setAllowShell(tpl.allowShell);
    setSystemInstructions(tpl.systemInstructions);
    setSkills(BUILT_IN_SKILLS.filter((s) => tpl.defaultSkillIds.includes(s.id)));
  };

  const installPresetSkill = (preset: AgentSkill) => {
    if (skills.some((s) => s.id === preset.id || s.name.toLowerCase() === preset.name.toLowerCase())) {
      return;
    }
    setSkills((prev) => [...prev, { ...preset, enabled: true }]);
  };

  const handleImportLocalSkill = async () => {
    const filePath = localSkillPath.trim();
    if (!filePath) return;
    setImportingFile(true);
    setError(null);
    try {
      const res = await api.readSkillFile(filePath);
      const nextSkill: AgentSkill = {
        id: `skill_${Date.now().toString(36)}`,
        name: res.skill.name,
        description: res.skill.description,
        content: res.skill.content,
        sourcePath: res.skill.sourcePath,
        enabled: true,
      };
      setSkills((prev) => [...prev, nextSkill]);
      setLocalSkillPath('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read skill file');
    } finally {
      setImportingFile(false);
    }
  };

  const handleAddCustomSkill = () => {
    if (!customSkillName.trim() || !customSkillContent.trim()) return;
    const nextSkill: AgentSkill = {
      id: `skill_${Date.now().toString(36)}`,
      name: customSkillName.trim(),
      description: customSkillDesc.trim(),
      content: customSkillContent.trim(),
      enabled: true,
    };
    setSkills((prev) => [...prev, nextSkill]);
    setCustomSkillName('');
    setCustomSkillDesc('');
    setCustomSkillContent('');
    setWritingCustomSkill(false);
  };

  const toggleSkill = (id: string) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  };

  const removeSkill = (id: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== id));
  };

  const toggleMcpServer = (id: string) => {
    setMcpServerIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !role.trim()) {
      setError('Agent name and role are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        role: role.trim(),
        color,
        avatarShape,
        allowShell,
        systemInstructions,
        skills,
        mcpServerIds,
        providerOverride: providerOverride ? providerOverride : null,
        modelOverride: modelOverride.trim() ? modelOverride.trim() : null,
        fallbackChain,
      };
      const res = isEdit && existingAgent
        ? await api.updateAgent(existingAgent.id, payload)
        : project
          ? await api.createAgent(project.id, payload)
          : await api.createGlobalAgent(payload);
      onSaved(res.agent);
      toast.success(isEdit ? `Saved changes to ${res.agent.name}` : `Agent “${res.agent.name}” created`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existingAgent) return;
    setSaving(true);
    try {
      await api.deleteAgent(existingAgent.id);
      toast.deleted(`Agent “${existingAgent.name}” removed`);
      onDeleted?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete agent');
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title={isEdit ? `Configure ${existingAgent?.name}` : 'Add custom agent'}
      subtitle="Define role, instructions, model override, and installable skills for this bot."
      width={680}
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* Openbot-style 3D Mascot Studio */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            padding: '10px 8px 6px',
            borderRadius: 'var(--radius-lg)',
            background: `radial-gradient(circle at 50% 24%, ${resolveMascotColor(color).hex}18 0%, rgba(255,255,255,0.015) 62%, transparent 100%)`,
          }}
        >
          <div
            title="Click to poke!"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              filter: `drop-shadow(0 12px 24px ${resolveMascotColor(color).hex}30)`,
            }}
          >
            <BotMascot
              size={112}
              color={color}
              shape={avatarShape}
              seed={existingAgent?.id ?? 'preview'}
              status={existingAgent?.status}
              interactive
              clickable
            />
          </div>

          {/* 18-color 2x9 swatch grid */}
          <div
            role="radiogroup"
            aria-label="Mascot color"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(9, 24px)',
              gap: 10,
              justifyContent: 'center',
            }}
          >
            {AGENT_COLORS.map((c) => {
              const spec = MASCOT_COLORS[c];
              const selected = color === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  title={spec.label}
                  onClick={() => setColor(c)}
                  className="transition-atelier"
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '9999px',
                    background: spec.hex,
                    boxShadow: selected
                      ? `0 0 0 2.5px var(--surface-1), 0 0 0 4px ${spec.hex}`
                      : 'inset 0 1px 1px rgba(255,255,255,0.22)',
                    transform: selected ? 'scale(1.08)' : 'scale(1)',
                  }}
                />
              );
            })}
          </div>

          {/* 12-shape 3D fuzzy mascot picker */}
          <div
            role="radiogroup"
            aria-label="Mascot shape"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: 6,
              marginTop: 2,
            }}
          >
            {MASCOT_SHAPES.map((item) => {
              const selected = avatarShape === item.id;
              const activeHex = resolveMascotColor(color).hex;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  title={item.label}
                  onClick={() => setAvatarShape(item.id)}
                  className="mascot-shape-btn transition-atelier"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: selected ? `${activeHex}22` : 'transparent',
                    border: selected ? `1.5px solid ${activeHex}` : '1px solid transparent',
                  }}
                >
                  <BotMascot
                    size={30}
                    color={selected ? color : item.showcaseColor}
                    shape={item.id}
                    interactive={false}
                    hoverAnimate
                    active={selected}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Starter presets */}
        {!isEdit && (
          <Section title="Start from a preset" hint="Optional. Fills in everything below.">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
              {AGENT_TEMPLATES.map((tpl) => {
                const on = activeTpl === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setActiveTpl(tpl.id);
                      applyTemplate(tpl.id);
                    }}
                    className="transition-atelier"
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      background: on ? 'var(--surface-3)' : 'var(--surface-2)',
                      border: `1px solid ${on ? 'rgba(255,255,255,0.22)' : 'var(--border-subtle)'}`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      minWidth: 0,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <BotMascot
                        size={24}
                        color={tpl.color}
                        shape={tpl.avatarShape}
                        interactive={false}
                      />
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                        {tpl.name}
                      </span>
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        color: 'var(--text-tertiary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {tpl.role}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {/* Identity */}
        <Section title="Identity">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Agent name</label>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Tyr, QA Reviewer, Architect"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Role / specialty</label>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Backend API & Tests"
                style={inputStyle}
              />
            </div>
          </div>
        </Section>

        {/* Model & permissions */}
        <Section title="Model & permissions">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Provider</label>
              <Select
                ariaLabel="Provider"
                value={providerOverride}
                onChange={(v) => {
                  const next = v as ModelProvider | '';
                  setProviderOverride(next);
                  if (!next) setModelOverride('');
                }}
                options={[
                  { value: '', label: `Workspace default (${settings.provider})` },
                  { value: 'claude', label: 'Claude' },
                  { value: 'openai', label: 'ChatGPT' },
                  { value: 'antigravity', label: 'Antigravity' },
                  { value: 'deepseek', label: 'DeepSeek' },
                  { value: 'openrouter', label: 'OpenRouter' },
                  { value: 'opencode', label: 'OpenCode' },
                ]}
              />
            </div>
            <div>
              <label style={labelStyle}>Model</label>
              <Select
                ariaLabel="Model"
                value={modelOverride}
                onChange={(val) => {
                  setModelOverride(val);
                  const found = allModels.find((m) => m.id === val);
                  if (found) setProviderOverride(found.provider);
                }}
                options={[
                  { value: '', label: `Workspace default (${settings.model})` },
                  ...shownModels(allModels, settings, {
                    provider: providerOverride,
                    model: modelOverride,
                  })
                    .filter((m) => !providerOverride || m.provider === providerOverride)
                    .map((m) => ({ value: m.id, label: m.label, hint: m.provider })),
                ]}
              />
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              padding: '11px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                Backup models (optional override)
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {fallbackChain.length === 0 ? 'Inherits workspace chain' : `${fallbackChain.length} configured`}
              </span>
            </div>
            {fallbackChain.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {fallbackChain.map((item, idx) => {
                  const label =
                    allModels.find((m) => m.provider === item.provider && m.id === item.model)
                      ?.label ?? item.model;
                  return (
                    <span
                      key={`${item.provider}:${item.model}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 8px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--surface-1)',
                        border: '1px solid var(--border-subtle)',
                        fontSize: 11.5,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span className="mono-num" style={{ color: 'var(--text-muted)' }}>
                        #{idx + 1}
                      </span>
                      <span style={{ color: 'var(--text-primary)' }}>{label}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setFallbackChain((prev) => prev.filter((_, i) => i !== idx))
                        }
                        title="Remove"
                        style={{ color: 'var(--text-muted)', display: 'inline-flex' }}
                      >
                        <Trash2 size={11} strokeWidth={1.5} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            {fallbackChain.length < 5 && (
              <Select
                ariaLabel="Add agent backup model"
                value=""
                placeholder="Add backup model override…"
                onChange={(val) => {
                  const [prov, ...rest] = val.split(':');
                  const modId = rest.join(':');
                  if (!prov || !modId) return;
                  if (fallbackChain.some((c) => c.provider === prov && c.model === modId)) return;
                  setFallbackChain((prev) => [
                    ...prev,
                    { provider: prov as ModelProvider, model: modId },
                  ]);
                }}
                options={shownModels(allModels, settings)
                  .filter(
                    (m) => !fallbackChain.some((c) => c.provider === m.provider && c.model === m.id),
                  )
                  .map((m) => ({
                    value: `${m.provider}:${m.id}`,
                    label: m.label,
                    hint: m.provider,
                  }))}
              />
            )}
          </div>

          <div
            style={{
              marginTop: 12,
              padding: '11px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                Shell & code editing
              </div>
              <div style={{ fontSize: 11.5, lineHeight: '16px', color: 'var(--text-tertiary)', marginTop: 2 }}>
                Lets the agent run commands and edit files in the repository workspace. Turn off for
                read-only or spec-writing bots.
              </div>
            </div>
            <Switch checked={allowShell} onChange={setAllowShell} label="Allow shell and code editing" />
          </div>
        </Section>

        {/* System instructions */}
        <Section title="System instructions">
          <textarea
            rows={4}
            value={systemInstructions}
            onChange={(e) => setSystemInstructions(e.target.value)}
            placeholder="Persona rules, coding conventions, output format, constraints…"
            style={{ ...inputStyle, resize: 'vertical', lineHeight: '19px' }}
          />
        </Section>

        {/* Skills */}
        <Section
          title="Skills"
          count={`${skills.filter((s) => s.enabled).length}/${skills.length}`}
          action={
            <button
              type="button"
              onClick={() => setWritingCustomSkill((v) => !v)}
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Plus size={12} strokeWidth={1.5} />
              Write custom skill
            </button>
          }
        >
          {skills.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {skills.map((sk) => (
                <div
                  key={sk.id}
                  style={{
                    padding: '9px 12px',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    opacity: sk.enabled ? 1 : 0.6,
                  }}
                >
                  <Switch checked={sk.enabled} onChange={() => toggleSkill(sk.id)} label={`Enable ${sk.name}`} small />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {sk.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--text-tertiary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {sk.description || sk.sourcePath || sk.content.slice(0, 70)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeSkill(sk.id)}
                    title="Uninstall skill"
                    style={{ color: 'var(--text-muted)', padding: 4 }}
                  >
                    <Trash2 size={13} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 6 }}>
            Add a built-in skill
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {BUILT_IN_SKILLS.map((preset) => {
              const already = skills.some(
                (s) => s.id === preset.id || s.name.toLowerCase() === preset.name.toLowerCase(),
              );
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={already}
                  onClick={() => installPresetSkill(preset)}
                  className="transition-atelier"
                  style={{
                    height: 28,
                    padding: '0 11px',
                    borderRadius: 'var(--radius-full)',
                    background: already ? 'transparent' : 'var(--surface-2)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: 12,
                    color: already ? 'var(--text-muted)' : 'var(--text-secondary)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    cursor: already ? 'default' : 'pointer',
                  }}
                >
                  {already ? <Check size={11} strokeWidth={2} /> : <Plus size={11} strokeWidth={1.5} />}
                  {preset.name}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              type="text"
              value={localSkillPath}
              onChange={(e) => setLocalSkillPath(e.target.value)}
              placeholder="Or import a local SKILL.md, e.g. D:\Skills\my-skill\SKILL.md"
              className="mono-num"
              style={{ ...inputStyle, fontSize: 12 }}
            />
            <button
              type="button"
              disabled={!localSkillPath.trim() || importingFile}
              onClick={() => void handleImportLocalSkill()}
              style={{ ...secondaryBtnStyle, flexShrink: 0, fontSize: 12 }}
            >
              <FileText size={13} strokeWidth={1.5} />
              {importingFile ? 'Reading…' : 'Import .md'}
            </button>
          </div>

          {writingCustomSkill && (
            <div
              className="msg-enter"
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input
                  type="text"
                  value={customSkillName}
                  onChange={(e) => setCustomSkillName(e.target.value)}
                  placeholder="Skill name (e.g. Prisma Migration)"
                  style={inputStyle}
                />
                <input
                  type="text"
                  value={customSkillDesc}
                  onChange={(e) => setCustomSkillDesc(e.target.value)}
                  placeholder="Short description"
                  style={inputStyle}
                />
              </div>
              <textarea
                rows={3}
                value={customSkillContent}
                onChange={(e) => setCustomSkillContent(e.target.value)}
                placeholder="Skill markdown instructions…"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setWritingCustomSkill(false)}
                  style={{ ...secondaryBtnStyle, height: 30, fontSize: 12 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAddCustomSkill}
                  disabled={!customSkillName.trim() || !customSkillContent.trim()}
                  style={{ ...primaryBtnStyle, height: 30, fontSize: 12 }}
                >
                  Install skill
                </button>
              </div>
            </div>
          )}
        </Section>

        {/* MCP connections */}
        <Section
          title="MCP connections"
          count={`${mcpServerIds.filter((id) => settings.mcpServers.some((m) => m.id === id && m.enabled)).length} active`}
          action={
            onOpenMcp && (
              <button
                type="button"
                onClick={onOpenMcp}
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  textDecoration: 'underline',
                  textUnderlineOffset: 3,
                }}
              >
                Manage connections…
              </button>
            )
          }
        >
          {settings.mcpServers.length === 0 ? (
            <div
              style={{
                padding: '14px 14px',
                borderRadius: 'var(--radius-md)',
                border: '1px dashed var(--border-default)',
                fontSize: 12,
                lineHeight: '18px',
                color: 'var(--text-tertiary)',
              }}
            >
              No MCP servers yet. Use “Manage connections…” to log in to a service or add a command,
              URL, or JSON.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              {settings.mcpServers.map((srv) => {
                const checked = mcpServerIds.includes(srv.id);
                return (
                  <button
                    key={srv.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggleMcpServer(srv.id)}
                    className="transition-atelier"
                    style={{
                      padding: '9px 11px',
                      borderRadius: 'var(--radius-md)',
                      background: checked ? 'var(--surface-3)' : 'var(--surface-2)',
                      border: `1px solid ${checked ? 'rgba(255,255,255,0.22)' : 'var(--border-subtle)'}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      textAlign: 'left',
                      minWidth: 0,
                      opacity: srv.enabled ? 1 : 0.55,
                    }}
                  >
                    <McpIcon presetId={srv.presetId} name={srv.name} size={28} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {srv.name}
                      </span>
                      <span className="mono-num" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        {srv.auth === 'oauth' ? 'login' : srv.transport}
                        {!srv.enabled && ' · disabled'}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 5,
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: checked ? 'var(--action-primary)' : 'transparent',
                        border: `1px solid ${checked ? 'var(--action-primary)' : 'var(--border-default)'}`,
                        color: 'var(--action-primary-fg)',
                      }}
                    >
                      {checked && <Check size={11} strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Section>

        {error && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--agent-red)',
              padding: '9px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(248, 113, 113, 0.08)',
              border: '1px solid rgba(248, 113, 113, 0.25)',
            }}
          >
            {error}
          </div>
        )}

        {/* Footer actions: stays visible while the form scrolls */}
        <div
          style={{
            position: 'sticky',
            bottom: -18,
            margin: '0 -18px -18px',
            padding: '14px 18px 18px',
            background: 'linear-gradient(to top, var(--surface-1) 72%, rgba(21, 21, 27, 0))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: isEdit ? 'space-between' : 'flex-end',
            gap: 8,
            zIndex: 2,
          }}
        >
          {isEdit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  style={{ ...secondaryBtnStyle, color: 'var(--agent-red)' }}
                >
                  Remove agent
                </button>
              ) : (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleDelete()}
                  style={{
                    ...secondaryBtnStyle,
                    borderColor: 'rgba(248, 113, 113, 0.45)',
                    color: 'var(--agent-red)',
                  }}
                >
                  Confirm delete
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || !role.trim()}
              style={{
                ...primaryBtnStyle,
                opacity: !name.trim() || !role.trim() ? 0.45 : 1,
              }}
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'}
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

/* ───────── small building blocks ───────── */

function Section({
  title,
  hint,
  count,
  action,
  children,
}: {
  title: string;
  hint?: string;
  count?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {title}
          </h3>
          {count && (
            <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {count}
            </span>
          )}
          {hint && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{hint}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Switch({
  checked,
  onChange,
  label,
  small = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  small?: boolean;
}) {
  const w = small ? 28 : 36;
  const h = small ? 16 : 20;
  const knob = h - 4;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: w,
        height: h,
        flexShrink: 0,
        borderRadius: 9999,
        background: checked ? 'var(--agent-green)' : 'var(--surface-3)',
        border: '1px solid var(--border-default)',
        transition: 'background 160ms var(--ease-atelier)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1.5,
          left: 1.5,
          width: knob - 1,
          height: knob - 1,
          borderRadius: 9999,
          background: '#fff',
          transform: `translateX(${checked ? w - knob - 3 : 0}px)`,
          transition: 'transform 180ms var(--ease-atelier)',
        }}
      />
    </button>
  );
}
