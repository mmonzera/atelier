import type { AtelierStore } from '../store.js';

/**
 * Pemilik ringkasan yang boleh dilihat sebuah turn. Ringkasan mengikuti owner-nya:
 * di room hanya ringkasan room, di DM/direct hanya ringkasan pribadi agent.
 */
export function memoryOwners(store: AtelierStore, agentId: string, channelId?: string | null): string[] {
  const channel = channelId ? store.channels.getChannel(channelId) : null;
  return channel?.kind === 'room' ? [`channel:${channel.id}`] : [`agent:${agentId}`];
}
