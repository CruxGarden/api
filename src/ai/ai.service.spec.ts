import { EventEmitter } from 'events';
import type { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { AiService } from './ai.service';
import { LoggerService } from '../common/services/logger.service';
import { ArtifactService } from '../artifact/artifact.service';
import { AuthorService } from '../author/author.service';
import { CruxService } from '../crux/crux.service';

jest.mock('@anthropic-ai/sdk');

it('keeps the BYOK conversation prefix and signed thinking unchanged after file mutations', async () => {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const thinking = {
    type: 'thinking',
    thinking: '',
    signature: 'fixture-signature',
  };
  const stream = jest.fn((body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    return {
      on: jest.fn(),
      finalMessage: async () =>
        bodies.length === 1
          ? {
              stop_reason: 'tool_use',
              content: [
                thinking,
                {
                  type: 'tool_use',
                  id: 'call_1',
                  name: 'write_file',
                  input: { path: 'index.html', content: '<h1>Hello</h1>' },
                },
              ],
            }
          : {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'Done' }],
            },
    };
  });
  (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
    messages: { stream },
  }));
  const artifact = { findByResource: jest.fn().mockResolvedValue([]) };
  const service = new AiService(
    new LoggerService(),
    artifact as unknown as ArtifactService,
    {
      findById: async () => ({ username: 'fixture' }),
    } as unknown as AuthorService,
    {
      findOwnedById: async () => ({
        id: 'crux',
        authorId: 'author',
        homeId: 'home',
        slug: 'fixture',
      }),
    } as unknown as CruxService,
  );
  jest
    .spyOn(service as any, 'executeToolChain')
    .mockImplementation(async () => {
      artifact.findByResource.mockResolvedValue([
        { id: 'file', filename: 'index.html' },
      ]);
      return {
        results: [{ toolId: 'call_1', content: 'Created file: index.html' }],
        hadMutation: true,
      };
    });
  const res = Object.assign(new EventEmitter(), {
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  });
  await service.streamChat(
    'crux',
    [{ role: 'user', content: 'Create a page' }],
    'claude-sonnet-5-5',
    'author',
    res as unknown as Response,
    'fixture-key',
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[1].system).toEqual(bodies[0].system);
  expect(bodies[1].messages.slice(0, bodies[0].messages.length)).toEqual(
    bodies[0].messages,
  );
  expect(bodies[1].messages[1].content).toEqual(
    expect.arrayContaining([thinking]),
  );
  expect(bodies[1].messages[bodies[1].messages.length - 1].content).toContain(
    'index.html',
  );
  expect(
    res.write.mock.calls.some(([text]) =>
      String(text).includes('event: error'),
    ),
  ).toBe(false);
});
