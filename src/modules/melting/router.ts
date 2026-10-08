import { router, protectedProcedure } from "@/lib/trpc";
import {
  CreateMeltingSchema,
  CreateMetalSchema,
  ListMeltingSchema,
  MeltingIdSchema,
  MetalIdSchema,
  UpdateMeltingSchema,
  UpdateMetalSchema,
} from "./schema";
import {
  createMelting,
  createMetal,
  deleteMelting,
  deleteMetal,
  getMeltingById,
  getNextEntryNo,
  listMelting,
  listMetals,
  updateMelting,
  updateMetal,
} from "./service";

// Melting register — create/update/delete post (or reverse) a MELTING entry
// group that moves stock; see service.ts. Totals live on stock.getMeltingTotals.
// Gated like the Bank page: any logged-in user (protectedProcedure).
export const meltingRouter = router({
  metals: router({
    list: protectedProcedure.query(async () => listMetals()),
    create: protectedProcedure
      .input(CreateMetalSchema)
      .mutation(async ({ input }) => createMetal(input)),
    update: protectedProcedure
      .input(UpdateMetalSchema)
      .mutation(async ({ input }) => updateMetal(input)),
    delete: protectedProcedure
      .input(MetalIdSchema)
      .mutation(async ({ input }) => deleteMetal(input.id)),
  }),

  getNextEntryNo: protectedProcedure.query(async () => getNextEntryNo()),

  list: protectedProcedure
    .input(ListMeltingSchema)
    .query(async ({ input }) => listMelting(input)),

  getById: protectedProcedure
    .input(MeltingIdSchema)
    .query(async ({ input }) => getMeltingById(input.id)),

  create: protectedProcedure
    .input(CreateMeltingSchema)
    .mutation(async ({ input }) => createMelting(input)),

  update: protectedProcedure
    .input(UpdateMeltingSchema)
    .mutation(async ({ input }) => updateMelting(input)),

  delete: protectedProcedure
    .input(MeltingIdSchema)
    .mutation(async ({ input }) => deleteMelting(input.id)),
});
