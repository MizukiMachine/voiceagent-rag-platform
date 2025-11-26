import { z } from 'zod';

export const createSessionSchema = z.object({
  agentSetKey: z.string().min(1),
  preferredAgentName: z.string().min(1).optional(),
  sessionLabel: z.string().min(1).optional(),
  memoryKey: z.string().min(1).optional(),
  memoryEnabled: z.boolean().optional(),
  clientTag: z.string().min(1).optional(),
  clientCapabilities: z
    .object({
      audio: z.boolean().optional(),
      images: z.boolean().optional(),
      outputText: z.boolean().optional(),
    })
    .optional(),
  metadata: z.record(z.any()).optional(),
  timeZone: z.string().min(1).optional(),
});

const inputTextSchema = z.object({
  kind: z.literal('input_text'),
  text: z.string().min(1),
  triggerResponse: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
});

const inputAudioSchema = z.object({
  kind: z.literal('input_audio'),
  audio: z.string().min(1),
  commit: z.boolean().optional(),
  response: z.boolean().optional(),
});

const inputImageSchema = z.object({
  kind: z.literal('input_image'),
  data: z.string().min(1),
  mimeType: z.string().min(1),
  encoding: z.literal('base64').optional(),
  text: z.string().optional(),
  triggerResponse: z.boolean().optional(),
});

const rawEventSchema = z.object({
  kind: z.literal('event'),
  event: z.record(z.any()),
});

const controlSchema = z.object({
  kind: z.literal('control'),
  action: z.enum(['interrupt', 'mute', 'push_to_talk_start', 'push_to_talk_stop']),
  value: z.any().optional(),
});

export const sessionCommandSchema = z.discriminatedUnion('kind', [
  inputTextSchema,
  inputAudioSchema,
  inputImageSchema,
  rawEventSchema,
  controlSchema,
]);

export type SessionCommandPayload = z.infer<typeof sessionCommandSchema>;
