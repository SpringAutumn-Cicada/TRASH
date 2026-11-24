import { z } from "zod";

export const choiceOptionId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

const option = z.object({
  id: choiceOptionId,
  label: z.string().trim().min(1).max(120),
  detail: z.string().trim().max(240).optional(),
  primary: z.boolean().optional(),
}).strict();

export const chatChoiceInput = z.object({
  operation: z.literal("request-choice"),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(600).optional(),
  details: z.array(z.object({
    label: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(500),
  }).strict()).max(8).optional(),
  options: z.array(option).min(2).max(8),
}).strict().refine(value => new Set(value.options.map(item => item.id)).size === value.options.length &&
  value.options.filter(item => item.primary).length <= 1);
