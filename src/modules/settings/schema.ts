import { z } from "zod";

// ─── Company ──────────────────────────────────────────────────────────────────

export const GetCompanySchema = z.object({});

export const UpdateCompanySchema = z.object({
  company_name: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  gst_no: z.string().optional(),
  pan_no: z.string().optional(),
  bank_details: z.string().optional(),
  logo_url: z.string().optional(),
});

// ─── Users ────────────────────────────────────────────────────────────────────

export const ListUsersSchema = z.object({});

export const CreateUserSchema = z.object({
  username: z.string().min(3).max(100),
  user_group: z.string().optional(),
  password: z.string().min(6),
});

export const ChangePasswordSchema = z
  .object({
    id: z.string().uuid(),
    new_password: z.string().min(6),
    confirm_password: z.string().min(6),
    keyword: z.string().optional(),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: "Passwords do not match",
    path: ["confirm_password"],
  });

export const DeleteUserSchema = z.object({ id: z.string().uuid() });

// ─── Form Permissions ─────────────────────────────────────────────────────────

export const GetFormPermissionsSchema = z.object({
  userId: z.string().uuid(),
});

export const SaveFormPermissionsSchema = z.object({
  userId: z.string().uuid(),
  permissions: z.array(
    z.object({
      module: z.string(),
      form_name: z.string(),
      allowed: z.boolean(),
    }),
  ),
});

// ─── Activity Permissions ─────────────────────────────────────────────────────

export const GetActivityPermissionsSchema = z.object({
  userId: z.string().uuid(),
});

export const SaveActivityPermissionsSchema = z.object({
  userId: z.string().uuid(),
  can_view: z.boolean(),
  can_edit: z.boolean(),
  can_delete: z.boolean(),
});

// ─── Backup ───────────────────────────────────────────────────────────────────

export const CreateBackupSchema = z.object({
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  modules: z.array(z.string()).default([]),
});

// ─── Print Templates ──────────────────────────────────────────────────────────

export const ListPrintTemplatesSchema = z.object({});

export const CreatePrintTemplateSchema = z.object({
  template_name: z.string().min(1),
  status: z.string().optional(),
});

export const UpdatePrintTemplateSchema = CreatePrintTemplateSchema.extend({
  id: z.string().uuid(),
});

export const DeletePrintTemplateSchema = z.object({ id: z.string().uuid() });

// ─── Inferred types ───────────────────────────────────────────────────────────

export type GetCompanyInput = z.infer<typeof GetCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
export type ListUsersInput = z.infer<typeof ListUsersSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type DeleteUserInput = z.infer<typeof DeleteUserSchema>;
export type GetFormPermissionsInput = z.infer<typeof GetFormPermissionsSchema>;
export type SaveFormPermissionsInput = z.infer<
  typeof SaveFormPermissionsSchema
>;
export type GetActivityPermissionsInput = z.infer<
  typeof GetActivityPermissionsSchema
>;
export type SaveActivityPermissionsInput = z.infer<
  typeof SaveActivityPermissionsSchema
>;
export type CreateBackupInput = z.infer<typeof CreateBackupSchema>;
export type ListPrintTemplatesInput = z.infer<typeof ListPrintTemplatesSchema>;
export type CreatePrintTemplateInput = z.infer<
  typeof CreatePrintTemplateSchema
>;
export type UpdatePrintTemplateInput = z.infer<
  typeof UpdatePrintTemplateSchema
>;
export type DeletePrintTemplateInput = z.infer<
  typeof DeletePrintTemplateSchema
>;

// ─── Tax Master ───────────────────────────────────────────────────────────────

export const ListTaxMasterSchema = z.object({
  category: z.enum(["ITEM_TAX", "HSN_SAC", "TDS_TCS"]).optional(),
});

export const CreateTaxMasterSchema = z.object({
  category: z.enum(["ITEM_TAX", "HSN_SAC", "TDS_TCS"]),
  name: z.string().min(1),
  code: z.string().optional().nullable(),
  percentage: z.string(),
});

export const UpdateTaxMasterSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().optional().nullable(),
  percentage: z.string(),
});

export const DeleteTaxMasterSchema = z.object({
  id: z.string().uuid(),
});

export type ListTaxMasterInput = z.infer<typeof ListTaxMasterSchema>;
export type CreateTaxMasterInput = z.infer<typeof CreateTaxMasterSchema>;
export type UpdateTaxMasterInput = z.infer<typeof UpdateTaxMasterSchema>;
export type DeleteTaxMasterInput = z.infer<typeof DeleteTaxMasterSchema>;

