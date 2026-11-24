import type {
  ModelProvider,
  ProviderUsageSummary,
  UsageDashboardResponse,
  UsagePeriod,
  UsageRange,
} from '@atelier/contracts';
import { BarChart3, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { ProviderTile } from '../ProviderIcon';
import { Select } from '../Select';
import { toast } from '../Toast';
import {
  ModalShell,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './ModalShell';
import { t as translate, useT } from '../../i18n';

const PROVIDER_NAMES: Record<ModelProvider, string> = {
  claude: 'Claude (Anthropic)',
  openai: 'ChatGPT (Codex)',
  antigravity: 'Antigravity (Google)',
  deepseek: 'DeepSeek (API)',
  opencode: 'OpenCode CLI',
  openrouter: 'OpenRouter (API)',
};

const RANGE_OPTIONS: Array<{ id: UsageRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All' },
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatUsd(amount: number): string {
  if (amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function barColor(percent: number | null): string {
  if (percent === null) return 'var(--agent-blue)';
  if (percent >= 90) return 'var(--agent-red)';
  if (percent >= 70) return 'var(--agent-amber)';
  return 'var(--agent-green)';
}

function formatResetShort(iso: string | null): string | null {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return translate('resets soon');
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return translate('resets {days}d {hours}h', { days, hours });
  return translate('resets {hours}h {mins}m', { hours, mins });
}

const RESET_DAY_OPTIONS = [
  { value: 'rolling', label: 'Rolling 7 days' },
  { value: '0', label: 'Sunday 00:00' },
  { value: '1', label: 'Monday 00:00' },
  { value: '2', label: 'Tuesday 00:00' },
  { value: '3', label: 'Wednesday 00:00' },
  { value: '4', label: 'Thursday 00:00' },
  { value: '5', label: 'Friday 00:00' },
  { value: '6', label: 'Saturday 00:00' },
];

export function UsageModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [range, setRange] = useState<UsageRange>('30d');
  const [tab, setTab] = useState<'providers' | 'agents'>('providers');
  const [data, setData] = useState<UsageDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<ModelProvider | null>(null);
  const [limitPeriod, setLimitPeriod] = useState<UsagePeriod>('monthly');
  const [tokenLimitInput, setTokenLimitInput] = useState('');
  const [budgetUsdInput, setBudgetUsdInput] = useState('');
  const [fiveHourLimitInput, setFiveHourLimitInput] = useState('');
  const [weeklyLimitInput, setWeeklyLimitInput] = useState('');
  const [weeklyResetDayInput, setWeeklyResetDayInput] = useState('rolling');
  const [savingLimit, setSavingLimit] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const loadUsage = useCallback(async (targetRange: UsageRange, refresh = false) => {
    setLoading(true);
    try {
      const res = await api.getUsage(targetRange, refresh);
      setData(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load usage stats'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsage(range);
  }, [range, loadUsage]);

  const openEditLimit = (summary: ProviderUsageSummary) => {
    if (editingProvider === summary.provider) {
      setEditingProvider(null);
      return;
    }
    setEditingProvider(summary.provider);
    setLimitPeriod(summary.limit?.period ?? 'monthly');
    setTokenLimitInput(summary.limit?.tokenLimit ? String(summary.limit.tokenLimit) : '');
    setBudgetUsdInput(summary.limit?.budgetUsd ? String(summary.limit.budgetUsd) : '');
    setFiveHourLimitInput(
      summary.limit?.fiveHourTokenLimit !== undefined
        ? summary.limit.fiveHourTokenLimit
          ? String(summary.limit.fiveHourTokenLimit)
          : ''
        : summary.fiveHour.tokenLimit
          ? String(summary.fiveHour.tokenLimit)
          : '',
    );
    setWeeklyLimitInput(
      summary.limit?.weeklyTokenLimit !== undefined
        ? summary.limit.weeklyTokenLimit
          ? String(summary.limit.weeklyTokenLimit)
          : ''
        : summary.weekly.tokenLimit
          ? String(summary.weekly.tokenLimit)
          : '',
    );
    setWeeklyResetDayInput(
      typeof summary.limit?.weeklyResetDay === 'number'
        ? String(summary.limit.weeklyResetDay)
        : 'rolling',
    );
  };

  const handleSaveLimit = async (provider: ModelProvider) => {
    const parsedTokens = tokenLimitInput.trim() ? Number(tokenLimitInput.trim()) : null;
    const parsedUsd = budgetUsdInput.trim() ? Number(budgetUsdInput.trim()) : null;
    const parsed5h = fiveHourLimitInput.trim() ? Number(fiveHourLimitInput.trim()) : null;
    const parsedWeekly = weeklyLimitInput.trim() ? Number(weeklyLimitInput.trim()) : null;
    const parsedResetDay =
      weeklyResetDayInput === 'rolling' ? null : Number(weeklyResetDayInput);

    if (
      (parsedTokens !== null && (!Number.isFinite(parsedTokens) || parsedTokens <= 0)) ||
      (parsedUsd !== null && (!Number.isFinite(parsedUsd) || parsedUsd <= 0)) ||
      (parsed5h !== null && (!Number.isFinite(parsed5h) || parsed5h <= 0)) ||
      (parsedWeekly !== null && (!Number.isFinite(parsedWeekly) || parsedWeekly <= 0))
    ) {
      toast.error(t('Limits must be positive numbers.'));
      return;
    }

    const emptyAll =
      parsedTokens === null &&
      parsedUsd === null &&
      parsed5h === null &&
      parsedWeekly === null &&
      parsedResetDay === null;

    setSavingLimit(true);
    try {
      await api.updateUsageLimit(
        provider,
        emptyAll
          ? { clear: true }
          : {
              period: limitPeriod,
              tokenLimit: parsedTokens !== null ? Math.round(parsedTokens) : null,
              budgetUsd: parsedUsd,
              ...(parsed5h !== null ? { fiveHourTokenLimit: Math.round(parsed5h) } : {}),
              ...(parsedWeekly !== null ? { weeklyTokenLimit: Math.round(parsedWeekly) } : {}),
              weeklyResetDay: parsedResetDay,
            },
      );
      toast.success(
        emptyAll ? t('Limit removed for {v0}', { v0: PROVIDER_NAMES[provider] }) : t('Usage limit saved for {v0}', { v0: PROVIDER_NAMES[provider] }),
      );
      setEditingProvider(null);
      await loadUsage(range);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update limit'));
    } finally {
      setSavingLimit(false);
    }
  };

  const handleClearLimit = async (provider: ModelProvider) => {
    setSavingLimit(true);
    try {
      await api.updateUsageLimit(provider, { clear: true });
      toast.info(t('Limit removed for {v0}', { v0: PROVIDER_NAMES[provider] }));
      setEditingProvider(null);
      await loadUsage(range);
    } finally {
      setSavingLimit(false);
    }
  };

  const handleClearLogs = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    await api.clearUsageLogs();
    setConfirmClear(false);
    toast.info(t('Usage history cleared'));
    await loadUsage(range);
  };

  const maxAgentTokens = Math.max(
    1,
    ...(data?.agents.map((a) => a.totalTokens) ?? [1]),
  );

  return (
    <ModalShell
      title={t('AI Usage & Limits')}
      subtitle={t('Track token consumption, estimated spend, live API balance, and remaining quotas per provider.')}
      width={680}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Range selector + actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              padding: 3,
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              gap: 2,
            }}
          >
            {RANGE_OPTIONS.map((opt) => {
              const active = range === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setRange(opt.id)}
                  className="transition-atelier"
                  style={{
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 'var(--radius-full)',
                    fontSize: 12,
                    fontWeight: active ? 500 : 400,
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    background: active ? 'var(--surface-3)' : 'transparent',
                  }}
                >
                  {t(opt.label)}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={() => void loadUsage(range, true)}
              className="transition-atelier"
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12,
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <RefreshCw size={12} strokeWidth={1.5} />{t('Refresh')}
            </button>
            <button
              type="button"
              onClick={() => void handleClearLogs()}
              className="transition-atelier"
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 'var(--radius-full)',
                background: confirmClear ? 'rgba(248, 113, 113, 0.14)' : 'var(--surface-2)',
                border: `1px solid ${confirmClear ? 'rgba(248, 113, 113, 0.35)' : 'var(--border-subtle)'}`,
                fontSize: 12,
                color: confirmClear ? 'var(--agent-red)' : 'var(--text-tertiary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Trash2 size={12} strokeWidth={1.5} />
              {confirmClear ? t('Confirm clear') : t('Reset')}
            </button>
          </div>
        </div>

        {/* 3 KPI Summary Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('Total Tokens')}
            </div>
            <div className="mono-num" style={{ fontSize: 20, fontWeight: 500, color: 'var(--text-primary)', marginTop: 4 }}>
              {loading && !data ? '—' : formatTokens(data?.totals.totalTokens ?? 0)}
            </div>
            <div className="mono-num" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('In')} {formatTokens(data?.totals.inputTokens ?? 0)}{t('· Out')} {formatTokens(data?.totals.outputTokens ?? 0)}
            </div>
          </div>

          <div
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('Est. Spend')}
            </div>
            <div className="mono-num" style={{ fontSize: 20, fontWeight: 500, color: 'var(--text-primary)', marginTop: 4 }}>
              {loading && !data ? '—' : formatUsd(data?.totals.estimatedCostUsd ?? 0)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('Reference rate estimate')}
            </div>
          </div>

          <div
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('Completed Turns')}
            </div>
            <div className="mono-num" style={{ fontSize: 20, fontWeight: 500, color: 'var(--text-primary)', marginTop: 4 }}>
              {loading && !data ? '—' : (data?.totals.turns ?? 0).toLocaleString()}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('Across all projects & DMs')}
            </div>
          </div>
        </div>

        {/* Sub-tabs: Providers & Limits vs By Agent */}
        <div
          style={{
            display: 'inline-flex',
            alignSelf: 'flex-start',
            padding: 3,
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            gap: 2,
          }}
        >
          {(
            [
              { id: 'providers', label: t('Providers & Limits') },
              { id: 'agents', label: t('By Agent ({v0})', { v0: data?.agents.length ?? 0 }) },
            ] as const
          ).map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className="transition-atelier"
                style={{
                  height: 26,
                  padding: '0 12px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                  fontWeight: active ? 500 : 400,
                  color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  background: active ? 'var(--surface-3)' : 'transparent',
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {tab === 'providers' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(data?.providers ?? []).map((p) => {
              const isEditing = editingProvider === p.provider;
              const fillColor = barColor(p.percentUsed);
              const pctClamped =
                p.percentUsed !== null ? Math.min(100, Math.max(0, p.percentUsed)) : 0;

              return (
                <div
                  key={p.provider}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 12,
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <ProviderTile provider={p.provider} size={34} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                            {PROVIDER_NAMES[p.provider]}
                          </span>
                          {p.sourceLabel && (
                            <span
                              style={{
                                fontSize: 10.5,
                                color: 'var(--text-muted)',
                                padding: '1px 6px',
                                borderRadius: 6,
                                background: 'var(--surface-3)',
                                border: '1px solid var(--border-subtle)',
                              }}
                            >
                              {p.sourceLabel}
                            </span>
                          )}
                          {p.liveBalance && (
                            <span
                              className="mono-num"
                              style={{
                                fontSize: 11,
                                color: p.liveBalance.available ? 'var(--agent-green)' : 'var(--agent-red)',
                                padding: '1px 7px',
                                borderRadius: 6,
                                background: p.liveBalance.available
                                  ? 'rgba(52, 211, 153, 0.12)'
                                  : 'rgba(248, 113, 113, 0.12)',
                                border: `1px solid ${p.liveBalance.available ? 'rgba(52, 211, 153, 0.28)' : 'rgba(248, 113, 113, 0.28)'}`,
                              }}
                            >{t('Live:')} {p.liveBalance.label}
                            </span>
                          )}
                        </div>
                        <div className="mono-num" style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                          {formatTokens(p.totalTokens)}{t('tokens ·')} {formatUsd(p.estimatedCostUsd)} · {p.turns}{' '}
                          {p.turns === 1 ? t('turn') : t('turns')}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => openEditLimit(p)}
                      className="transition-atelier"
                      style={{
                        height: 28,
                        padding: '0 11px',
                        borderRadius: 'var(--radius-full)',
                        background: isEditing ? 'var(--surface-3)' : 'var(--surface-1)',
                        border: `1px solid ${isEditing ? 'var(--border-default)' : 'var(--border-subtle)'}`,
                        fontSize: 11.5,
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        flexShrink: 0,
                      }}
                    >
                      <SlidersHorizontal size={12} strokeWidth={1.5} />
                      {p.limit ? t('Edit limit') : t('Set limit')}
                    </button>
                  </div>

                  {p.supportsRollingWindows && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 10,
                        paddingLeft: 46,
                      }}
                    >
                      {[
                        {
                          label: p.fiveHour.isOfficial ? t('5-hour limit') : t('Est. 5h'),
                          win: p.fiveHour,
                        },
                        {
                          label: p.weekly.isOfficial ? t('Weekly limit') : t('Est. Weekly'),
                          win: p.weekly,
                        },
                      ].map(({ label, win }) => {
                        const pct =
                          win.percentUsed !== null ? Math.min(100, Math.max(0, win.percentUsed)) : 0;
                        const reset = formatResetShort(win.resetsAt);
                        return (
                          <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div
                              className="mono-num"
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: 10.5,
                                color: 'var(--text-secondary)',
                              }}
                            >
                              <span>
                                {label}
                                {reset ? (
                                  <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
                                    · {reset}
                                  </span>
                                ) : null}
                              </span>
                              <span>
                                {win.percentUsed ?? 0}%
                                {!win.isOfficial && win.remainingTokens !== null ? t(' · {v0} left', { v0: formatTokens(win.remainingTokens) }) : win.isOfficial && win.usedTokens > 0 ? t(' · {v0} used', { v0: formatTokens(win.usedTokens) }) : ''}
                              </span>
                            </div>
                            <div
                              style={{
                                height: 5,
                                borderRadius: 'var(--radius-full)',
                                background: 'var(--surface-1)',
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{
                                  height: '100%',
                                  width: `${pct}%`,
                                  borderRadius: 'var(--radius-full)',
                                  background: barColor(win.percentUsed),
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {p.limit && (p.limit.tokenLimit !== null || p.limit.budgetUsd !== null) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 46 }}>
                      <div
                        style={{
                          height: 6,
                          width: '100%',
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--surface-1)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${pctClamped}%`,
                            borderRadius: 'var(--radius-full)',
                            background: fillColor,
                            transition: 'width 240ms var(--ease-atelier)',
                          }}
                        />
                      </div>
                      <div
                        className="mono-num"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          fontSize: 11,
                          color: 'var(--text-tertiary)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ color: p.percentUsed && p.percentUsed >= 90 ? 'var(--agent-red)' : 'var(--text-secondary)' }}>
                          {p.percentUsed ?? 0}{t('% used (')}{p.limit.period}{t('window)')}
                        </span>
                        <span>
                          {[
                            p.limit.tokenLimit !== null
                              ? `${formatTokens(p.remainingTokens ?? 0)} / ${formatTokens(p.limit.tokenLimit)} tokens left`
                              : null,
                            p.limit.budgetUsd !== null
                              ? `${formatUsd(p.remainingBudgetUsd ?? 0)} / ${formatUsd(p.limit.budgetUsd)} left`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                    </div>
                  )}

                  {isEditing && (
                    <div
                      style={{
                        paddingTop: 10,
                        borderTop: '1px solid var(--border-subtle)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1.2fr', gap: 8 }}>
                        <div>
                          <label style={labelStyle}>{t('Period')}</label>
                          <Select
                            ariaLabel={t('Limit period')}
                            value={limitPeriod}
                            onChange={(v) => setLimitPeriod(v as UsagePeriod)}
                            options={[
                              { value: 'daily', label: t('Daily') },
                              { value: 'weekly', label: t('Weekly') },
                              { value: 'monthly', label: t('Monthly') },
                            ]}
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>{t('Token limit')}</label>
                          <input
                            type="number"
                            min={1000}
                            step={10000}
                            placeholder="e.g. 2000000"
                            value={tokenLimitInput}
                            onChange={(e) => setTokenLimitInput(e.target.value)}
                            className="mono-num"
                            style={inputStyle}
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>{t('Budget (USD)')}</label>
                          <input
                            type="number"
                            min={0.5}
                            step={1}
                            placeholder="e.g. 20"
                            value={budgetUsdInput}
                            onChange={(e) => setBudgetUsdInput(e.target.value)}
                            className="mono-num"
                            style={inputStyle}
                          />
                        </div>
                      </div>
                      {p.supportsRollingWindows && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                          <div>
                            <label style={labelStyle}>{t('5-hour cap')}</label>
                            <input
                              type="number"
                              min={1000}
                              step={50000}
                              placeholder="e.g. 10000000"
                              value={fiveHourLimitInput}
                              onChange={(e) => setFiveHourLimitInput(e.target.value)}
                              className="mono-num"
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>{t('Weekly cap')}</label>
                            <input
                              type="number"
                              min={1000}
                              step={100000}
                              placeholder="e.g. 100000000"
                              value={weeklyLimitInput}
                              onChange={(e) => setWeeklyLimitInput(e.target.value)}
                              className="mono-num"
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>{t('Weekly reset')}</label>
                            <Select
                              ariaLabel={t('Weekly reset day')}
                              value={weeklyResetDayInput}
                              onChange={setWeeklyResetDayInput}
                              options={RESET_DAY_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
                            />
                          </div>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        {p.limit ? (
                          <button
                            type="button"
                            disabled={savingLimit}
                            onClick={() => void handleClearLimit(p.provider)}
                            style={{ fontSize: 12, color: 'var(--agent-red)' }}
                          >{t('Remove limit')}
                          </button>
                        ) : (
                          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{t('Leave blank for unlimited')}
                          </span>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            onClick={() => setEditingProvider(null)}
                            style={{ ...secondaryBtnStyle, height: 30, fontSize: 12 }}
                          >{t('Cancel')}
                          </button>
                          <button
                            type="button"
                            disabled={savingLimit}
                            onClick={() => void handleSaveLimit(p.provider)}
                            style={{ ...primaryBtnStyle, height: 30, fontSize: 12 }}
                          >
                            {savingLimit ? t('Saving…') : t('Save limit')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!data || data.agents.length === 0 ? (
              <div
                style={{
                  padding: '28px 16px',
                  borderRadius: 12,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  color: 'var(--text-tertiary)',
                  fontSize: 12.5,
                }}
              >
                <BarChart3 size={18} strokeWidth={1.5} />
                <span>{t('No agent usage recorded in this window yet.')}</span>
              </div>
            ) : (
              data.agents.map((a) => {
                const widthPct = Math.max(4, Math.round((a.totalTokens / maxAgentTokens) * 100));
                return (
                  <div
                    key={a.agentId}
                    style={{
                      padding: '11px 14px',
                      borderRadius: 10,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 7,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                        {a.agentName}
                      </span>
                      <span className="mono-num" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        {formatTokens(a.totalTokens)}{t('tokens ·')} {formatUsd(a.estimatedCostUsd)} · {a.turns}{' '}
                        {a.turns === 1 ? t('turn') : t('turns')}
                      </span>
                    </div>
                    <div
                      style={{
                        height: 5,
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--surface-1)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${widthPct}%`,
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--agent-blue)',
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
