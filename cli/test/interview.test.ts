import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interview, confirmOrder } from '../src/commands/interview.js'
import { CliError } from '../src/lib/errors.js'
import type { Prompt } from '../src/core/ports.js'

// The interview is the product's front door and had no tests at all. Now that
// stdin arrives through the Prompt port, every branch is reachable.
//
// Answers are matched against the question text rather than by position, so a
// case reads as a conversation and stays valid when an unrelated question moves.
// A matcher listed twice answers twice — that is how re-prompt loops are driven.
function scripted(answers: Array<[string, string]>, fallback = ''):
Prompt & { asked: string[] } {
  const asked: string[] = []
  const queue = [...answers]
  return {
    asked,
    async ask(question) {
      asked.push(question)
      const i = queue.findIndex(([needle]) => question.includes(needle))
      if (i === -1) return fallback
      const [, answer] = queue[i]!
      queue.splice(i, 1)
      return answer
    },
  }
}

let tmp: string
let logged: string[]
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'csp-interview-'))
  logged = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')) })
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const out = () => logged.join('\n')

describe('express mode', () => {
  it('asks nothing when the project name is already known', async () => {
    const prompt = scripted([])
    const { orderRaw, prefs } = await interview(
      { express: true, projectName: 'acme-support', workingDir: tmp }, prompt)
    expect(prompt.asked).toEqual([])
    expect(orderRaw).toEqual({ projectName: 'acme-support' })
    expect(prefs.claimUkDid).toBe(true)
  })

  it('still asks for the project name when -p was not given', async () => {
    const prompt = scripted([['Project name', 'acme-support']])
    const { orderRaw } = await interview({ express: true, workingDir: tmp }, prompt)
    expect(prompt.asked).toHaveLength(1)
    expect(orderRaw.projectName).toBe('acme-support')
  })

  it('rejects an invalid -p up front instead of prompting around it', async () => {
    const prompt = scripted([])
    await expect(interview({ express: true, projectName: 'Bad Name', workingDir: tmp }, prompt))
      .rejects.toThrow(CliError)
    expect(prompt.asked).toEqual([])
  })
})

describe('project name prompt', () => {
  it('re-prompts until the name is valid', async () => {
    const prompt = scripted([
      ['Project name', 'Bad Name'],
      ['Project name', 'still bad'],
      ['Project name', 'acme-support'],
    ])
    const { orderRaw } = await interview({ express: true, workingDir: tmp }, prompt)
    expect(orderRaw.projectName).toBe('acme-support')
    expect(prompt.asked).toHaveLength(3)
  })

  it('re-prompts on an empty answer rather than accepting it', async () => {
    const prompt = scripted([['Project name', ''], ['Project name', 'acme-support']])
    const { orderRaw } = await interview({ express: true, workingDir: tmp }, prompt)
    expect(orderRaw.projectName).toBe('acme-support')
  })
})

describe('choice questions', () => {
  const base = (extra: Array<[string, string]> = []): Array<[string, string]> => [
    ['Project name', 'acme-support'], ...extra,
  ]

  it('takes the documented defaults when every answer is Enter', async () => {
    const { orderRaw, prefs } = await interview({ express: false, workingDir: tmp }, scripted(base()))
    expect(orderRaw).toMatchObject({
      companyName: 'My Company',
      region: 'us-east-1',
      language: 'en',
      voiceGender: 'feminine',
      customerProfilesEnabled: true, // the one default-ON add-on
      dataLakeEnabled: false,
      contactEventsEnabled: false,
      knowledgeBaseEnabled: false,
      frontendEnabled: false,
      identityCenterEnabled: false,
    })
    expect(prefs.claimUkDid).toBe(true) // reach default (a) = UK number
  })

  it('re-prompts an out-of-range choice and says what is allowed', async () => {
    const prompt = scripted(base([['Region', 'eu-west-1'], ['Region', 'eu-central-1']]))
    const { orderRaw } = await interview({ express: false, workingDir: tmp }, prompt)
    expect(orderRaw.region).toBe('eu-central-1')
    expect(out()).toContain('choose one of: us-east-1, eu-central-1')
  })
})

describe('askBool', () => {
  const withProfiles = (answer: string): Array<[string, string]> => [
    ['Project name', 'acme-support'],
    ['Customer Profiles', answer],
  ]

  it.each([['y', true], ['yes', true], ['true', true], ['1', true],
    ['n', false], ['no', false], ['false', false], ['0', false]])(
    'reads %s as %s', async (answer, expected) => {
      const { orderRaw } = await interview(
        { express: false, workingDir: tmp }, scripted(withProfiles(answer)))
      expect(orderRaw.customerProfilesEnabled).toBe(expected)
    })

  it('RE-PROMPTS a typo instead of silently turning a default-ON option off', async () => {
    // 'yse' used to be read as "no", which quietly disabled Customer Profiles —
    // the deployment then had no caller lookup and nobody knew why.
    const prompt = scripted([
      ['Project name', 'acme-support'],
      ['Customer Profiles', 'yse'],
      ['Customer Profiles', 'yes please'],
      ['Customer Profiles', 'y'],
    ])
    const { orderRaw } = await interview({ express: false, workingDir: tmp }, prompt)
    expect(orderRaw.customerProfilesEnabled).toBe(true)
    expect(out()).toContain('answer y or n')
  })
})

describe('reach mode', () => {
  it.each([
    ['a', { claimUkDid: true, frontendEnabled: false }],
    ['b', { claimUkDid: false, frontendEnabled: true }],
    ['c', { claimUkDid: false, frontendEnabled: false }],
  ])('maps choice %s correctly', async (choice, expected) => {
    const { orderRaw, prefs } = await interview({ express: false, workingDir: tmp },
      scripted([['Project name', 'acme-support'], ['How will you reach the agent?', choice]]))
    expect(prefs.claimUkDid).toBe(expected.claimUkDid)
    expect(orderRaw.frontendEnabled).toBe(expected.frontendEnabled)
  })
})

describe('knowledge base', () => {
  const kbOn = (extra: Array<[string, string]> = []): Array<[string, string]> => [
    ['Project name', 'acme-support'],
    ['Knowledge base', 'y'],
    ...extra,
  ]

  it.each([['a', 'sample'], ['c', 'skip']])(
    'maps KB content choice %s to %s', async (choice, expected) => {
      const { prefs } = await interview({ express: false, workingDir: tmp },
        scripted(kbOn([['KB content', choice]])))
      expect(prefs.kbContent).toBe(expected)
    })

  it('asks for a path on choice (b) and re-prompts until it exists', async () => {
    const real = join(tmp, 'kb-data')
    mkdirSync(real)
    const prompt = scripted(kbOn([
      ['KB content', 'b'],
      ['Path to your content', join(tmp, 'typo')],
      ['Path to your content', real],
    ]))
    const { prefs } = await interview({ express: false, workingDir: tmp }, prompt)
    expect(prefs.kbContent).toBe('path')
    expect(prefs.kbContentPath).toBe(real)
    expect(out()).toContain('path not found')
  })

  it('does not ask about KB content when the knowledge base is off', async () => {
    const prompt = scripted([['Project name', 'acme-support']])
    await interview({ express: false, workingDir: tmp }, prompt)
    expect(prompt.asked.some((q) => q.includes('KB content'))).toBe(false)
  })
})

describe('prompt customization', () => {
  it('seeds prompt files into the working dir and waits before continuing', async () => {
    const prompt = scripted([
      ['Project name', 'acme-support'],
      ["Customize the AI agent's prompts", 'y'],
    ])
    await interview({ express: false, workingDir: tmp }, prompt)
    expect(existsSync(join(tmp, 'prompts', 'orchestration.md'))).toBe(true)
    expect(prompt.asked.some((q) => q.includes('Press Enter when done editing'))).toBe(true)
  })

  it('seeds nothing when declined', async () => {
    await interview({ express: false, workingDir: tmp },
      scripted([['Project name', 'acme-support']]))
    expect(existsSync(join(tmp, 'prompts'))).toBe(false)
  })
})

describe('Identity Center', () => {
  it('spells out the manual SAML step, pointing at the working dir', async () => {
    await interview({ express: false, workingDir: tmp },
      scripted([['Project name', 'acme-support'], ['Identity Center SSO', 'y']]))
    expect(out()).toContain('Manual step required BEFORE deploy')
    expect(out()).toContain(join(tmp, 'saml-metadata.xml'))
  })

  it('warns that the choice is irreversible before it is made', async () => {
    const prompt = scripted([['Project name', 'acme-support']])
    await interview({ express: false, workingDir: tmp }, prompt)
    const question = prompt.asked.find((q) => q.includes('Identity Center SSO'))
    expect(question).toContain('IRREVERSIBLE')
  })
})

describe('confirmOrder', () => {
  const prefs = { claimUkDid: true, kbContent: 'skip' as const, kbContentPath: '' }

  it.each([['', true], ['y', true], ['yes', true], ['1', true], ['n', false], ['anything', false]])(
    'reads %s as %s', async (answer, expected) => {
      expect(await confirmOrder({ projectName: 'demo' }, prefs, '123456789012',
        scripted([['Place this order?', answer]]))).toBe(expected)
    })

  it('shows the account and region being deployed to', async () => {
    await confirmOrder({ projectName: 'demo', region: 'eu-central-1' }, prefs, '123456789012',
      scripted([['Place this order?', 'y']]))
    expect(out()).toContain('123456789012')
    expect(out()).toContain('eu-central-1')
  })

  it('omits the account line when it could not be resolved', async () => {
    await confirmOrder({ projectName: 'demo' }, prefs, null,
      scripted([['Place this order?', 'y']]))
    expect(out()).not.toContain('Deploy to AWS account')
  })

  it('names the reach mode so it can be checked before deploying', async () => {
    await confirmOrder({ projectName: 'demo', frontendEnabled: true },
      { claimUkDid: false, kbContent: 'skip', kbContentPath: '' }, null,
      scripted([['Place this order?', 'y']]))
    expect(out()).toContain('Reach: web-call frontend')
  })
})
