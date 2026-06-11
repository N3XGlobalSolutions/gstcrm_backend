import { z } from "zod";

export const ListTxSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const GetByIdSchema = z.object({ id: z.string().uuid() });
export const DeleteTxSchema = z.object({ id: z.string().uuid() });

const JobWorkGoldItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(),
  quantity: z.string(),
  purity: z.string(),
  actual_purity: z.string().optional(),
});

const JobWorkOrnamentItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(),
  quantity: z.string(),
  purity: z.string(),
  stone: z.string().optional(),
  throde: z.string().optional(),
  chain: z.string().optional(),
  wastage_mode: z.enum(["PERCENT", "GRAM"]),
  wastage_value: z.string(),
});

export const CreateJobWorkSchema = z.object({
  account_id: z.string().uuid(),
  date: z.string(),
  remarks: z.string().optional(),
  gold_issue: z.array(JobWorkGoldItemSchema).default([]),
  ornament_issue: z.array(JobWorkOrnamentItemSchema).default([]),
  gold_receipt: z.array(JobWorkGoldItemSchema).default([]),
  ornament_receipt: z.array(JobWorkOrnamentItemSchema).default([]),
});

export const UpdateJobWorkSchema = CreateJobWorkSchema.extend({
  id: z.string().uuid(),
});
