import { CliError } from '../lib/errors.js'

export const REGIONS = ['us-east-1', 'eu-central-1'] as const
export const LANGUAGES = ['en', 'de'] as const
export const VOICE_GENDERS = ['feminine', 'masculine'] as const

export type Region = (typeof REGIONS)[number]
export type Language = (typeof LANGUAGES)[number]
export type VoiceGender = (typeof VOICE_GENDERS)[number]

export const PROJECT_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface Order {
  projectName: string
  companyName: string
  region: Region
  language: Language
  voiceGender: VoiceGender
  customerProfilesEnabled: boolean
  frontendEnabled: boolean
  dataLakeEnabled: boolean
  contactEventsEnabled: boolean
  retainData: boolean
  identityCenterEnabled: boolean
  knowledgeBaseEnabled: boolean
}

/** Values file contract. deriveValues emits these keys in this order — kept
 *  stable so serialized values files stay diff-friendly across runs. */
export interface Values {
  projectName: string
  companyName: string
  region: Region
  customerProfilesEnabled: boolean
  frontendEnabled: boolean
  dataLakeEnabled: boolean
  contactEventsEnabled: boolean
  retainData: boolean
  identityCenterEnabled: boolean
  knowledgeBaseEnabled: boolean
  kbParsingModelId: string
  lexLocaleId: string
  ttsLanguageCode: string
  voiceGender: VoiceGender
  promptLanguage: string
  selfServiceFallback: string
  orchestrationModelId: string
  answerGenModelId: string
}

/** Interview + parseOrder share this. Returns the error message, or null. */
export function validateProjectName(v: string): string | null {
  if (!PROJECT_NAME_RE.test(v)) {
    return 'use lowercase letters, digits, and single hyphens (no leading/trailing hyphen)'
  }
  if (v.length > 32) return 'max 32 characters'
  return null
}

function oneOf<T extends string>(
  raw: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
  joinWord: string,
): T {
  const v = raw == null ? fallback : raw
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new CliError(`invalid ${field} '${v}': must be ${allowed.join(joinWord)}`)
  }
  return v as T
}

/** Absent → default; anything non-boolean is an error; explicit false is
 *  preserved even for default-true fields — an explicit false must never be
 *  read as "absent" and silently flipped back to the default. */
function bool(raw: unknown, field: string, fallback: boolean): boolean {
  if (raw == null) return fallback
  if (typeof raw !== 'boolean') throw new CliError(`${field} must be boolean`)
  return raw
}

export function parseOrder(raw: unknown): Order {
  const o = (raw ?? {}) as Record<string, unknown>

  const projectName = typeof o.projectName === 'string' ? o.projectName : ''
  if (!projectName) throw new CliError('projectName is required')
  const nameErr = validateProjectName(projectName)
  if (nameErr) throw new CliError(`invalid projectName '${projectName}': ${nameErr}`)

  const region = oneOf(o.region, 'region', REGIONS, 'us-east-1', ' or ')
  const language = oneOf(o.language, 'language', LANGUAGES, 'en', ' or ')
  const voiceGender = oneOf(o.voiceGender, 'voiceGender', VOICE_GENDERS, 'feminine', ' or ')

  // Owned product rule: companyName is substituted verbatim into rendered
  // .ts/.md/.json files, and per-target escaping isn't worth the complexity —
  // so these three characters are simply not supported.
  const companyName = o.companyName == null ? 'My Company' : String(o.companyName)
  // `"` and line breaks belong in this set too: companyName is substituted into
  // generated JSON (flows/prompt-texts-seed.json has 8 sites), which the
  // contact-flow stack JSON.parses at synth. Without them, a name like
  // Bob "The Builder" Ltd rendered successfully and then failed inside the CDK
  // app with a SyntaxError naming a generated file — no mention of companyName
  // or the order file.
  if (/[`\\"]|\$\{/.test(companyName) || /[\r\n\t]/.test(companyName)) {
    throw new CliError(
      'invalid companyName: the characters ` " \\ ${ and line breaks are not supported '
      + '(it is substituted verbatim into generated TypeScript and JSON)',
    )
  }

  // NOTE: human transfer, tool calling, and storage encryption are ALWAYS on,
  // and call recording ships as a deployed-but-unwired consent module — legacy
  // keys (transferEnabled, toolEnabled, recordingEnabled, encryptionEnabled)
  // and unknown keys (greeting, claimUkDid, kbContent) are deliberately
  // ignored here (ignoring unknown keys is the order-file contract).
  return {
    projectName,
    companyName,
    region,
    language,
    voiceGender,
    customerProfilesEnabled: bool(o.customerProfilesEnabled, 'customerProfilesEnabled', true),
    frontendEnabled: bool(o.frontendEnabled, 'frontendEnabled', false),
    dataLakeEnabled: bool(o.dataLakeEnabled, 'dataLakeEnabled', false),
    contactEventsEnabled: bool(o.contactEventsEnabled, 'contactEventsEnabled', false),
    retainData: bool(o.retainData, 'retainData', true),
    identityCenterEnabled: bool(o.identityCenterEnabled, 'identityCenterEnabled', false),
    knowledgeBaseEnabled: bool(o.knowledgeBaseEnabled, 'knowledgeBaseEnabled', false),
  }
}

export function deriveValues(order: Order): Values {
  // Bedrock inference-profile prefix is region-scoped: us.* in Virginia,
  // eu.* in Frankfurt (the us.* profiles do not resolve in eu-central-1).
  const prefix = order.region === 'eu-central-1' ? 'eu' : 'us'
  const en = order.language === 'en'
  return {
    projectName: order.projectName,
    companyName: order.companyName,
    region: order.region,
    customerProfilesEnabled: order.customerProfilesEnabled,
    frontendEnabled: order.frontendEnabled,
    dataLakeEnabled: order.dataLakeEnabled,
    contactEventsEnabled: order.contactEventsEnabled,
    retainData: order.retainData,
    identityCenterEnabled: order.identityCenterEnabled,
    knowledgeBaseEnabled: order.knowledgeBaseEnabled,
    kbParsingModelId: `${prefix}.amazon.nova-pro-v1:0`,
    lexLocaleId: en ? 'en_US' : 'de_DE',
    ttsLanguageCode: en ? 'en-US' : 'de-DE',
    voiceGender: order.voiceGender,
    promptLanguage: en ? 'English' : 'German',
    selfServiceFallback: en ? "I don't have an answer." : 'Ich habe darauf leider keine Antwort.',
    orchestrationModelId: `${prefix}.anthropic.claude-haiku-4-5-20251001-v1:0`,
    answerGenModelId: `${prefix}.amazon.nova-pro-v1:0`,
  }
}
