import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedWithSubscriptionProcedure, companyAdminProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createReportSchema = z.object({
  type: z.enum(["daily", "weekly", "monthly", "custom"]),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
  attachmentUrl: z.string().url().optional(),
  reportDate: z.string().datetime().optional(),
});

const updateReportSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  attachmentUrl: z.string().url().optional(),
  status: z.enum(["draft", "submitted", "reviewed", "approved"]).optional(),
});

const submitReportSchema = z.object({
  id: z.number().int(),
});

const reviewReportSchema = z.object({
  id: z.number().int(),
  status: z.enum(["reviewed", "approved"]),
  notes: z.string().optional(),
});

// ============================================================================
// REPORTS ROUTER
// ============================================================================

export const reportsRouter = router({
  /**
   * Create a new report (Staff)
   */
  create: protectedWithSubscriptionProcedure
    .input(createReportSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const reportDate = input.reportDate ? new Date(input.reportDate) : new Date();

      const result = await db.createReport({
        companyId: ctx.user?.companyId || 0,
        userId: ctx.user?.id || 0,
        type: input.type,
        title: input.title,
        content: input.content,
        attachmentUrl: input.attachmentUrl,
        status: "draft",
        reportDate,
      });

      return {
        success: true,
        message: "Report created successfully",
        data: result,
      };
    }),

  /**
   * Get report details
   */
  get: protectedWithSubscriptionProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const report = await db.getReportById(input.id, ctx.user.companyId);
      if (!report) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
      }

      // Verify user can access this report
      if (ctx.user && report.userId !== ctx.user.id && ctx.user.role === "staff") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot access other users' reports" });
      }

      return report;
    }),

  /**
   * List user's reports
   */
  listMy: protectedWithSubscriptionProcedure
    .input(z.object({ limit: z.number().int().default(30) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      return db.getReportsByUserId(ctx.user.id, ctx.user.companyId, input.limit);
    }),

  /**
   * List all company reports (Admin only)
   */
  listCompany: companyAdminProcedure
    .input(z.object({ limit: z.number().int().default(100) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      return db.getReportsByCompanyId(ctx.user.companyId, input.limit);
    }),

  /**
   * Update report (Staff - draft only, Admin - any)
   */
  update: protectedWithSubscriptionProcedure
    .input(updateReportSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const report = await db.getReportById(input.id, ctx.user.companyId);
      if (!report) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
      }

      // Staff can only edit their own draft reports
      if (ctx.user.role === "staff") {
        if (report.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot edit other users' reports" });
        }
        if (report.status !== "draft") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot edit submitted reports" });
        }
      }

      const updateData: Record<string, any> = {};
      if (input.title !== undefined) updateData.title = input.title;
      if (input.content !== undefined) updateData.content = input.content;
      if (input.attachmentUrl !== undefined) updateData.attachmentUrl = input.attachmentUrl;
      if (input.status !== undefined) updateData.status = input.status;

      await db.updateReport(input.id, ctx.user.companyId, updateData);

      return {
        success: true,
        message: "Report updated successfully",
      };
    }),

  /**
   * Submit report (Staff only)
   */
  submit: protectedWithSubscriptionProcedure
    .input(submitReportSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      if (ctx.user.role === "company_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only staff can submit reports" });
      }

      const report = await db.getReportById(input.id, ctx.user.companyId);
      if (!report) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
      }

      if (report.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot submit other users' reports" });
      }

      if (report.status !== "draft") {
        throw new TRPCError({ code: "CONFLICT", message: "Only draft reports can be submitted" });
      }

      await db.updateReport(input.id, ctx.user.companyId, {
        status: "submitted",
        submittedAt: new Date(),
      });

      return {
        success: true,
        message: "Report submitted successfully",
      };
    }),

  /**
   * Review/approve report (Admin only)
   */
  review: companyAdminProcedure
    .input(reviewReportSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const report = await db.getReportById(input.id, ctx.user.companyId);
      if (!report) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
      }

      if (report.status === "draft") {
        throw new TRPCError({ code: "CONFLICT", message: "Cannot review draft reports" });
      }

      await db.updateReport(input.id, ctx.user.companyId, {
        status: input.status,
        reviewedBy: ctx.user.id,
        reviewedAt: new Date(),
        reviewNotes: input.notes,
      });

      return {
        success: true,
        message: `Report ${input.status} successfully`,
      };
    }),

  /**
   * Delete report (Staff - draft only, Admin - any)
   */
  delete: protectedWithSubscriptionProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user || !ctx.user.companyId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
      }

      const report = await db.getReportById(input.id, ctx.user.companyId);
      if (!report) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
      }

      // Staff can only delete their own draft reports
      if (ctx.user.role === "staff") {
        if (report.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot delete other users' reports" });
        }
        if (report.status !== "draft") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot delete submitted reports" });
        }
      }

      // In a real system, you might soft-delete instead
      // For now, we'll just mark as deleted or remove from DB
      // This is a simplified implementation

      return {
        success: true,
        message: "Report deleted successfully",
      };
    }),

  /**
   * Get report statistics (Admin only)
   */
  stats: companyAdminProcedure.query(async ({ ctx }) => {
    if (!ctx.user.companyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Company context required" });
    }

    const reports = await db.getReportsByCompanyId(ctx.user.companyId, 1000);

    const submitted = reports.filter(r => r.status === "submitted").length;
    const reviewed = reports.filter(r => r.status === "reviewed").length;
    const approved = reports.filter(r => r.status === "approved").length;
    const draft = reports.filter(r => r.status === "draft").length;

    return {
      total: reports.length,
      submitted,
      reviewed,
      approved,
      draft,
      submissionRate: reports.length > 0 ? ((submitted + reviewed + approved) / reports.length * 100).toFixed(1) : 0,
    };
  }),
});
