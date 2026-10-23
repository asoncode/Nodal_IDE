import { z } from 'zod';
import { RoleSchema, RolePathSchema } from './roles.js';

export const TeamMemberSchema = z.object({
  role: RoleSchema,
  provider: z.enum(['claude', 'codex']),
  model: z.string().min(1).max(200).optional(),
  permission: z.enum(['read-only', 'scoped-edit']),
}).strict();
export const TeamPlanSchema = z.object({
  name: z.string().min(1).max(200),
  summary: z.string().min(1).max(6000),
  members: z.array(TeamMemberSchema).min(2).max(20),
  areas: z.array(z.object({ path: RolePathSchema, roleId: z.string().min(1).max(200) }).strict()).max(100),
}).strict();
export type TeamPlan = z.infer<typeof TeamPlanSchema>;
export const PlanningOptionsSchema = z.object({
  stage: z.enum(['team', 'workflow']).default('workflow'),
  briefPaths: z.array(z.string().min(1).max(4096)).max(8).default([]),
  team: TeamPlanSchema.optional(),
}).strict();
export type PlanningOptions = z.infer<typeof PlanningOptionsSchema>;
