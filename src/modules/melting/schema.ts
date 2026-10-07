import { z } from "zod";

// Melting register — RECORD ONLY (see db/schema/melting.ts). Decimals travel as
// strings like every other module; dates as YYYY-MM-DD.

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

const decimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d*(\.\d+)?$/, `${label} must be a number`);

// Optional numeric field: blank / null / undefined all mean "not entered".
const optionalDecimal = (label: string) =>
  decimalString(label).nullish().transform((v) => (v ? v : null));

// ─── Metals ──────────────────────────────────────────────────────────────────

const metalName = z.string().trim().min(1, "Metal name is required").max(100);

export const CreateMetalSchema = z.object({ name: metalName });
export type CreateMetalInput = z.infer<typeof CreateMetalSchema>;

export const UpdateMetalSchema = z.object({ id: z.string().uuid(), name: metalName });
export type UpdateMetalInput = z.infer<typeof UpdateMetalSchema>;

export const MetalIdSchema = z.object({ id: z.string().uuid() });

// ─── Melting entries ─────────────────────────────────────────────────────────

export const MeltingLineSchema = z.object({
  weight: decimalString("Weight").refine(
    (v) => Number.parseFloat(v) > 0,
    "Weight must be greater than zero",
  ),
  touch: optionalDecimal("Touch").refine(
    (v) => v === null || Number.parseFloat(v) <= 100,
    "Touch cannot exceed 100",
  ),
  wastage_percent: optionalDecimal("Wastage %"),
  // Accepted for convenience but always recomputed on the server.
  pure: optionalDecimal("Pure"),
  wastage: optionalDecimal("Wastage"),
  total_pure: optionalDecimal("Total pure"),
  quantity: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isInteger(n) || n < 0) {
        ctx.addIssue({ code: "custom", message: "Qty must be a whole number" });
        return z.NEVER;
      }
      return n;
    }),
});
export type MeltingLineInput = z.infer<typeof MeltingLineSchema>;

export const MeltingAlloySchema = z.object({
  metal_id: z.string().uuid("Select a metal"),
  share_percent: decimalString("Share %").refine(
    (v) => v !== "" && Number.parseFloat(v) > 0 && Number.parseFloat(v) <= 100,
    "Share % must be between 0 and 100",
  ),
});
export type MeltingAlloyInput = z.infer<typeof MeltingAlloySchema>;

const meltingBody = {
  date: dateSchema,
  // Legacy single metal — optional since 0022 (replaced by `alloys`). Kept for
  // back-compat; on update, omitted = keep existing, null = clear.
  metal_id: z.string().uuid("Select a metal").nullish(),
  remarks: z.string().max(1000).nullish(),
  required_touch: optionalDecimal("Required touch").refine(
    (v) => v === null || (Number.parseFloat(v) > 0 && Number.parseFloat(v) <= 100),
    "Required touch must be greater than 0 and at most 100",
  ),
  alloys: z.array(MeltingAlloySchema).optional().default([]),
  lines: z.array(MeltingLineSchema).min(1, "Add at least one line"),
};

function refineAlloys(
  v: { required_touch: string | null; alloys: MeltingAlloyInput[] },
  ctx: z.RefinementCtx,
) {
  if (v.alloys.length === 0) return;
  if (v.required_touch === null) {
    ctx.addIssue({
      code: "custom",
      path: ["required_touch"],
      message: "Required touch is needed to add alloy metals",
    });
  }
  const ids = new Set<string>();
  for (const a of v.alloys) {
    if (ids.has(a.metal_id)) {
      ctx.addIssue({ code: "custom", path: ["alloys"], message: "Each metal can be added only once" });
      return;
    }
    ids.add(a.metal_id);
  }
  // Integer hundredths so the ±0.01 tolerance is exact.
  const sum = v.alloys.reduce((s, a) => s + Math.round(Number.parseFloat(a.share_percent) * 100), 0);
  if (Math.abs(sum - 10000) > 1) {
    ctx.addIssue({ code: "custom", path: ["alloys"], message: "Metal shares must total 100%" });
  }
}

export const CreateMeltingSchema = z.object(meltingBody).superRefine(refineAlloys);
export type CreateMeltingInput = z.infer<typeof CreateMeltingSchema>;

export const UpdateMeltingSchema = z
  .object({ id: z.string().uuid(), ...meltingBody })
  .superRefine(refineAlloys);
export type UpdateMeltingInput = z.infer<typeof UpdateMeltingSchema>;

export const MeltingIdSchema = z.object({ id: z.string().uuid() });

export const ListMeltingSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  from_date: dateSchema.optional(),
  to_date: dateSchema.optional(),
  metal_id: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
});
export type ListMeltingInput = z.infer<typeof ListMeltingSchema>;
