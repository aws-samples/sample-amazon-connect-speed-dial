export interface Prefs { claimUkDid: boolean; kbContent: 'sample' | 'path' | 'skip'; kbContentPath: string }
export interface DeployFlags { claimUkDid?: boolean; kbContent?: string }

/** Orchestration prefs live in the order JSON (claimUkDid, kbContent); the
 *  CLI flags act as one-off overrides. kbContent: 'sample' | <path> |
 *  absent/empty (= skip). */
export function prefsFromOrder(orderRaw: Record<string, unknown>, flags: DeployFlags): Prefs {
  const kb = flags.kbContent !== undefined ? flags.kbContent : (orderRaw.kbContent as string | undefined) || undefined
  return {
    claimUkDid: Boolean(flags.claimUkDid) || orderRaw.claimUkDid === true,
    kbContent: kb === 'sample' ? 'sample' : kb ? 'path' : 'skip',
    kbContentPath: kb && kb !== 'sample' ? kb : '',
  }
}

/** CLI overrides are folded back into the order file so the JSON stays the
 *  single source of truth and the rerun command needs no flags. */
export function foldFlagsIntoOrder(
  orderRaw: Record<string, unknown>, flags: DeployFlags,
): Record<string, unknown> | null {
  const updates: Record<string, unknown> = {}
  if (flags.claimUkDid && orderRaw.claimUkDid !== true) updates.claimUkDid = true
  if (flags.kbContent !== undefined && orderRaw.kbContent !== flags.kbContent) updates.kbContent = flags.kbContent
  if (Object.keys(updates).length === 0) return null
  return { ...orderRaw, ...updates }
}
